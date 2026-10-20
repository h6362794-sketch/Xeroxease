// Payment rules — pure and independently testable.
//
// Invariants encoded here:
//   * Payment controls exist only after an administrator accepts the order.
//   * Choosing Cash does NOT mark anything paid.
//   * Submitting a UPI reference is a *claim*, never proof: it moves the payment
//     to UNDER_REVIEW, never to CONFIRMED.
//   * Only an admin can confirm receipt; verification requires the money to be
//     checkable (UPI reference present, or a cash collection in progress).
//   * Duplicate/conflicting decisions are rejected by comparing the current
//     payment state before any write.

import { PAYMENT_ELIGIBLE_ORDER_STATUSES, isPaymentEligibleOrderStatus } from "./order-status";

export const PAYMENT_METHODS = ["CASH_ON_DELIVERY", "UPI"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
}

/** Statuses in which a student may pick a method or submit/edit a reference. */
const STUDENT_ACTIONABLE_PAYMENT_STATUSES = [
  "PAYMENT_PENDING",
  "PAYMENT_REJECTED",
  "PAYMENT_FAILED",
] as const;

/** Statuses an administrator may verify (money received). */
const VERIFIABLE_PAYMENT_STATUSES = [
  "PAYMENT_PENDING",
  "PAYMENT_PROOF_SUBMITTED",
  "PAYMENT_UNDER_REVIEW",
] as const;

/** Statuses an administrator may reject. */
const REJECTABLE_PAYMENT_STATUSES = [
  "PAYMENT_PROOF_SUBMITTED",
  "PAYMENT_UNDER_REVIEW",
] as const;

export function canStudentSelectPaymentMethod(input: {
  orderStatus: string;
  paymentStatus: string;
}): boolean {
  if (!isPaymentEligibleOrderStatus(input.orderStatus)) return false;
  if (input.paymentStatus === "PAYMENT_CONFIRMED") return false;
  return true;
}

/**
 * Selecting a method is allowed while the order is accepted and money is not yet
 * confirmed. Changing UPI -> Cash after a reference was submitted is refused:
 * the submitted claim must be verified or rejected first, so the audit trail
 * cannot be rewritten by the student.
 */
export function canChangePaymentMethod(input: {
  orderStatus: string;
  paymentStatus: string;
  currentMethod: string | null;
  nextMethod: string;
}): { ok: true } | { ok: false; status: number; message: string } {
  if (!canStudentSelectPaymentMethod(input)) {
    return {
      ok: false,
      status: 409,
      message: isPaymentEligibleOrderStatus(input.orderStatus)
        ? "Payment for this order is already confirmed."
        : "Payment options become available once the print desk accepts your order.",
    };
  }
  if (input.currentMethod === input.nextMethod) {
    return { ok: false, status: 409, message: "This payment method is already selected." };
  }
  if (
    ["PAYMENT_UNDER_REVIEW", "PAYMENT_PROOF_SUBMITTED"].includes(input.paymentStatus) &&
    input.currentMethod === "UPI"
  ) {
    return {
      ok: false,
      status: 409,
      message: "A payment reference is already under verification. Please wait for the print desk to review it.",
    };
  }
  return { ok: true };
}

export function canStudentSubmitUpiReference(input: {
  orderStatus: string;
  paymentStatus: string;
  paymentMethod: string | null;
}): { ok: true } | { ok: false; status: number; message: string } {
  if (!isPaymentEligibleOrderStatus(input.orderStatus)) {
    return { ok: false, status: 409, message: "Payment options become available once the print desk accepts your order." };
  }
  if (input.paymentMethod !== "UPI") {
    return { ok: false, status: 409, message: "Select UPI as the payment method before submitting a reference." };
  }
  if (input.paymentStatus === "PAYMENT_CONFIRMED") {
    return { ok: false, status: 409, message: "Payment for this order is already confirmed." };
  }
  if (input.paymentStatus === "PAYMENT_UNDER_REVIEW" || input.paymentStatus === "PAYMENT_PROOF_SUBMITTED") {
    return { ok: false, status: 409, message: "A payment reference is already under verification." };
  }
  if (!(STUDENT_ACTIONABLE_PAYMENT_STATUSES as readonly string[]).includes(input.paymentStatus)) {
    return { ok: false, status: 409, message: "Payment cannot be submitted in the current state." };
  }
  return { ok: true };
}

export function canAdminVerifyPayment(input: {
  orderStatus: string;
  paymentStatus: string;
  paymentMethod: string | null;
  paymentRef: string | null;
}): { ok: true } | { ok: false; status: number; message: string } {
  // DELIVERED is included: cash is collected at pickup, and the desk may confirm
  // the money after handing the documents over. Cancelled/rejected orders cannot
  // receive a payment confirmation.
  const verifiableOrderStages: readonly string[] = [...PAYMENT_ELIGIBLE_ORDER_STATUSES, "DELIVERED"];
  if (!verifiableOrderStages.includes(input.orderStatus)) {
    return { ok: false, status: 409, message: "Payment can only be confirmed for an accepted order." };
  }
  if (input.paymentStatus === "PAYMENT_CONFIRMED") {
    return { ok: false, status: 409, message: "Payment for this order is already confirmed." };
  }
  if (!(VERIFIABLE_PAYMENT_STATUSES as readonly string[]).includes(input.paymentStatus)) {
    return { ok: false, status: 409, message: "Payment is not in a verifiable state." };
  }
  if (!input.paymentMethod) {
    return { ok: false, status: 409, message: "The student has not selected a payment method yet." };
  }
  if (input.paymentMethod === "UPI" && !input.paymentRef) {
    return {
      ok: false,
      status: 409,
      message: "No UPI reference has been submitted. Verify the reference before confirming payment.",
    };
  }
  return { ok: true };
}

export function canAdminRejectPayment(input: {
  paymentStatus: string;
  reason: string;
}): { ok: true } | { ok: false; status: number; message: string } {
  if (!(REJECTABLE_PAYMENT_STATUSES as readonly string[]).includes(input.paymentStatus)) {
    return { ok: false, status: 409, message: "Payment is not in a rejectable state." };
  }
  if (input.reason.trim().length < 3) {
    return { ok: false, status: 422, message: "A rejection reason is required." };
  }
  return { ok: true };
}

/**
 * Normalise a student-submitted UPI reference.
 *
 * UPI references are alphanumeric with optional dash/underscore; length is
 * bounded (4–64) and unsafe markup/control characters are rejected rather than
 * silently stripped. The result is stored as plain text and rendered as text by
 * React, so it can never become markup.
 */
export function normalizeUpiReference(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "Enter the transaction reference." };
  const value = raw.trim().toUpperCase();
  if (value.length < 4) return { ok: false, message: "Reference is too short (minimum 4 characters)." };
  if (value.length > 64) return { ok: false, message: "Reference is too long (maximum 64 characters)." };
  if (!/^[A-Z0-9][A-Z0-9._/-]{3,63}$/.test(value)) {
    return { ok: false, message: "Reference may only contain letters, numbers, dot, dash, slash and underscore." };
  }
  return { ok: true, value };
}

/** Display a reference without leaking the full value in student-facing text. */
export function maskReference(reference: string | null | undefined): string {
  if (!reference) return "—";
  const visible = reference.slice(-4);
  return `${"•".repeat(Math.max(0, Math.min(8, reference.length - visible.length)))}${visible}`;
}
