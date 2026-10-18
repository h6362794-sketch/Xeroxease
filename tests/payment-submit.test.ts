import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/payment/submit/:orderId — the student submits a payment reference.
 * Rules under test: a reference belongs to one order only, the reference is stored
 * normalised, and the payment-state change is conditional so concurrent submissions
 * cannot both succeed.
 */

const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const USER = { id: "user-1", role: "STUDENT" as const };

const orderFindUnique = vi.fn();
const txOrderFindFirst = vi.fn();
const txOrderUpdateMany = vi.fn();
const txPaymentEventCreate = vi.fn();
const txOrderEventCreate = vi.fn();
const transaction = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    order: { findUnique: (...a: unknown[]) => orderFindUnique(...a) },
    user: { findMany: vi.fn(async () => []) },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}));
vi.mock("@/server/auth", () => ({ requireUser: vi.fn(async () => USER) }));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/notifications", () => ({
  notify: vi.fn(async () => undefined),
  NOTIFY: { paymentSubmitted: vi.fn(async () => undefined) },
}));

let POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

beforeEach(async () => {
  vi.resetModules();
  orderFindUnique.mockReset();
  txOrderFindFirst.mockReset().mockResolvedValue(null);
  txOrderUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  txPaymentEventCreate.mockReset().mockResolvedValue({});
  txOrderEventCreate.mockReset().mockResolvedValue({});
  transaction.mockReset().mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      order: { findFirst: txOrderFindFirst, updateMany: txOrderUpdateMany },
      paymentEvent: { create: txPaymentEventCreate },
      orderEvent: { create: txOrderEventCreate },
    })
  );
  orderFindUnique.mockResolvedValue({
    id: ORDER_ID,
    orderNumber: "XE-2026-000001",
    userId: USER.id,
    status: "PAYMENT_PENDING",
    paymentStatus: "PAYMENT_PENDING",
    totalAmount: 120,
  });
  ({ POST } = await import("@/app/api/payment/submit/[id]/route"));
});

function submit(reference: string) {
  return POST(
    new Request(`http://localhost/api/payment/submit/${ORDER_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reference }),
    }),
    { params: Promise.resolve({ id: ORDER_ID }) }
  );
}

describe("POST /api/payment/submit/[id]", () => {
  it("stores the reference normalised (case and whitespace do not create a new reference)", async () => {
    const res = await submit("  utr 1234 5678 ");
    expect(res.status).toBe(200);
    expect(txOrderUpdateMany.mock.calls[0][0].data.paymentRef).toBe("UTR12345678");
  });

  it("rejects a reference already used by a different order", async () => {
    txOrderFindFirst.mockResolvedValue({ id: "other-order" });
    const res = await submit("UTR12345678");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already been submitted for another order/);
    expect(txOrderUpdateMany).not.toHaveBeenCalled();
  });

  it("checks reuse only against other orders (re-submitting on the same order is allowed)", async () => {
    await submit("UTR12345678");
    expect(txOrderFindFirst.mock.calls[0][0].where.NOT).toEqual({ id: ORDER_ID });
  });

  it("fails closed when a concurrent submission already moved the order", async () => {
    txOrderUpdateMany.mockResolvedValue({ count: 0 });
    const res = await submit("UTR12345678");
    expect(res.status).toBe(409);
    expect(txPaymentEventCreate).not.toHaveBeenCalled();
  });

  it("maps a unique-index race on payment_ref to the same 409 message", async () => {
    transaction.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002", meta: { target: ["payment_ref"] } }));
    const res = await submit("UTR12345678");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already been submitted/);
  });

  it("rejects a malformed reference before touching the database", async () => {
    const res = await submit("<script>x</script>");
    expect(res.status).toBe(422);
    expect(orderFindUnique).not.toHaveBeenCalled();
  });

  it("refuses payment for a cancelled order and does not revive it into review", async () => {
    orderFindUnique.mockResolvedValue({
      id: ORDER_ID,
      orderNumber: "XE-2026-000001",
      userId: USER.id,
      status: "CANCELLED",
      // Cancelling does not touch the payment fields, so they still look submittable.
      paymentStatus: "PAYMENT_PENDING",
      totalAmount: 120,
    });
    const res = await submit("UTR12345678");
    expect(res.status).toBe(409);
    expect(txOrderUpdateMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("the conditional write itself excludes terminal orders (race with a cancel)", async () => {
    txOrderUpdateMany.mockResolvedValueOnce({ count: 0 });
    const res = await submit("UTR12345678");
    // Allowlist, not a terminal denylist: a submission may only move the order from a
    // state in which PAYMENT_UNDER_REVIEW is a legal transition.
    expect(txOrderUpdateMany.mock.calls[0][0].where.status).toEqual({
      in: ["ORDER_PLACED", "PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW"],
    });
    expect(res.status).toBe(409);
    expect(txPaymentEventCreate).not.toHaveBeenCalled();
  });
});
