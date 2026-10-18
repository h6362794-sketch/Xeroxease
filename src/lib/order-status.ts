// Pure order-status state machine.
//
// Kept free of any Prisma / database import on purpose: it encodes business rules
// that must be unit-testable in isolation (and were previously only reachable
// through `@/server/orders`, which drags in the database client and made the
// `tests/order-rules.test.ts` suite fail on a checkout where Prisma Client had
// not been generated yet).

import { CANCELLABLE_STATUSES, ORDER_TRANSITIONS } from "./constants";

/** Actors allowed to move orders between states. Students may never do so. */
const ALLOWED_STATUS_ACTORS: Record<string, string[]> = {
  ADMIN: ["*"],
  SUPER_ADMIN: ["*"],
  STUDENT: [],
};

export function canActorChangeStatus(role: string): boolean {
  return ALLOWED_STATUS_ACTORS[role]?.includes("*") ?? false;
}

/** Unknown source states never allow a transition (no implicit wildcard). */
export function isTransitionAllowed(from: string, to: string): boolean {
  return (ORDER_TRANSITIONS[from] || []).includes(to);
}

/**
 * Order states in which a student may submit (or resubmit) a payment reference.
 *
 * This is the state-transition guard for the payment submission route. A submission moves
 * the order to PAYMENT_UNDER_REVIEW, which is only a legal move from these states. Anything
 * later (printing, collection) or terminal (cancelled, failed, completed) must refuse, even
 * if the payment fields look rejected or pending.
 */
export const PAYMENT_SUBMISSION_STATES = ["ORDER_PLACED", "PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW"] as const;

export function isPaymentSubmissionState(status: string): boolean {
  return (PAYMENT_SUBMISSION_STATES as readonly string[]).includes(status);
}

/**
 * Statuses the admin status control may offer next. COMPLETED is excluded on purpose: an
 * order is completed only by handing it over with its collection code (see
 * src/server/collection.ts), never by a plain status change.
 */
export function adminNextStatusOptions(from: string): string[] {
  return (ORDER_TRANSITIONS[from] || []).filter((to) => to !== "COMPLETED");
}

/**
 * Order states that may take a document through the direct-upload path (`orderId` on an intent,
 * and the attach re-check at completion). Only the two states before payment is submitted. Any
 * other state, terminal or past payment, refuses the document: a document added later changes the
 * page count, and so the price, of an order the desk has already moved on.
 */
export const DOCUMENT_ATTACH_STATES = ["ORDER_PLACED", "PAYMENT_PENDING"] as const;

export function canAttachDocumentsIn(status: string): boolean {
  return (DOCUMENT_ATTACH_STATES as readonly string[]).includes(status);
}

/**
 * Statuses from which a student may cancel, given the Super Admin's configured list.
 *
 * The configured list can only NARROW the built-in cancellable set; it can never widen it.
 * Each status must also be a legal transition to CANCELLED in the state machine, so a setting
 * cannot make a completed, failed or already-printing order cancellable.
 */
export function studentCancellableStatuses(configured: readonly string[]): string[] {
  return configured.filter((s) => (CANCELLABLE_STATUSES as readonly string[]).includes(s) && isTransitionAllowed(s, "CANCELLED"));
}

export function canStudentCancelIn(status: string, configured: readonly string[]): boolean {
  return studentCancellableStatuses(configured).includes(status);
}
