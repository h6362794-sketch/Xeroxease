// Authoritative order lifecycle — pure rules.
//
// These assertions pin the contract the API, admin portal and student portal all
// read. They intentionally cover BOTH the canonical lifecycle (new orders) and
// the preserved legacy graph (historical rows), because existing orders must keep
// progressing without their stored statuses being rewritten.

import { describe, it, expect } from "vitest";
import {
  ORDER_STATUS_VALUES,
  ORDER_TRANSITIONS,
  STUDENT_STAGES,
  allowedNextStatuses,
  canActorChangeStatus,
  cancellationExplanation,
  isPaymentEligibleOrderStatus,
  isStudentCancellable,
  isTerminalStatus,
  isTransitionAllowed,
  requiresConfirmation,
  requiresReason,
  stageIndexFor,
  statusLabel,
} from "@/lib/order-status";

describe("student-facing lifecycle", () => {
  it("shows exactly the five canonical stages in order", () => {
    expect(STUDENT_STAGES.map((s) => s.key)).toEqual([
      "ORDER_RECEIVED",
      "ACCEPTED",
      "PRINTING",
      "READY_FOR_PICKUP",
      "DELIVERED",
    ]);
    expect(STUDENT_STAGES.map((s) => s.label)).toEqual([
      "Order Received",
      "Order Accepted",
      "Printing",
      "Ready for Pickup",
      "Order Delivered",
    ]);
  });

  it("maps each canonical status to its own stage", () => {
    expect(stageIndexFor("ORDER_RECEIVED")).toBe(0);
    expect(stageIndexFor("ACCEPTED")).toBe(1);
    expect(stageIndexFor("PRINTING")).toBe(2);
    expect(stageIndexFor("READY_FOR_PICKUP")).toBe(3);
    expect(stageIndexFor("DELIVERED")).toBe(4);
  });

  it("folds legacy statuses into the same visible stages", () => {
    expect(stageIndexFor("ORDER_PLACED")).toBe(0);
    expect(stageIndexFor("PAYMENT_PENDING")).toBe(1);
    expect(stageIndexFor("QUALITY_CHECK")).toBe(2);
    expect(stageIndexFor("READY_FOR_COLLECTION")).toBe(3);
    expect(stageIndexFor("COMPLETED")).toBe(4);
  });

  it("never presents rejection or cancellation as a progress step", () => {
    expect(stageIndexFor("REJECTED")).toBe(-1);
    expect(stageIndexFor("CANCELLED")).toBe(-1);
    expect(stageIndexFor("FAILED")).toBe(-1);
  });

  it("labels rejected orders as Not Accepted", () => {
    expect(statusLabel("REJECTED")).toBe("Not Accepted");
    expect(statusLabel("ORDER_RECEIVED")).toBe("Order Received");
    expect(statusLabel("READY_FOR_PICKUP")).toBe("Ready for Pickup");
  });
});

describe("canonical transitions", () => {
  it("allows every forward edge exactly once", () => {
    expect(isTransitionAllowed("ORDER_RECEIVED", "ACCEPTED")).toBe(true);
    expect(isTransitionAllowed("ACCEPTED", "PRINTING")).toBe(true);
    expect(isTransitionAllowed("PRINTING", "READY_FOR_PICKUP")).toBe(true);
    expect(isTransitionAllowed("READY_FOR_PICKUP", "DELIVERED")).toBe(true);
  });

  it("allows rejection before printing but never from a finished order", () => {
    expect(isTransitionAllowed("ORDER_RECEIVED", "REJECTED")).toBe(true);
    expect(isTransitionAllowed("ACCEPTED", "REJECTED")).toBe(true);
    expect(isTransitionAllowed("PRINTING", "REJECTED")).toBe(false);
    expect(isTransitionAllowed("DELIVERED", "REJECTED")).toBe(false);
  });

  it("does not let a rejected order re-enter production", () => {
    expect(isTransitionAllowed("REJECTED", "ACCEPTED")).toBe(false);
    expect(isTransitionAllowed("REJECTED", "ORDER_RECEIVED")).toBe(false);
  });

  it("rejects skips, reversals, self-transitions and unknown states", () => {
    expect(isTransitionAllowed("ORDER_RECEIVED", "PRINTING")).toBe(false);
    expect(isTransitionAllowed("ORDER_RECEIVED", "DELIVERED")).toBe(false);
    expect(isTransitionAllowed("PRINTING", "ACCEPTED")).toBe(false);
    expect(isTransitionAllowed("ACCEPTED", "ACCEPTED")).toBe(false);
    expect(isTransitionAllowed("MADE_UP", "PRINTING")).toBe(false);
  });

  it("keeps terminal states terminal", () => {
    for (const terminal of ["DELIVERED", "REJECTED", "COMPLETED", "CANCELLED", "FAILED"]) {
      expect(isTerminalStatus(terminal)).toBe(true);
      expect(allowedNextStatuses(terminal)).toEqual([]);
    }
  });

  it("exposes only known statuses as transition targets", () => {
    const known = new Set(ORDER_STATUS_VALUES);
    for (const [from, targets] of Object.entries(ORDER_TRANSITIONS)) {
      expect(known.has(from as never)).toBe(true);
      for (const target of targets) expect(known.has(target as never)).toBe(true);
    }
  });

  it("keeps legacy orders completable without rewriting history", () => {
    expect(isTransitionAllowed("ORDER_PLACED", "PAYMENT_PENDING")).toBe(true);
    expect(isTransitionAllowed("PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW")).toBe(true);
    expect(isTransitionAllowed("PAYMENT_UNDER_REVIEW", "PAYMENT_CONFIRMED")).toBe(true);
    expect(isTransitionAllowed("PROCESSING", "QUALITY_CHECK")).toBe(true);
    expect(isTransitionAllowed("QUALITY_CHECK", "READY_FOR_COLLECTION")).toBe(true);
    expect(isTransitionAllowed("READY_FOR_COLLECTION", "COMPLETED")).toBe(true);
  });
});

describe("privileged transition rules", () => {
  it("only lets administrative roles move an order", () => {
    expect(canActorChangeStatus("ADMIN")).toBe(true);
    expect(canActorChangeStatus("SUPER_ADMIN")).toBe(true);
    expect(canActorChangeStatus("STUDENT")).toBe(false);
    expect(canActorChangeStatus("")).toBe(false);
  });

  it("requires explicit confirmation for irreversible outcomes", () => {
    expect(requiresConfirmation("DELIVERED")).toBe(true);
    expect(requiresConfirmation("REJECTED")).toBe(true);
    expect(requiresConfirmation("ACCEPTED")).toBe(false);
    expect(requiresConfirmation("PRINTING")).toBe(false);
  });

  it("requires a written reason for rejection", () => {
    expect(requiresReason("REJECTED")).toBe(true);
    expect(requiresReason("CANCELLED")).toBe(false);
  });
});

describe("pre-acceptance cancellation", () => {
  it("allows cancellation while the order is still awaiting acceptance", () => {
    expect(isStudentCancellable("ORDER_RECEIVED")).toBe(true);
  });

  it("stops cancellation the moment the order is accepted", () => {
    for (const status of ["ACCEPTED", "PRINTING", "READY_FOR_PICKUP", "DELIVERED"]) {
      expect(isStudentCancellable(status)).toBe(false);
    }
  });

  it("cannot be widened by settings after acceptance", () => {
    // A stale/over-broad settings row must not re-enable cancellation.
    expect(isStudentCancellable("ACCEPTED", ["ACCEPTED", "PRINTING"])).toBe(false);
    expect(isStudentCancellable("PRINTING", ["PRINTING"])).toBe(false);
    expect(isStudentCancellable("READY_FOR_PICKUP", ["READY_FOR_PICKUP"])).toBe(false);
  });

  it("lets settings only narrow the legacy pre-acceptance states", () => {
    expect(isStudentCancellable("PAYMENT_PENDING", ["PAYMENT_PENDING"])).toBe(true);
    expect(isStudentCancellable("PAYMENT_PENDING", [])).toBe(false);
    expect(isStudentCancellable("PAYMENT_UNDER_REVIEW", ["PAYMENT_PENDING"])).toBe(false);
    // The canonical pre-acceptance row can never be configured away.
    expect(isStudentCancellable("ORDER_RECEIVED", [])).toBe(true);
  });

  it("explains why the button is gone once accepted", () => {
    expect(cancellationExplanation("ORDER_RECEIVED")).toBeNull();
    expect(cancellationExplanation("ACCEPTED")).toMatch(/accepted/i);
    expect(cancellationExplanation("PRINTING")).toMatch(/accepted/i);
    expect(cancellationExplanation("DELIVERED")).toMatch(/delivered|complete/i);
    expect(cancellationExplanation("REJECTED")).toMatch(/closed/i);
  });

  it("lists no impossible outcome as a student stage", () => {
    const staged = STUDENT_STAGES.flatMap((s) => [...s.statuses]);
    for (const status of ["REJECTED", "CANCELLED", "FAILED"]) {
      expect(staged).not.toContain(status);
    }
  });
});

describe("payment eligibility is a separate axis", () => {
  it("only exposes payment controls after acceptance", () => {
    expect(isPaymentEligibleOrderStatus("ORDER_RECEIVED")).toBe(false);
    expect(isPaymentEligibleOrderStatus("ACCEPTED")).toBe(true);
    expect(isPaymentEligibleOrderStatus("PRINTING")).toBe(true);
    expect(isPaymentEligibleOrderStatus("READY_FOR_PICKUP")).toBe(true);
    expect(isPaymentEligibleOrderStatus("DELIVERED")).toBe(false);
    expect(isPaymentEligibleOrderStatus("REJECTED")).toBe(false);
  });
});
