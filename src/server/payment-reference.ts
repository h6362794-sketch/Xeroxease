// Payment references (UPI transaction ids / bank references) identify one payment and
// therefore one order. They are normalised before storage so that "utr 1234" and
// "UTR1234" cannot be used to present the same payment twice, and the database enforces
// that a normalised reference belongs to at most one order (unique index on
// orders.payment_ref).

/** Strip whitespace and upper-case. Safe to apply to any user-entered reference. */
export function normalizePaymentReference(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/** Letters, digits and the separators banks use (- _ / .). Length is checked after normalising. */
const REFERENCE_SHAPE = /^[A-Z0-9][A-Z0-9_\-/.]{3,63}$/;

export function isValidPaymentReference(normalized: string): boolean {
  return REFERENCE_SHAPE.test(normalized);
}

/** Prisma unique-constraint violation on the payment reference column. */
export function isPaymentReferenceConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== "P2002") return false;
  const target = e.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : target ? [String(target)] : [];
  // Prisma reports the field (paymentRef / payment_ref) or, for some adapters, the index name.
  return fields.some((f) => f === "payment_ref" || f === "paymentRef" || f === "orders_payment_ref_key");
}

export const DUPLICATE_REFERENCE_MESSAGE =
  "This payment reference has already been submitted for another order. Check the reference from your payment app.";
