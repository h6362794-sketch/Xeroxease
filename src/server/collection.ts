import { createHmac, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { env } from "./env";
import { NOTIFY } from "./notifications";
import { audit } from "./audit";

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

    return { orderId: order.id, userId: order.userId, orderNumber: order.orderNumber };
  });

  if ("orderId" in outcome) {
    // Side effects only after the transaction has committed.
    await NOTIFY.orderCompleted(outcome.userId, outcome.orderNumber, outcome.orderId);
    await audit({
      actorId: actor.id,
      actorRole: actor.role,
      action: "ORDER_COLLECTED_VIA_QR",
      targetType: "ORDER",
      targetId: outcome.orderId,
      metadata: { orderNumber: outcome.orderNumber },
    });
    return { ok: true, orderId: outcome.orderId };
  }

  return collectionFailure(outcome.code);
}

export function newOpaqueToken(): string {
  return randomBytes(24).toString("base64url");
}
