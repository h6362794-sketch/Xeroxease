// Pure order-status state machine.
//
// Kept free of any Prisma / database import on purpose: it encodes business rules
// that must be unit-testable in isolation (and were previously only reachable
// through `@/server/orders`, which drags in the database client and made the
// `tests/order-rules.test.ts` suite fail on a checkout where Prisma Client had
// not been generated yet).

import { ORDER_TRANSITIONS } from "./constants";

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
