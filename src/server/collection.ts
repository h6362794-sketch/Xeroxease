import { createHmac, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { env } from "./env";

/**
 * Collection QR — signed verification mechanism (per spec: secure random token OR signed mechanism).
 * Token = HMAC-SHA256(secret, "display:" + orderId), single-use enforced via collectionTokenUsedAt.
 * Only the HMAC of the token is stored; the raw token is derivable only by the server.
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

/** Returns order id if the token is valid and unused; marks it used when consume=true. */
export async function verifyCollectionToken(
  token: string,
  consume: boolean
): Promise<{ ok: boolean; orderId?: string; reason?: string }> {
  const h = hashCollectionToken(token);
  const order = await prisma.order.findFirst({
    where: { collectionTokenHash: h },
  });
  if (!order) return { ok: false, reason: "Invalid collection code" };
  if (order.collectionTokenUsedAt) return { ok: false, reason: "This collection code has already been used" };
  if (order.status !== "READY_FOR_COLLECTION") return { ok: false, reason: "Order is not ready for collection" };
  if (consume) {
    await prisma.order.update({
      where: { id: order.id },
      data: { collectionTokenUsedAt: new Date() },
    });
  }
  return { ok: true, orderId: order.id };
}

export function newOpaqueToken(): string {
  return randomBytes(24).toString("base64url");
}
