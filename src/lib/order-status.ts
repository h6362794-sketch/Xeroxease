// Authoritative order-status model.
//
// This module is the single source of truth for:
//   * the canonical student-facing lifecycle and the five visible stages,
//   * every legal transition (API, admin UI and student UI all read it),
//   * terminal/rejected handling,
//   * pre-acceptance cancellation eligibility,
//   * the point at which payment choices become available.
//
// It is deliberately free of Prisma / Next.js imports so the rules can be unit
// tested, and so the admin portal cannot drift from the server (the old admin
// modal carried its own duplicated transition table).
//
// Lifecycle for NEW orders:
//
//   ORDER_RECEIVED ──accept──▶ ACCEPTED ──▶ PRINTING ──▶ READY_FOR_PICKUP ──▶ DELIVERED
//          │                     │
//          └──reject/ cancel     └──reject
//
// `REJECTED` is a distinct outcome, not a progress step. Payment is a separate
// axis (`PaymentStatus`) and confirming it never moves the printing lifecycle.
//
// Legacy statuses remain readable and are never rewritten. Historical orders can
// still be progressed along the legacy graph so admin operations keep working.

export type OrderLifecycleStatus =
  | "ORDER_RECEIVED"
  | "ACCEPTED"
  | "PRINTING"
  | "READY_FOR_PICKUP"
  | "DELIVERED"
  | "REJECTED";

export type LegacyOrderStatus =
  | "ORDER_PLACED"
  | "PAYMENT_PENDING"
  | "PAYMENT_UNDER_REVIEW"
  | "PAYMENT_CONFIRMED"
  | "DOCUMENTS_RECEIVED"
  | "PROCESSING"
  | "QUALITY_CHECK"
  | "READY_FOR_COLLECTION"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

export type OrderStatusValue = OrderLifecycleStatus | LegacyOrderStatus;

export const ORDER_STATUS_VALUES: readonly OrderStatusValue[] = [
  "ORDER_RECEIVED",
  "ACCEPTED",
  "PRINTING",
  "READY_FOR_PICKUP",
  "DELIVERED",
  "REJECTED",
  // legacy
  "ORDER_PLACED",
  "PAYMENT_PENDING",
  "PAYMENT_UNDER_REVIEW",
  "PAYMENT_CONFIRMED",
  "DOCUMENTS_RECEIVED",
  "PROCESSING",
  "QUALITY_CHECK",
  "READY_FOR_COLLECTION",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
] as const;

export const ORDER_STATUS_LABELS: Record<string, string> = {
  // Canonical student-facing labels
  ORDER_RECEIVED: "Order Received",
  ACCEPTED: "Order Accepted",
  PRINTING: "Printing",
  READY_FOR_PICKUP: "Ready for Pickup",
  DELIVERED: "Order Delivered",
  REJECTED: "Not Accepted",
  // Legacy labels — kept descriptive so history reads correctly
  ORDER_PLACED: "Order Placed",
  PAYMENT_PENDING: "Payment Pending (legacy)",
  PAYMENT_UNDER_REVIEW: "Payment Under Review (legacy)",
  PAYMENT_CONFIRMED: "Payment Confirmed (legacy)",
  DOCUMENTS_RECEIVED: "Documents Received (legacy)",
  PROCESSING: "Processing (legacy)",
  QUALITY_CHECK: "Quality Check (legacy)",
  READY_FOR_COLLECTION: "Ready for Collection (legacy)",
  COMPLETED: "Completed (legacy)",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
};

export function statusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status.replaceAll("_", " ");
}

/**
 * Legal transitions, including the legacy graph for historical rows.
 * No state may transition to itself: repeated transitions are rejected.
 */
export const ORDER_TRANSITIONS: Record<string, readonly string[]> = {
  // Canonical lifecycle
  ORDER_RECEIVED: ["ACCEPTED", "REJECTED", "CANCELLED"],
  ACCEPTED: ["PRINTING", "REJECTED"],
  // QUALITY_CHECK is legacy-only: orders created before this lifecycle may
  // already be sitting in PRINTING and must still be able to finish.
  PRINTING: ["READY_FOR_PICKUP", "QUALITY_CHECK"],
  READY_FOR_PICKUP: ["DELIVERED"],
  DELIVERED: [],
  REJECTED: [],

  // Legacy graph (unchanged, so existing orders keep their documented path)
  ORDER_PLACED: ["PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW", "PAYMENT_CONFIRMED", "CANCELLED", "FAILED"],
  PAYMENT_PENDING: ["PAYMENT_UNDER_REVIEW", "PAYMENT_CONFIRMED", "CANCELLED", "FAILED"],
  PAYMENT_UNDER_REVIEW: ["PAYMENT_CONFIRMED", "PAYMENT_PENDING", "CANCELLED", "FAILED"],
  PAYMENT_CONFIRMED: ["DOCUMENTS_RECEIVED", "PROCESSING", "PRINTING", "CANCELLED", "FAILED"],
  DOCUMENTS_RECEIVED: ["PROCESSING", "PRINTING", "CANCELLED", "FAILED"],
  PROCESSING: ["PRINTING", "QUALITY_CHECK", "CANCELLED", "FAILED"],
  QUALITY_CHECK: ["READY_FOR_COLLECTION", "FAILED"],
  READY_FOR_COLLECTION: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};

/** Statuses in which a student may still cancel (pre-acceptance only). */
export const CANCELLABLE_STATUSES = [
  "ORDER_RECEIVED",
  "ORDER_PLACED",
  "PAYMENT_PENDING",
  "PAYMENT_UNDER_REVIEW",
] as const;

/** Statuses that make payment controls available (after admin acceptance). */
export const PAYMENT_ELIGIBLE_ORDER_STATUSES = [
  "ACCEPTED",
  "PRINTING",
  "READY_FOR_PICKUP",
] as const;

/** Terminal states: no further status writes are allowed. */
export const TERMINAL_STATUSES = [
  "DELIVERED",
  "REJECTED",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
] as const;

export interface StudentStage {
  key: string;
  label: string;
  description: string;
  /** All statuses (canonical + legacy) that belong to this visible stage. */
  statuses: readonly string[];
}

/**
 * The five stages every student sees. Legacy statuses are folded in so the
 * timeline still makes sense for orders created before this lifecycle existed.
 */
export const STUDENT_STAGES: readonly StudentStage[] = [
  {
    key: "ORDER_RECEIVED",
    label: "Order Received",
    description: "Your order has been submitted and is waiting for the print desk to review it.",
    statuses: ["ORDER_RECEIVED", "ORDER_PLACED"],
  },
  {
    key: "ACCEPTED",
    label: "Order Accepted",
    description: "The print desk has accepted your order for printing.",
    statuses: ["ACCEPTED", "PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW", "PAYMENT_CONFIRMED", "DOCUMENTS_RECEIVED", "PROCESSING"],
  },
  {
    key: "PRINTING",
    label: "Printing",
    description: "Your documents are being printed.",
    statuses: ["PRINTING", "QUALITY_CHECK"],
  },
  {
    key: "READY_FOR_PICKUP",
    label: "Ready for Pickup",
    description: "Printing is complete — collect your documents from the desk.",
    statuses: ["READY_FOR_PICKUP", "READY_FOR_COLLECTION"],
  },
  {
    key: "DELIVERED",
    label: "Order Delivered",
    description: "Your printed documents have been handed over. Order complete.",
    statuses: ["DELIVERED", "COMPLETED"],
  },
] as const;

/**
 * Index of the current stage, or -1 for outcomes that are not progress steps
 * (rejected/cancelled/failed).
 */
export function stageIndexFor(status: string): number {
  return STUDENT_STAGES.findIndex((s) => s.statuses.includes(status));
}

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status) || (ORDER_TRANSITIONS[status]?.length ?? 0) === 0;
}

export function isLegacyStatus(status: string): boolean {
  return !["ORDER_RECEIVED", "ACCEPTED", "PRINTING", "READY_FOR_PICKUP", "DELIVERED", "REJECTED"].includes(status);
}

/** Unknown source states never allow a transition (no implicit wildcard). */
export function isTransitionAllowed(from: string, to: string): boolean {
  if (from === to) return false;
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

/** Every valid next state, from the authoritative table. */
export function allowedNextStatuses(from: string): string[] {
  return [...(ORDER_TRANSITIONS[from] ?? [])];
}

/**
 * Only administrative roles may move an order. Students never can — the
 * student-facing cancellation endpoint has its own narrowly-scoped rule.
 */
export function canActorChangeStatus(role: string): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

/** A status change is destructive/irreversible and needs explicit confirmation. */
export function requiresConfirmation(to: string): boolean {
  return to === "DELIVERED" || to === "REJECTED";
}

/** Rejections must be explained so the student knows why. */
export function requiresReason(to: string): boolean {
  return to === "REJECTED";
}

/**
 * Cancellation rule. Pre-acceptance statuses are hard-coded: no settings change
 * can re-enable cancellation once an administrator has accepted the order. The
 * configured list can only narrow the legacy pre-acceptance statuses, never
 * widen eligibility.
 */
export function isStudentCancellable(status: string, configured?: readonly string[]): boolean {
  if (!(CANCELLABLE_STATUSES as readonly string[]).includes(status)) return false;
  // ORDER_RECEIVED is the canonical pre-acceptance state; it can never be
  // configured away or re-enabled after acceptance.
  if (status === "ORDER_RECEIVED") return true;
  return configured ? configured.includes(status) : true;
}

/** Payment controls only exist once the order has been accepted. */
export function isPaymentEligibleOrderStatus(status: string): boolean {
  return (PAYMENT_ELIGIBLE_ORDER_STATUSES as readonly string[]).includes(status);
}

/** Cancellation/outcome explanation used by both portals. */
export function cancellationExplanation(status: string): string | null {
  if (isStudentCancellable(status)) return null;
  if (status === "ACCEPTED" || status === "PRINTING" || status === "READY_FOR_PICKUP") {
    return "This order has been accepted and can no longer be cancelled online.";
  }
  if (["DELIVERED", "COMPLETED"].includes(status)) {
    return "This order is complete and can no longer be cancelled.";
  }
  if (["REJECTED", "CANCELLED", "FAILED"].includes(status)) {
    return "This order is already closed.";
  }
  return "This order can no longer be cancelled online.";
}

/** Student-visible status label for the canonical stages, legacy labels otherwise. */
export function studentStatusLabel(status: string): string {
  return statusLabel(status);
}
