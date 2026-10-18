import { createHmac, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { env } from "./env";
import { NOTIFY } from "./notifications";

/**
 * Collection QR — signed verification mechanism.
 * Token = HMAC-SHA256(secret, "display:" + orderId), single-use enforced via
 * collectionTokenUsedAt. Only the HMAC of the token is stored; the raw token is
 * derivable only by the server.
 */
export function signCollectionToken(orderId: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(`display:${orderId}`).digest("base64url");
}

export function hashCollectionToken(token: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(`collection:${token}`).digest("hex");
}

/** Attach/refresh the collection token hash for an order entering READY_FOR_COLLECTION. */
export async function attachCollectionToken(orderId: string): Promise<string> {
  const token = signCollectionToken(orderId);
  await prisma.order.update({
    where: { id: orderId },
    data: { collectionTokenHash: hashCollectionToken(token), collectionTokenUsedAt: null },
  });
  return token;
}

export type CollectionFailureCode = "INVALID" | "ALREADY_USED" | "NOT_READY";

export type CollectionResult =
  | { ok: true; orderId: string }
  | { ok: false; reason: string; code: CollectionFailureCode };

const MESSAGES: Record<CollectionFailureCode, string> = {
  INVALID: "Invalid collection code.",
  ALREADY_USED: "This collection code has already been used.",
  NOT_READY: "Order is not ready for collection.",
};

/**
 * Declared explicitly rather than left to inference.
 *
 * TypeScript normalises an *inferred* union of object literals by adding keys that
 * appear in some members as `key?: undefined` on the others. After
 * `if ("orderId" in outcome)`, that leaves `outcome.userId` as
 * `string | undefined` even though the success branch always sets it, which is a
 * type error at the call sites below. Naming the union keeps `in` narrowing exact.
 */
type ConsumeOutcome =
  | { code: CollectionFailureCode }
  | { orderId: string; userId: string; orderNumber: string };

export function collectionFailure(code: CollectionFailureCode): CollectionResult {
  return { ok: false, reason: MESSAGES[code], code };
}

/**
 * Read-only validation of a collection code. Does not mutate anything, so it is
 * safe for a "does this scan look right?" check before the desk commits.
 */
export async function verifyCollectionToken(token: string): Promise<CollectionResult> {
  const h = hashCollectionToken(token);
  const order = await prisma.order.findFirst({
    where: { collectionTokenHash: h },
    select: { id: true, status: true, collectionTokenUsedAt: true },
  });
  if (!order) return collectionFailure("INVALID");
  if (order.collectionTokenUsedAt) return collectionFailure("ALREADY_USED");
  if (order.status !== "READY_FOR_COLLECTION") return collectionFailure("NOT_READY");
  return { ok: true, orderId: order.id };
}

/**
 * Atomically consume a collection code and complete the order.
 *
 * Everything that must hold together — the single-use guard, the status
 * transition and the audit event — happens inside ONE transaction. The
 * `collectionTokenUsedAt IS NULL` predicate in the WHERE clause is what makes the
 * consumption atomic: PostgreSQL takes a row lock for the UPDATE, so of N
 * concurrent requests exactly one matches the predicate and completes the order;
 * the rest see count === 0 and are rejected as already used.
 *
 * Previously the token was read, checked, and then written back in separate
 * statements, so two simultaneous scans could both observe an unused token.
 */
export async function consumeCollectionToken(
  token: string,
  actor: { id: string; role: string }
): Promise<CollectionResult> {
  const h = hashCollectionToken(token);

  const outcome = await prisma.$transaction<ConsumeOutcome>(async (tx) => {
    const candidates = await tx.order.findMany({
      where: { collectionTokenHash: h },
      select: { id: true, status: true, collectionTokenUsedAt: true, userId: true, orderNumber: true },
      take: 2,
    });

    if (candidates.length === 0) return { code: "INVALID" as const };
    const order = candidates[0];
    if (order.collectionTokenUsedAt) return { code: "ALREADY_USED" as const };
    if (order.status !== "READY_FOR_COLLECTION") return { code: "NOT_READY" as const };

    const now = new Date();
    const { count } = await tx.order.updateMany({
      where: {
        id: order.id,
        collectionTokenHash: h,
        collectionTokenUsedAt: null,
        status: "READY_FOR_COLLECTION",
      },
      data: { collectionTokenUsedAt: now, status: "COMPLETED", completedAt: now },
    });
    if (count !== 1) return { code: "ALREADY_USED" as const };

    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: "STATUS_CHANGE",
        fromStatus: "READY_FOR_COLLECTION",
        toStatus: "COMPLETED",
        message: "Collected via QR verification.",
        actorId: actor.id,
        actorRole: actor.role,
      },
    });
    // Inside the transaction: a completion that cannot be audited is not committed.
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: "ORDER_COLLECTED_VIA_QR",
        targetType: "ORDER",
        targetId: order.id,
        metadata: { orderNumber: order.orderNumber },
      },
    });

    return { orderId: order.id, userId: order.userId, orderNumber: order.orderNumber };
  });

  if ("orderId" in outcome) {
    // Side effects only after the transaction has committed.
    await NOTIFY.orderCompleted(outcome.userId, outcome.orderNumber, outcome.orderId);
    return { ok: true, orderId: outcome.orderId };
  }

  return collectionFailure(outcome.code);
}

export function newOpaqueToken(): string {
  return randomBytes(24).toString("base64url");
}

// ---------------------------------------------------------------------------------------------
// Lost collection code: Super Admin override.
//
// Used only when a student cannot show their code (for example, they cannot sign in to reveal it)
// and staff have confirmed the student's identity in person. Rules, all enforced here and not only
// in the route:
//   * SUPER_ADMIN only, and the order must be READY_FOR_COLLECTION with its code unused;
//   * a reason of at least 20 characters, and an explicit "identity checked in person" confirmation;
//   * the desk retypes the order number, so the wrong order cannot be completed by mistake;
//   * the code is burned in the same conditional write, so it cannot be used afterwards;
//   * the reason goes to the audit log only (the student timeline shows a generic message), and the
//     audit row is written in the same transaction: no audit entry, no override.
// ---------------------------------------------------------------------------------------------

export class CollectionOverrideError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const OVERRIDE_REASON_MIN = 20;
export const OVERRIDE_REASON_MAX = 500;
export const OVERRIDE_GENERIC_MESSAGE = "Completed by Super Admin override (collection code not presented).";

export interface LostCodeOverrideInput {
  actor: { id: string; role: string };
  /** The order number the desk entered (order numbers are unique). */
  orderNumber: string;
  /** The same order number, typed a second time. Must match `orderNumber`. */
  confirmOrderNumber: string;
  /** Free text, required. Stored in the audit log only. */
  reason: string;
  /** Must be true: the student's identity was checked in person. */
  identityChecked: boolean;
  now?: Date;
}

export async function overrideLostCollectionCode(
  input: LostCodeOverrideInput
): Promise<{ orderId: string; orderNumber: string }> {
  if (input.actor.role !== "SUPER_ADMIN") {
    throw new CollectionOverrideError("Only a Super Admin can complete an order without its collection code.", 403);
  }
  if (input.identityChecked !== true) {
    throw new CollectionOverrideError("Confirm that you checked the student's identity in person.", 400);
  }
  const orderNumber = input.orderNumber.trim();
  if (!orderNumber || orderNumber !== input.confirmOrderNumber.trim()) {
    throw new CollectionOverrideError("The order number does not match the order. Nothing was changed.", 400);
  }
  const reason = input.reason.trim();
  if (reason.length < OVERRIDE_REASON_MIN || reason.length > OVERRIDE_REASON_MAX) {
    throw new CollectionOverrideError(
      `Give a reason of ${OVERRIDE_REASON_MIN} to ${OVERRIDE_REASON_MAX} characters.`,
      400
    );
  }

  const now = input.now ?? new Date();
  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { orderNumber },
      select: { id: true, status: true, orderNumber: true, userId: true, collectionTokenUsedAt: true },
    });
    if (!order) throw new CollectionOverrideError("Order not found.", 404);
    if (order.status !== "READY_FOR_COLLECTION") {
      throw new CollectionOverrideError("Only an order that is ready for collection can be completed this way.", 409);
    }

    // Conditional on the state that was just checked, including the unused code. Of two desks
    // racing (one override, one code scan) exactly one matches.
    const { count } = await tx.order.updateMany({
      where: { id: order.id, status: "READY_FOR_COLLECTION", collectionTokenUsedAt: null },
      data: { status: "COMPLETED", completedAt: now, collectionTokenUsedAt: now },
    });
    if (count !== 1) {
      throw new CollectionOverrideError("This order was already collected or changed. Refresh and check it.", 409);
    }

    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: "STATUS_CHANGE",
        fromStatus: "READY_FOR_COLLECTION",
        toStatus: "COMPLETED",
        message: OVERRIDE_GENERIC_MESSAGE,
        actorId: input.actor.id,
        actorRole: input.actor.role,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "COLLECTION_OVERRIDE",
        targetType: "ORDER",
        targetId: order.id,
        metadata: {
          orderNumber: order.orderNumber,
          reason,
          identityChecked: true,
          collectionCodeBurned: true,
        },
      },
    });

    return { orderId: order.id, orderNumber: order.orderNumber, userId: order.userId };
  });

  // Notify only after the transaction has committed.
  await NOTIFY.orderCompleted(result.userId, result.orderNumber, result.orderId);
  return { orderId: result.orderId, orderNumber: result.orderNumber };
}
