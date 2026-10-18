import { describe, it, expect, vi, beforeEach } from "vitest";
import { settingsPatchSchema } from "@/lib/settings-policy";
import {
  canStudentCancelIn,
  isTransitionAllowed,
  studentCancellableStatuses,
} from "@/lib/order-status";

/**
 * Finding 4: the order-state machine is the only authority on transitions. A Super Admin setting
 * may narrow student cancellation, but must never make a completed, failed or printing order
 * cancellable, and the server must refuse those cancels even when a stored value says otherwise.
 */

const DEFAULT_CANCELLABLE = ["ORDER_PLACED", "PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW"];

describe("studentCancellableStatuses", () => {
  it("keeps the default list unchanged", () => {
    expect(studentCancellableStatuses(DEFAULT_CANCELLABLE)).toEqual(DEFAULT_CANCELLABLE);
  });

  it.each(["COMPLETED", "CANCELLED", "FAILED", "PRINTING", "QUALITY_CHECK", "READY_FOR_COLLECTION", "NOT_A_STATUS"])(
    "drops %s even when configured",
    (status) => {
      expect(studentCancellableStatuses([status])).toEqual([]);
      expect(canStudentCancelIn(status, [status])).toBe(false);
    }
  );

  it("cannot widen beyond the built-in cancellable set", () => {
    // PAYMENT_CONFIRMED is built-in cancellable but not in the default list, so a
    // settings list of [] or the defaults never lets a student cancel a paid order.
    expect(canStudentCancelIn("PAYMENT_CONFIRMED", DEFAULT_CANCELLABLE)).toBe(false);
    expect(canStudentCancelIn("PAYMENT_CONFIRMED", [])).toBe(false);
  });

  it("can narrow: an empty list disables student cancellation", () => {
    expect(canStudentCancelIn("ORDER_PLACED", [])).toBe(false);
  });
});

describe("settingsPatchSchema.cancellationAllowedStatuses", () => {
  it("accepts the default list", () => {
    expect(settingsPatchSchema.safeParse({ cancellationAllowedStatuses: DEFAULT_CANCELLABLE }).success).toBe(true);
  });

  it.each([["COMPLETED"], ["CANCELLED"], ["PRINTING"], ["READY_FOR_COLLECTION"], ["bogus"]])(
    "rejects %s",
    (status) => {
      expect(settingsPatchSchema.safeParse({ cancellationAllowedStatuses: [status] }).success).toBe(false);
    }
  );
});

describe("order state machine guards used by the payment routes", () => {
  it("verification moves each pre-payment state to PAYMENT_CONFIRMED", () => {
    for (const s of ["ORDER_PLACED", "PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW"]) {
      expect(isTransitionAllowed(s, "PAYMENT_CONFIRMED")).toBe(true);
    }
    for (const s of ["PRINTING", "READY_FOR_COLLECTION", "COMPLETED", "CANCELLED", "FAILED"]) {
      expect(isTransitionAllowed(s, "PAYMENT_CONFIRMED")).toBe(false);
    }
  });

  it("rejection moves a reviewed order back to PAYMENT_PENDING, and not from closed states", () => {
    expect(isTransitionAllowed("PAYMENT_UNDER_REVIEW", "PAYMENT_PENDING")).toBe(true);
    expect(isTransitionAllowed("ORDER_PLACED", "PAYMENT_PENDING")).toBe(true);
    for (const s of ["PRINTING", "READY_FOR_COLLECTION", "COMPLETED", "CANCELLED", "FAILED"]) {
      expect(isTransitionAllowed(s, "PAYMENT_PENDING")).toBe(false);
    }
  });
});

const m = vi.hoisted(() => ({ findUnique: vi.fn(), updateMany: vi.fn(), getSettings: vi.fn() }));

describe("cancelOrder", () => {
  const { findUnique, updateMany, getSettings } = m;

  vi.mock("@/lib/prisma", () => ({
    prisma: {
      order: { findUnique: (...a: unknown[]) => m.findUnique(...a) },
      $transaction: async (fn: (tx: unknown) => unknown) =>
        fn({
          order: { updateMany: (...a: unknown[]) => m.updateMany(...a) },
          orderEvent: { create: vi.fn(async () => ({})) },
        }),
    },
  }));
  vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => undefined) }));
  vi.mock("@/server/notifications", () => ({
    NOTIFY: new Proxy({}, { get: () => vi.fn(async () => undefined) }),
    notify: vi.fn(async () => undefined),
  }));
  vi.mock("@/server/settings", () => ({
    getSettings: (...a: unknown[]) => m.getSettings(...a),
    getPriceTable: vi.fn(async () => ({})),
  }));

  const ORDER = { id: "order-1", orderNumber: "XE-1", userId: "student-1", status: "COMPLETED" };

  beforeEach(() => {
    findUnique.mockReset().mockResolvedValue({ ...ORDER });
    updateMany.mockReset().mockResolvedValue({ count: 1 });
    getSettings.mockReset().mockResolvedValue({ cancellationAllowedStatuses: DEFAULT_CANCELLABLE });
  });

  it("refuses a student cancel of a completed order, even when settings list COMPLETED", async () => {
    getSettings.mockResolvedValue({ cancellationAllowedStatuses: ["COMPLETED", ...DEFAULT_CANCELLABLE] });
    const { cancelOrder, OrderError } = await import("@/server/orders");
    await expect(
      cancelOrder({ orderId: ORDER.id, userId: ORDER.userId, actorRole: "STUDENT" })
    ).rejects.toBeInstanceOf(OrderError);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses a student cancel of a printing order whatever the setting says", async () => {
    findUnique.mockResolvedValue({ ...ORDER, status: "PRINTING" });
    getSettings.mockResolvedValue({ cancellationAllowedStatuses: ["PRINTING", ...DEFAULT_CANCELLABLE] });
    const { cancelOrder } = await import("@/server/orders");
    await expect(cancelOrder({ orderId: ORDER.id, userId: ORDER.userId, actorRole: "STUDENT" })).rejects.toThrow();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("allows a student cancel of a pre-payment order that is in the configured list", async () => {
    findUnique.mockResolvedValue({ ...ORDER, status: "PAYMENT_PENDING" });
    const { cancelOrder } = await import("@/server/orders");
    await cancelOrder({ orderId: ORDER.id, userId: ORDER.userId, actorRole: "STUDENT" });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].data.status).toBe("CANCELLED");
  });
});
