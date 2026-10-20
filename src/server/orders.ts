import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { calculatePrice } from "./pricing";
import { parsePageSelection } from "./page-selection";
import {
  allowedNextStatuses,
  canActorChangeStatus,
  isStudentCancellable,
  isTransitionAllowed,
  requiresConfirmation,
  requiresReason,
  statusLabel,
} from "@/lib/order-status";

export { canActorChangeStatus, isTransitionAllowed, allowedNextStatuses };
import { audit } from "./audit";
import { notify, NOTIFY } from "./notifications";

export interface CreateOrderInput {
  userId: string;
  fileIds: string[];
  paperSize: "A4" | "LEGAL";
  colorMode: "BW" | "COLOR";
  sides: "SINGLE" | "DOUBLE";
  copies: number;
  pageSelection: "ALL" | "CUSTOM";
  customPages?: string;
  finishing: string[];
}

export class OrderError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Aggregate server-verified page counts from order files. */
function aggregatePages(
  files: { pageCount: number | null; analysisStatus: string }[],
  selection: "ALL" | "CUSTOM",
  customPages?: string
): { totalPages: number; perFileOk: boolean } {
  let total = 0;
  let allOk = true;
  for (const f of files) {
    if (f.analysisStatus === "COMPLETED" && typeof f.pageCount === "number") {
      if (selection === "CUSTOM" && customPages) {
        const r = parsePageSelection(customPages, f.pageCount);
        if (r.error) {
          // custom range applies per file; skip invalid for aggregation
          total += f.pageCount;
        } else {
          total += r.pages.length;
        }
      } else {
        total += f.pageCount;
      }
    } else {
      allOk = false;
    }
  }
  return { totalPages: total, perFileOk: allOk };
}

interface OrderableFile {
  id: string;
  pageCount: number | null;
  analysisStatus: string;
  orderId: string | null;
  /** Upload lifecycle state — `COMPLETED` means the stored bytes were verified. */
  status: string;
}

export async function createOrder(input: CreateOrderInput) {
  // Load files with ownership verification (IDOR protection). The status is *not*
  // filtered in SQL on purpose: an unverified document must produce a different, more
  // useful error than a foreign one, and both checks below run before any pricing or
  // write. Nothing is orderable unless this list is fully owned **and** verified.
  const files = (await prisma.uploadedFile.findMany({
    where: { id: { in: input.fileIds }, uploaderId: input.userId },
    select: { id: true, uploaderId: true, pageCount: true, analysisStatus: true, orderId: true, status: true },
  })) as OrderableFile[];
  if (files.length !== new Set(input.fileIds).size) {
    throw new OrderError("One or more files could not be found or are not yours.", 403);
  }
  if (files.length === 0) throw new OrderError("Upload at least one document.", 400);

  // Only a *verified* document may be printed. With direct-to-storage uploads the row
  // is created before the bytes exist, so `status` — not `analysisStatus` — is the
  // proof that an object was measured at the expected key and passed its signature
  // check. PENDING (bytes never arrived or were never checked) and FAILED (rejected or
  // abandoned) are refused here, before the order, an event or a price exists.
  const unverified = files.filter((f) => f.status !== "COMPLETED");
  if (unverified.length > 0) {
    throw new OrderError(
      "One or more documents have not finished uploading and verifying. Please wait for them to complete.",
      409
    );
  }

  // All files must be fully analyzed before ordering.
  const notAnalyzed = files.filter(
    (f) => f.analysisStatus === "PENDING" || f.analysisStatus === "PROCESSING"
  );
  if (notAnalyzed.length > 0) {
    throw new OrderError("Some documents are still being analyzed. Please wait a moment.", 409);
  }

  // A document whose count is only an estimate must never be priced as verified.
  // Previously a NEEDS_REVIEW file that happened to carry a pageCount slipped past
  // this point and failed later with a misleading "No printable pages found".
  const needsReview = files.filter(
    (f) => f.analysisStatus === "NEEDS_REVIEW" || f.analysisStatus === "FAILED"
  );
  if (needsReview.length > 0) {
    throw new OrderError(
      "The page count for some documents could not be verified. Please confirm each page count, or ask the print desk to verify them.",
      409
    );
  }

  const needsCount = files.filter((f) => typeof f.pageCount !== "number" || f.pageCount <= 0);
  if (needsCount.length > 0) {
    throw new OrderError(
      "Page count could not be automatically determined. Please verify the document or allow an administrator to review it.",
      409
    );
  }

  // Files must not already belong to an order (prevents double-ordering one document).
  const alreadyOrdered = files.filter((f) => f.orderId);
  if (alreadyOrdered.length > 0) {
    throw new OrderError("One or more documents are already attached to an order.", 409);
  }

  // Custom page selection must be valid against every file's verified count.
  if (input.pageSelection === "CUSTOM") {
    if (!input.customPages?.trim()) {
      throw new OrderError("Custom page selection is required.", 400);
    }
    for (const f of files) {
      const r = parsePageSelection(input.customPages, f.pageCount as number);
      if (r.error) throw new OrderError(`Invalid page selection: ${r.error}`, 400);
    }
  }

  const { totalPages } = aggregatePages(files, input.pageSelection, input.customPages);
  if (totalPages <= 0) throw new OrderError("No printable pages found.", 400);

  // Server-side pricing — the client never sets the price.
  const table = await getPriceTableSafe();
  const price = calculatePrice(
    {
      paperSize: input.paperSize,
      colorMode: input.colorMode,
      sides: input.sides,
      copies: input.copies,
      totalPages,
      finishing: input.finishing,
      pageSelection: input.pageSelection,
    },
    table
  );

  const order = await createOrderRow({ input, files, totalPages, price, table });

  await NOTIFY.orderCreated(input.userId, order.orderNumber, order.id);
  await audit({
    actorId: input.userId,
    actorRole: "STUDENT",
    action: "ORDER_CREATED",
    targetType: "ORDER",
    targetId: order.id,
    metadata: { orderNumber: order.orderNumber, total: price.total, pages: totalPages },
  });

  return order;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

const ORDER_NUMBER_ATTEMPTS = 5;

/**
 * The order number is allocated INSIDE the transaction. Generating it beforehand
 * left a window where two concurrent checkouts read the same "last" number and one
 * of them failed on the unique index. On a genuine collision we retry with a fresh
 * number instead of surfacing a 500.
 */
async function createOrderRow(params: {
  input: CreateOrderInput;
  files: OrderableFile[];
  totalPages: number;
  price: { billablePages: number; pricePerPage: number; finishingFee: number; total: number; printCost: number };
  table: Record<string, number>;
}) {
  const { input, files, totalPages, price, table } = params;
  let lastErr: unknown;

  // Immutable snapshot of the price list and the exact calculation. A later
  // price-list edit must never alter this order's agreed amount.
  const pricingSnapshot = {
    version: 1,
    currency: "INR",
    capturedAt: new Date().toISOString(),
    priceTable: { ...table },
    applied: {
      paperSize: input.paperSize,
      colorMode: input.colorMode,
      sides: input.sides,
      copies: input.copies,
      pageSelection: input.pageSelection,
      customPages: input.pageSelection === "CUSTOM" ? input.customPages ?? null : null,
      totalPages,
      billablePages: price.billablePages,
      pricePerPage: price.pricePerPage,
      printCost: price.printCost,
      finishing: [...input.finishing],
      finishingFee: price.finishingFee,
      total: price.total,
    },
  };

  for (let attempt = 0; attempt < ORDER_NUMBER_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const orderNumber = await nextOrderNumber(tx);
        const o = await tx.order.create({
          data: {
            orderNumber,
            userId: input.userId,
            paperSize: input.paperSize,
            colorMode: input.colorMode,
            sides: input.sides,
            copies: input.copies,
            pageSelection: input.pageSelection,
            customPages: input.pageSelection === "CUSTOM" ? input.customPages : null,
            totalPages,
            billablePages: price.billablePages,
            pricePerPage: price.pricePerPage,
            finishingFee: price.finishingFee,
            totalAmount: price.total,
            finishingOptions: input.finishing,
            pricingSnapshot,
            status: "ORDER_RECEIVED",
            paymentStatus: "PAYMENT_PENDING",
            files: { connect: files.map((f) => ({ id: f.id })) },
          },
        });
        await tx.orderEvent.create({
          data: {
            orderId: o.id,
            type: "ORDER_RECEIVED",
            toStatus: "ORDER_RECEIVED",
            message: `Order received with ${files.length} document(s), ${totalPages} page(s). Payment options unlock once the print desk accepts it.`,
            actorId: input.userId,
            actorRole: "STUDENT",
          },
        });
        return o;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      lastErr = err;
    }
  }

  console.error("[orders] exhausted order-number attempts", lastErr);
  throw new OrderError("Could not allocate an order number. Please try again.", 503);
}

async function getPriceTableSafe() {
  const { getPriceTable } = await import("./settings");
  const table = await getPriceTable();
  if (Object.keys(table).length === 0) {
    throw new OrderError("Pricing is not configured yet. Please contact the print desk.", 503);
  }
  return table;
}

/**
 * Minimal transaction-client surface required to allocate an order number.
 *
 * Derived from the generated Prisma client rather than hand-written. A structural
 * type such as `{ findFirst: (args: { where: unknown }) => ... }` does NOT accept
 * the real client: Prisma's `findFirst` is generic over a narrow argument type, and
 * because function parameters are contravariant, a delegate accepting only
 * `OrderFindFirstArgs` is not assignable to one that must accept `unknown`. That
 * mismatch is invisible with a permissive stub client but fails against the real
 * generated types (see CI job "Typecheck, lint, test and build").
 */
type OrderNumberClient = Pick<Prisma.TransactionClient, "order">;

/**
 * Human-readable sequential order number: XE-YYYY-NNNNNN.
 * Pass the transaction client so the number is reserved inside the creating
 * transaction rather than raced against it.
 */
export async function nextOrderNumber(tx: OrderNumberClient = prisma): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `XE-${year}-`;
  const last = await tx.order.findFirst({
    where: { orderNumber: { startsWith: prefix } },
    orderBy: { orderNumber: "desc" },
  });
  const lastNum = last ? parseInt(last.orderNumber.slice(prefix.length), 10) : 0;
  const next = (Number.isFinite(lastNum) ? lastNum : 0) + 1;
  return `${prefix}${String(next).padStart(6, "0")}`;
}


/**
 * Apply an administrator status transition.
 *
 * Everything is validated here, server-side, from the authoritative transition
 * table: role, known target, legal edge, required reason for rejection and an
 * explicit confirmation for delivery. The write is a *conditional* `updateMany`
 * on the status that was read, so a concurrent cancellation/acceptance cannot be
 * overwritten (the loser gets a 409 and no event is written).
 */
export async function adminUpdateOrderStatus(params: {
  orderId: string;
  toStatus: string;
  actorId: string;
  actorRole: string;
  note?: string;
  /** Must be true for irreversible outcomes (DELIVERED / REJECTED). */
  confirm?: boolean;
}): Promise<{ fromStatus: string; toStatus: string }> {
  const order = await prisma.order.findUnique({ where: { id: params.orderId } });
  if (!order) throw new OrderError("Order not found", 404);
  if (!canActorChangeStatus(params.actorRole)) {
    throw new OrderError("Not permitted", 403);
  }
  if (order.status === params.toStatus) {
    // Repeated transitions are refused rather than silently reported as success:
    // that previously produced a second "completed" notification and hid a stale UI.
    throw new OrderError(`This order is already ${statusLabel(order.status)}.`, 409);
  }
  if (!isTransitionAllowed(order.status, params.toStatus)) {
    throw new OrderError(
      `Cannot move an order from ${statusLabel(order.status)} to ${statusLabel(params.toStatus)}.`,
      409
    );
  }
  if (requiresConfirmation(params.toStatus) && params.confirm !== true) {
    throw new OrderError(
      params.toStatus === "DELIVERED"
        ? "Please confirm that the documents were handed to the student before marking the order delivered."
        : "Please confirm that you want to reject this order.",
      422
    );
  }
  const note = params.note?.trim() ?? "";
  if (requiresReason(params.toStatus) && note.length < 3) {
    throw new OrderError("A reason is required when rejecting an order.", 422);
  }

  const patch: Record<string, unknown> = { status: params.toStatus };
  const now = new Date();
  if (params.toStatus === "ACCEPTED") {
    patch.acceptedAt = now;
    patch.acceptedBy = params.actorId;
  }
  if (params.toStatus === "DELIVERED") {
    patch.deliveredAt = now;
    // `completedAt` remains for legacy reports/analytics that already read it.
    patch.completedAt = now;
  }
  if (params.toStatus === "COMPLETED") patch.completedAt = now;
  if (params.toStatus === "REJECTED") {
    patch.rejectedAt = now;
    patch.rejectedBy = params.actorId;
    patch.rejectionReason = note;
  }
  if (params.toStatus === "CANCELLED") {
    patch.cancelledAt = now;
    patch.cancelledBy = params.actorId;
    patch.cancelReason = note || null;
  }
  if (params.toStatus === "READY_FOR_PICKUP" || params.toStatus === "READY_FOR_COLLECTION") {
    // Attach the collection token inside the same transaction as the status change:
    // a partially applied update used to leave a live collection code on an order
    // that never actually reached the ready state.
    const { signCollectionToken, hashCollectionToken } = await import("./collection");
    const token = signCollectionToken(order.id);
    patch.collectionTokenHash = hashCollectionToken(token);
    patch.collectionTokenUsedAt = null;
  }

  const applied = await prisma.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: { id: order.id, status: order.status as never },
      data: patch as never,
    });
    if (updated.count !== 1) return false;

    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: "STATUS_CHANGE",
        fromStatus: order.status,
        toStatus: params.toStatus,
        message: note || null,
        actorId: params.actorId,
        actorRole: params.actorRole,
      },
    });
    return true;
  });

  if (!applied) {
    throw new OrderError(
      "This order was updated by someone else at the same time. Refresh the page and try again.",
      409
    );
  }

  // Notifications (in-app only; no external messaging service)
  if (params.toStatus === "READY_FOR_PICKUP" || params.toStatus === "READY_FOR_COLLECTION") {
    await NOTIFY.orderReady(order.userId, order.orderNumber, order.id);
  } else if (params.toStatus === "DELIVERED" || params.toStatus === "COMPLETED") {
    await NOTIFY.orderCompleted(order.userId, order.orderNumber, order.id);
  } else if (params.toStatus === "CANCELLED") {
    await NOTIFY.orderCancelled(order.userId, order.orderNumber, order.id);
  } else if (params.toStatus === "REJECTED") {
    await NOTIFY.orderRejected(order.userId, order.orderNumber, note, order.id);
  } else if (params.toStatus === "ACCEPTED") {
    await NOTIFY.orderAccepted(order.userId, order.orderNumber, order.id);
  } else {
    await NOTIFY.statusUpdate(order.userId, order.orderNumber, statusLabel(params.toStatus), order.id);
  }

  await audit({
    actorId: params.actorId,
    actorRole: params.actorRole,
    action: "ORDER_STATUS_CHANGE",
    targetType: "ORDER",
    targetId: order.id,
    metadata: { from: order.status, to: params.toStatus, orderNumber: order.orderNumber, note },
  });

  return { fromStatus: order.status, toStatus: params.toStatus };
}

/**
 * Student cancellation.
 *
 * Eligible only before acceptance. The conditional update re-checks the status
 * in the same statement that writes CANCELLED, so a simultaneous acceptance
 * cannot be raced into an inconsistent "accepted + cancelled" order: whichever
 * request loses sees zero updated rows and receives a 409.
 */
export async function cancelOrder(params: {
  orderId: string;
  userId: string;
  reason?: string;
  actorRole: string;
}): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: params.orderId } });
  if (!order) throw new OrderError("Order not found", 404);
  // Ownership check (IDOR)
  if (order.userId !== params.userId) throw new OrderError("Not permitted", 403);

  const { getSettings } = await import("./settings");
  const settings = await getSettings();
  if (!isStudentCancellable(order.status, settings.cancellationAllowedStatuses)) {
    throw new OrderError(
      order.status === "ORDER_RECEIVED"
        ? "This order can no longer be cancelled."
        : "This order has been accepted and can no longer be cancelled online.",
      409
    );
  }

  const reason = params.reason?.trim() || null;
  const applied = await prisma.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: { id: order.id, userId: params.userId, status: order.status as never },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledBy: params.userId,
        cancelReason: reason,
      } as never,
    });
    if (updated.count !== 1) return false;

    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: "CANCELLED",
        fromStatus: order.status,
        toStatus: "CANCELLED",
        message: reason,
        actorId: params.userId,
        actorRole: params.actorRole,
      },
    });
    return true;
  });

  if (!applied) {
    throw new OrderError(
      "This order has been accepted and can no longer be cancelled online. Refresh the page for its latest status.",
      409
    );
  }

  await NOTIFY.orderCancelled(order.userId, order.orderNumber, order.id);
  await audit({
    actorId: params.userId,
    actorRole: params.actorRole,
    action: "ORDER_CANCELLED",
    targetType: "ORDER",
    targetId: order.id,
    metadata: { orderNumber: order.orderNumber, reason },
  });
}
