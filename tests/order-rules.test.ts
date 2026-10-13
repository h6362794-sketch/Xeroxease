import { describe, it, expect } from "vitest";
import { ORDER_TRANSITIONS, CANCELLABLE_STATUSES } from "@/lib/constants";
import { isTransitionAllowed } from "@/lib/order-status";

describe("order status machine", () => {
  it("allows payment flow transitions", () => {
    expect(isTransitionAllowed("ORDER_PLACED", "PAYMENT_PENDING")).toBe(true);
    expect(isTransitionAllowed("PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW")).toBe(true);
    expect(isTransitionAllowed("PAYMENT_UNDER_REVIEW", "PAYMENT_CONFIRMED")).toBe(true);
    expect(isTransitionAllowed("PAYMENT_CONFIRMED", "PRINTING")).toBe(true);
  });

  it("allows fulfillment flow", () => {
    expect(isTransitionAllowed("PRINTING", "QUALITY_CHECK")).toBe(true);
    expect(isTransitionAllowed("QUALITY_CHECK", "READY_FOR_COLLECTION")).toBe(true);
    expect(isTransitionAllowed("READY_FOR_COLLECTION", "COMPLETED")).toBe(true);
  });

  it("rejects skipping stages", () => {
    expect(isTransitionAllowed("ORDER_PLACED", "PRINTING")).toBe(false);
    expect(isTransitionAllowed("PAYMENT_PENDING", "COMPLETED")).toBe(false);
    expect(isTransitionAllowed("PROCESSING", "COMPLETED")).toBe(false);
  });

  it("terminal states cannot change", () => {
    expect(isTransitionAllowed("COMPLETED", "CANCELLED")).toBe(false);
    expect(isTransitionAllowed("CANCELLED", "PROCESSING")).toBe(false);
    expect(isTransitionAllowed("FAILED", "PRINTING")).toBe(false);
  });

  it("rejects status from unknown state (never true for undefined)", () => {
    expect(isTransitionAllowed("MADE_UP_STATE", "PRINTING")).toBe(false);
  });

  it("every declared transition target is a known status", () => {
    const known = new Set(Object.keys(ORDER_TRANSITIONS));
    for (const [, targets] of Object.entries(ORDER_TRANSITIONS)) {
      for (const t of targets) expect(known.has(t)).toBe(true);
    }
  });
});

describe("cancellation rules", () => {
  it("cancellable before printing", () => {
    expect(CANCELLABLE_STATUSES).toContain("PAYMENT_PENDING");
    expect(CANCELLABLE_STATUSES).toContain("PROCESSING");
  });
  it("not cancellable once printing or beyond", () => {
    expect(CANCELLABLE_STATUSES).not.toContain("PRINTING");
    expect(CANCELLABLE_STATUSES).not.toContain("READY_FOR_COLLECTION");
    expect(CANCELLABLE_STATUSES).not.toContain("COMPLETED");
  });
});
