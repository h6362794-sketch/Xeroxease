import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Admin verify / reject of a payment. The write must be conditional on the payment still
 * being reviewable AND the order still being live. Previously a cancelled order could be
 * verified, which moved it back into the print queue.
 */

const ORDER_ID = "33333333-3333-4333-8333-333333333333";
const ADMIN = { id: "admin-1", role: "ADMIN" as const };

const findUnique = vi.fn();
const updateMany = vi.fn();
const paymentEventCreate = vi.fn(async (_args: { data: Record<string, unknown> }) => ({}));
const orderEventCreate = vi.fn(async () => ({}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    order: { findUnique: (...a: unknown[]) => findUnique(...a) },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        order: { updateMany: (...a: unknown[]) => updateMany(...a) },
        paymentEvent: { create: paymentEventCreate },
        orderEvent: { create: orderEventCreate },
      }),
  },
}));
vi.mock("@/server/auth", () => ({ requireRole: vi.fn(async () => ADMIN) }));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/notifications", () => ({
  NOTIFY: { paymentConfirmed: vi.fn(async () => undefined), paymentRejected: vi.fn(async () => undefined) },
}));

const ctx = { params: Promise.resolve({ id: ORDER_ID }) };
const json = (body: unknown) =>
  new Request(`http://localhost/x/${ORDER_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const live = {
  id: ORDER_ID,
  orderNumber: "XE-2026-000002",
  userId: "student-1",
  status: "PAYMENT_UNDER_REVIEW",
  paymentStatus: "PAYMENT_UNDER_REVIEW",
  paymentRef: "UTR1234",
  totalAmount: 120,
};

beforeEach(() => {
  findUnique.mockReset();
  updateMany.mockReset().mockResolvedValue({ count: 1 });
  paymentEventCreate.mockClear();
  orderEventCreate.mockClear();
});

describe("PATCH /api/admin/payments/[id]/verify", () => {
  it("confirms a live order and writes the payment record", async () => {
    findUnique.mockResolvedValue({ ...live });
    const { PATCH } = await import("@/app/api/admin/payments/[id]/verify/route");
    const res = await PATCH(json({ note: "" }), ctx);
    expect(res.status).toBe(200);
    const where = updateMany.mock.calls[0][0].where;
    expect(where.paymentStatus).toEqual({ in: ["PAYMENT_PROOF_SUBMITTED", "PAYMENT_UNDER_REVIEW"] });
    expect(where.status).toEqual({ in: ["ORDER_PLACED", "PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW"] });
    expect(paymentEventCreate).toHaveBeenCalledTimes(1);
  });

  it("refuses to verify an order the student cancelled while under review", async () => {
    findUnique.mockResolvedValue({ ...live, status: "CANCELLED" });
    const { PATCH } = await import("@/app/api/admin/payments/[id]/verify/route");
    const res = await PATCH(json({ note: "" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/cancelled/i);
    expect(updateMany).not.toHaveBeenCalled();
    expect(paymentEventCreate).not.toHaveBeenCalled();
  });

  it("the database predicate itself excludes terminal orders (defence in depth)", async () => {
    findUnique.mockResolvedValue({ ...live });
    // Simulate the race: the order is cancelled between the read and the write.
    updateMany.mockResolvedValueOnce({ count: 0 });
    const { PATCH } = await import("@/app/api/admin/payments/[id]/verify/route");
    const res = await PATCH(json({ note: "" }), ctx);
    expect(res.status).toBe(409);
    expect(updateMany.mock.calls[0][0].where.status).toEqual({ in: ["ORDER_PLACED", "PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW"] });
    expect(paymentEventCreate).not.toHaveBeenCalled();
  });

  it("fails closed when a concurrent decision already moved the payment", async () => {
    findUnique.mockResolvedValue({ ...live });
    updateMany.mockResolvedValueOnce({ count: 0 });
    const { PATCH } = await import("@/app/api/admin/payments/[id]/verify/route");
    const res = await PATCH(json({ note: "" }), ctx);
    expect(res.status).toBe(409);
    expect(paymentEventCreate).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/payments/[id]/reject", () => {
  it("rejects with a conditional write that also excludes terminal orders", async () => {
    findUnique.mockResolvedValue({ ...live });
    const { PATCH } = await import("@/app/api/admin/payments/[id]/reject/route");
    const res = await PATCH(json({ note: "Amount does not match" }), ctx);
    expect(res.status).toBe(200);
    const args = updateMany.mock.calls[0][0];
    expect(args.where.status).toEqual({ in: ["ORDER_PLACED", "PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW"] });
    expect(args.data.paymentStatus).toBe("PAYMENT_REJECTED");
  });

  it("fails closed on a lost race", async () => {
    findUnique.mockResolvedValue({ ...live });
    updateMany.mockResolvedValueOnce({ count: 0 });
    const { PATCH } = await import("@/app/api/admin/payments/[id]/reject/route");
    const res = await PATCH(json({ note: "Amount does not match" }), ctx);
    expect(res.status).toBe(409);
    expect(paymentEventCreate).not.toHaveBeenCalled();
  });
});

describe("payment decisions only move pre-print orders", () => {
  it("verify writes only while the order is still pre-print", async () => {
    findUnique.mockResolvedValue({ ...live });
    const { PATCH } = await import("@/app/api/admin/payments/[id]/verify/route");
    await PATCH(json({ note: "" }), ctx);
    expect(updateMany.mock.calls[0][0].where.status).toEqual({
      in: ["ORDER_PLACED", "PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW"],
    });
  });

  it("verify refuses an order that has already moved past payment", async () => {
    findUnique.mockResolvedValue({ ...live, status: "PRINTING" });
    const { PATCH } = await import("@/app/api/admin/payments/[id]/verify/route");
    const res = await PATCH(json({ note: "" }), ctx);
    expect(res.status).toBe(409);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("reject refuses an order that has already moved past payment", async () => {
    findUnique.mockResolvedValue({ ...live, status: "PRINTING" });
    const { PATCH } = await import("@/app/api/admin/payments/[id]/reject/route");
    const res = await PATCH(json({ note: "Amount does not match" }), ctx);
    expect(res.status).toBe(409);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("a rejected reference is released", () => {
  it("clears paymentRef on the rejected order so the reference is not held by a wrong order", async () => {
    findUnique.mockResolvedValue({ ...live });
    const { PATCH } = await import("@/app/api/admin/payments/[id]/reject/route");
    const res = await PATCH(json({ note: "Amount does not match" }), ctx);
    expect(res.status).toBe(200);
    expect(updateMany.mock.calls[0][0].data.paymentRef).toBeNull();
    // The audit trail keeps the reference it was rejected with.
    expect(paymentEventCreate.mock.calls[0][0].data.reference).toBe("UTR1234");
  });
});
