import { prisma } from "@/lib/prisma";
import { calculatePrice, computeSheets } from "./pricing";
import { parsePageSelection } from "./page-selection";
import { ORDER_TRANSITIONS, CANCELLABLE_STATUSES } from "@/lib/constants";
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

function label(status: string): string {
  return status.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
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

export async function createOrder(input: CreateOrderInput) {
  // Load files with ownership verification (IDOR protection).
  const files = await prisma.uploadedFile.findMany({
    where: { id: { in: input.fileIds }, uploaderId: input.userId },
  });
  if (files.length !== input.fileIds.length) {
    throw new OrderError("One or more files could not be found or are not yours.", 403);
  }
  if (files.length === 0) throw new OrderError("Upload at least one document.", 400);

  // All files must be fully analyzed before ordering.
  const notAnalyzed = files.filter(
    (f) => f.analysisStatus === "PENDING" || f.analysisStatus === "PROCESSING"
  );
  if (notAnalyzed.length > 0) {
    throw new OrderError("Some documents are still being analyzed. Please wait a moment.", 409);
  }

  const needsCount = files.filter((f) => typeof f.pageCount !== "number" || f.pageCount <= 0);
  if (needsCount.length > 0) {
    throw new OrderError(
      "Page count could not be automatically determined. Please verify the document or allow an administrator to review it.",
      409
    );
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

  const orderNumber = await nextOrderNumber();

  const order = await prisma.$transaction(async (tx) => {
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
        status: "PAYMENT_PENDING",
        paymentStatus: "PAYMENT_PENDING",
        files: { connect: files.map((f) => ({ id: f.id })) },
      },
    });
    await tx.orderEvent.create({
      data: {
        orderId: o.id,
        type: "ORDER_PLACED",
        toStatus: "PAYMENT_PENDING",
        message: `Order created with ${files.length} document(s), ${totalPages} page(s).`,
        actorId: input.userId,
        actorRole: "STUDENT",
      },
    });
    return o;
  });

  await NOTIFY.orderCreated(input.userId, order.orderNumber, order.id);
  await audit({
    actorId: input.userId,
    actorRole: "STUDENT",
    action: "ORDER_CREATED",
    targetType: "ORDER",
    targetId: order.id,
    metadata: { orderNumber, total: price.total, pages: totalPages },
  });

  return order;
}

async function getPriceTableSafe() {
  const { getPriceTable } = await import("./settings");
  const table = await getPriceTable();
  if (Object.keys(table).length === 0) {
    throw new OrderError("Pricing is not configured yet. Please contact the print desk.", 503);
  }
  return table;
}

/** Human-readable sequential order number: XE-YYYY-NNNNNN */
export async function nextOrderNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `XE-${year}-`;
  const last = await prisma.order.findFirst({
    where: { orderNumber: { startsWith: prefix } },
    orderBy: { orderNumber: "desc" },
  });
  const lastNum = last ? parseInt(last.orderNumber.slice(prefix.length), 10) : 0;
  const next = (Number.isFinite(lastNum) ? lastNum : 0) + 1;
  return `${prefix}${String(next).padStart(6, "0")}`;
}

const ALLOWED_STATUS_ACTORS: Record<string, string[]> = {
  ADMIN: ["*"],
  SUPER_ADMIN: ["*"],
  STUDENT: [],
};

export function canActorChangeStatus(role: string): boolean {
  return ALLOWED_STATUS_ACTORS[role]?.includes("*") ?? false;
}

export function isTransitionAllowed(from: string, to: string): boolean {
  return (ORDER_TRANSITIONS[from] || []).includes(to);
}

export async function adminUpdateOrderStatus(params: {
  orderId: string;
  toStatus: string;
  actorId: string;
  actorRole: string;
  note?: string;
}): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: params.orderId } });
  if (!order) throw new OrderError("Order not found", 404);
  if (!canActorChangeStatus(params.actorRole)) {
    throw new OrderError("Not permitted", 403);
  }
  if (order.status === params.toStatus) return; // idempotent
  if (!isTransitionAllowed(order.status, params.toStatus)) {
    throw new OrderError(`Cannot move order from ${order.status} to ${params.toStatus}.`, 409);
  }

  const patch: Record<string, unknown> = { status: params.toStatus };
  const now = new Date();
  if (params.toStatus === "COMPLETED") patch.completedAt = now;
  if (params.toStatus === "READY_FOR_COLLECTION") {
    const { attachCollectionToken } = await import("./collection");
    await attachCollectionToken(order.id);
  }
  if (params.toStatus === "CANCELLED") {
    patch.cancelledAt = now;
    patch.cancelledBy = params.actorId;
    patch.cancelReason = params.note ?? null;
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data: patch as never });
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: "STATUS_CHANGE",
        fromStatus: order.status,
        toStatus: params.toStatus,
        message: params.note,
        actorId: params.actorId,
        actorRole: params.actorRole,
      },
    });
  });

  // Notifications
  if (params.toStatus === "READY_FOR_COLLECTION") {
    await NOTIFY.orderReady(order.userId, order.orderNumber, order.id);
  } else if (params.toStatus === "COMPLETED") {
    await NOTIFY.orderCompleted(order.userId, order.orderNumber, order.id);
  } else if (params.toStatus === "CANCELLED") {
    await NOTIFY.orderCancelled(order.userId, order.orderNumber, order.id);
  } else {
    await NOTIFY.statusUpdate(order.userId, order.orderNumber, label(params.toStatus), order.id);
  }

  await audit({
    actorId: params.actorId,
    actorRole: params.actorRole,
    action: "ORDER_STATUS_CHANGE",
    targetType: "ORDER",
    targetId: order.id,
    metadata: { from: order.status, to: params.toStatus, orderNumber: order.orderNumber },
  });
}

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
  const eligible = settings.cancellationAllowedStatuses.includes(order.status);
  const eligibleEnum = CANCELLABLE_STATUSES as readonly string[];
  const allowed = eligible || eligibleEnum.includes(order.status);
  if (!allowed) {
    throw new OrderError("This order can no longer be cancelled.", 409);
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledBy: params.userId,
        cancelReason: params.reason ?? null,
      },
    });
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: "CANCELLED",
        fromStatus: order.status,
        toStatus: "CANCELLED",
        message: params.reason,
        actorId: params.userId,
        actorRole: params.actorRole,
      },
    });
  });

  await NOTIFY.orderCancelled(order.userId, order.orderNumber, order.id);
  await audit({
    actorId: params.userId,
    actorRole: params.actorRole,
    action: "ORDER_CANCELLED",
    targetType: "ORDER",
    targetId: order.id,
    metadata: { orderNumber: order.orderNumber, reason: params.reason },
  });
}
