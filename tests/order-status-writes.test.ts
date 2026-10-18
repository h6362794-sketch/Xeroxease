import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Order-level writes must be conditional on the state that was validated, and an admin
 * status change to PAYMENT_CONFIRMED must leave the same payment record as verification.
 */

const findUnique = vi.fn();
const updateMany = vi.fn();
const update = vi.fn();
const paymentEventCreate = vi.fn(async (_args: { data: Record<string, unknown> }) => ({}));
const orderEventCreate = vi.fn(async (_args: { data: Record<string, unknown> }) => ({}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    order: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      update: (...a: unknown[]) => update(...a),
    },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        order: { updateMany: (...a: unknown[]) => updateMany(...a), update: (...a: unknown[]) => update(...a) },
        orderEvent: { create: orderEventCreate },
        paymentEvent: { create: paymentEventCreate },
      }),
  },
}));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/notifications", () => ({
  NOTIFY: new Proxy({}, { get: () => vi.fn(async () => undefined) }),
  notify: vi.fn(async () => undefined),
}));
vi.mock("@/server/settings", () => ({
  getSettings: vi.fn(async () => ({ cancellationAllowedStatuses: [] })),
  getPriceTable: vi.fn(async () => ({})),
}));

const ORDER = {
  id: "44444444-4444-4444-8444-444444444444",
  orderNumber: "XE-2026-000003",
  userId: "student-1",
  status: "PAYMENT_PENDING",
  paymentStatus: "PAYMENT_PENDING",
  paymentRef: null,
  totalAmount: 90,
};

beforeEach(() => {
  findUnique.mockReset().mockResolvedValue({ ...ORDER });
  updateMany.mockReset().mockResolvedValue({ count: 1 });
  update.mockReset();
  paymentEventCreate.mockClear();
  orderEventCreate.mockClear();
});

describe("adminUpdateOrderStatus", () => {
  it("confirming through the status control records the payment verification", async () => {
    const { adminUpdateOrderStatus } = await import("@/server/orders");
    await adminUpdateOrderStatus({
      orderId: ORDER.id,
      toStatus: "PAYMENT_CONFIRMED",
      actorId: "admin-1",
      actorRole: "ADMIN",
      note: "Matched UTR in bank statement",
    });
    const args = updateMany.mock.calls[0][0];
    expect(args.where).toEqual({ id: ORDER.id, status: "PAYMENT_PENDING" });
    expect(args.data).toMatchObject({
      status: "PAYMENT_CONFIRMED",
      paymentStatus: "PAYMENT_CONFIRMED",
      paymentVerifiedBy: "admin-1",
    });
    expect(paymentEventCreate).toHaveBeenCalledTimes(1);
    expect(paymentEventCreate.mock.calls[0][0].data).toMatchObject({ type: "VERIFIED", actorId: "admin-1" });
  });

  it("refuses to confirm payment through the status control without a reason", async () => {
    const { adminUpdateOrderStatus, OrderError } = await import("@/server/orders");
    await expect(
      adminUpdateOrderStatus({ orderId: ORDER.id, toStatus: "PAYMENT_CONFIRMED", actorId: "admin-1", actorRole: "ADMIN" })
    ).rejects.toBeInstanceOf(OrderError);
    await expect(
      adminUpdateOrderStatus({ orderId: ORDER.id, toStatus: "PAYMENT_CONFIRMED", actorId: "admin-1", actorRole: "ADMIN", note: "   " })
    ).rejects.toBeInstanceOf(OrderError);
    expect(updateMany).not.toHaveBeenCalled();
    expect(paymentEventCreate).not.toHaveBeenCalled();
  });

  it("records the reason on the payment record when one is given", async () => {
    const { adminUpdateOrderStatus } = await import("@/server/orders");
    await adminUpdateOrderStatus({
      orderId: ORDER.id,
      toStatus: "PAYMENT_CONFIRMED",
      actorId: "admin-1",
      actorRole: "ADMIN",
      note: "UTR matched bank SMS",
    });
    expect(paymentEventCreate.mock.calls[0][0].data.note).toBe("Confirmed via order status control: UTR matched bank SMS");
  });

  it("does not write a payment record for ordinary transitions", async () => {
    const { adminUpdateOrderStatus } = await import("@/server/orders");
    findUnique.mockResolvedValue({ ...ORDER, status: "PAYMENT_CONFIRMED", paymentStatus: "PAYMENT_CONFIRMED" });
    await adminUpdateOrderStatus({ orderId: ORDER.id, toStatus: "PRINTING", actorId: "admin-1", actorRole: "ADMIN" });
    expect(paymentEventCreate).not.toHaveBeenCalled();
    expect(updateMany.mock.calls[0]?.[0].data.paymentStatus).toBeUndefined();
  });

  it("fails closed when the status changed after it was read", async () => {
    const { adminUpdateOrderStatus, OrderError } = await import("@/server/orders");
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      adminUpdateOrderStatus({ orderId: ORDER.id, toStatus: "PAYMENT_CONFIRMED", actorId: "admin-1", actorRole: "ADMIN", note: "lost race test" })
    ).rejects.toBeInstanceOf(OrderError);
    expect(paymentEventCreate).not.toHaveBeenCalled();
  });

  it("refuses to complete a ready order through the status control, so its collection code stays live", async () => {
    findUnique.mockResolvedValueOnce({ ...ORDER, status: "READY_FOR_COLLECTION" });
    const { adminUpdateOrderStatus } = await import("@/server/orders");
    await expect(
      adminUpdateOrderStatus({ orderId: ORDER.id, toStatus: "COMPLETED", actorId: "admin-1", actorRole: "ADMIN" })
    ).rejects.toMatchObject({ status: 409 });
    expect(updateMany).not.toHaveBeenCalled();
    expect(orderEventCreate).not.toHaveBeenCalled();
  });

  it("sending an order back to payment pending clears a payment that was under review", async () => {
    const { adminUpdateOrderStatus } = await import("@/server/orders");
    findUnique.mockResolvedValue({ ...ORDER, status: "PAYMENT_UNDER_REVIEW", paymentStatus: "PAYMENT_UNDER_REVIEW" });
    await adminUpdateOrderStatus({ orderId: ORDER.id, toStatus: "PAYMENT_PENDING", actorId: "admin-1", actorRole: "ADMIN" });
    expect(updateMany.mock.calls[0][0].data).toMatchObject({ status: "PAYMENT_PENDING", paymentStatus: "PAYMENT_PENDING" });
    expect(paymentEventCreate).not.toHaveBeenCalled();
  });
});

describe("cancelOrder", () => {
  it("writes only if the status that was checked is still current", async () => {
    const { cancelOrder } = await import("@/server/orders");
    findUnique.mockResolvedValue({ ...ORDER, status: "PAYMENT_UNDER_REVIEW" });
    // Eligibility comes from the settings table; the status is also in CANCELLABLE_STATUSES.
    await cancelOrder({ orderId: ORDER.id, userId: ORDER.userId, reason: "changed mind", actorRole: "STUDENT" });
    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: ORDER.id,
      userId: ORDER.userId,
      status: "PAYMENT_UNDER_REVIEW",
    });
  });

  it("a cancel that loses a race with the desk is refused (not silently applied)", async () => {
    const { cancelOrder, OrderError } = await import("@/server/orders");
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      cancelOrder({ orderId: ORDER.id, userId: ORDER.userId, actorRole: "STUDENT" })
    ).rejects.toBeInstanceOf(OrderError);
  });

  it("students cannot cancel someone else's order", async () => {
    const { cancelOrder, OrderError } = await import("@/server/orders");
    await expect(
      cancelOrder({ orderId: ORDER.id, userId: "other-student", actorRole: "STUDENT" })
    ).rejects.toBeInstanceOf(OrderError);
    expect(updateMany).not.toHaveBeenCalled();
  });

});
