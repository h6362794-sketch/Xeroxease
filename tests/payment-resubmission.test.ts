import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isPaymentSubmissionState, PAYMENT_SUBMISSION_STATES } from "@/lib/order-status";

/**
 * B1 regression: a student must be able to correct and resubmit a rejected payment, and the
 * server must still refuse duplicate references and invalid order-state transitions.
 */

const ORDER_ID = "33333333-3333-4333-8333-333333333333";
const USER = { id: "student-1", role: "STUDENT" as const };

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
vi.mock("@/server/auth", () => ({
  requireUser: vi.fn(async () => USER),
  isAdminRole: (role: string) => role === "ADMIN" || role === "SUPER_ADMIN",
}));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/notifications", () => ({
  notify: vi.fn(async () => undefined),
  NOTIFY: { paymentSubmitted: vi.fn(async () => undefined) },
}));

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let POST: Handler;

/** An order as it looks after the desk rejected the first reference. */
function rejectedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    orderNumber: "XE-2026-000042",
    userId: USER.id,
    status: "PAYMENT_PENDING",
    paymentStatus: "PAYMENT_REJECTED",
    paymentRef: null,
    paymentNote: "Amount does not match the order total.",
    totalAmount: 120,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.resetModules();
  orderFindUnique.mockReset().mockResolvedValue(rejectedOrder());
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
  ({ POST } = (await import("@/app/api/payment/submit/[id]/route")) as unknown as { POST: Handler });
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

describe("payment resubmission after a rejection (B1)", () => {
  it("accepts a corrected reference after rejection and moves the order into review", async () => {
    const res = await submit("utr 9876 5432");
    expect(res.status).toBe(200);
    const call = txOrderUpdateMany.mock.calls[0][0];
    expect(call.data).toMatchObject({
      paymentStatus: "PAYMENT_UNDER_REVIEW",
      status: "PAYMENT_UNDER_REVIEW",
      paymentRef: "UTR98765432",
    });
    expect(call.where.paymentStatus.in).toEqual(["PAYMENT_PENDING", "PAYMENT_REJECTED", "PAYMENT_FAILED"]);
  });

  it("restricts the conditional write to payment-submission states only", async () => {
    await submit("UTR-OK-0001");
    expect(txOrderUpdateMany.mock.calls[0][0].where.status).toEqual({ in: [...PAYMENT_SUBMISSION_STATES] });
  });

  it("excludes the order's own id from the duplicate check, so the same reference can be re-sent on the same order", async () => {
    await submit("UTR-SAME-0001");
    expect(txOrderFindFirst.mock.calls[0][0].where.NOT).toEqual({ id: ORDER_ID });
  });

  it("refuses a reference that another order already holds, without writing", async () => {
    txOrderFindFirst.mockResolvedValue({ id: "some-other-order" });
    const res = await submit("UTR-TAKEN-0001");
    expect(res.status).toBe(409);
    expect(txOrderUpdateMany).not.toHaveBeenCalled();
    expect(txPaymentEventCreate).not.toHaveBeenCalled();
  });

  it("maps a unique-index race (P2002 on payment_ref) to the same duplicate message", async () => {
    transaction.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target: ["payment_ref"] } })
    );
    const res = await submit("UTR-RACE-0001");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already been submitted for another order/);
  });

  it("refuses a resubmission when another request has already moved the order (count 0)", async () => {
    txOrderUpdateMany.mockResolvedValueOnce({ count: 0 });
    const res = await submit("UTR-LOST-0001");
    expect(res.status).toBe(409);
    expect(txPaymentEventCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["PRINTING", "PAYMENT_REJECTED"],
    ["PROCESSING", "PAYMENT_PENDING"],
    ["READY_FOR_COLLECTION", "PAYMENT_REJECTED"],
    ["CANCELLED", "PAYMENT_PENDING"],
    ["COMPLETED", "PAYMENT_REJECTED"],
  ])("refuses a submission on an order in %s (payment %s) without touching it", async (status, paymentStatus) => {
    orderFindUnique.mockResolvedValue(rejectedOrder({ status, paymentStatus }));
    const res = await submit("UTR-STATE-0001");
    expect(res.status).toBe(409);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a submission on a confirmed payment with the confirmed message", async () => {
    orderFindUnique.mockResolvedValue(rejectedOrder({ status: "PAYMENT_CONFIRMED", paymentStatus: "PAYMENT_CONFIRMED" }));
    const res = await submit("UTR-DONE-0001");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already confirmed/);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("state guard (pure rules)", () => {
  it("allows only the pre-payment and review states", () => {
    expect(PAYMENT_SUBMISSION_STATES).toEqual(["ORDER_PLACED", "PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW"]);
    for (const s of ["PAYMENT_PENDING", "ORDER_PLACED", "PAYMENT_UNDER_REVIEW"]) {
      expect(isPaymentSubmissionState(s)).toBe(true);
    }
    for (const s of ["PAYMENT_CONFIRMED", "DOCUMENTS_RECEIVED", "PROCESSING", "PRINTING", "QUALITY_CHECK", "READY_FOR_COLLECTION", "COMPLETED", "CANCELLED", "FAILED", "", "unknown"]) {
      expect(isPaymentSubmissionState(s)).toBe(false);
    }
  });
});

describe("student order response exposes the rejection reason", () => {
  async function getOrder(order: Record<string, unknown>) {
    vi.resetModules();
    orderFindUnique.mockReset().mockResolvedValue({
      ...order,
      files: [],
      events: [],
      feedback: null,
      user: { name: "A", email: "a@example.com", regNo: "R1", phone: null, branch: null, section: null, year: null },
      totalAmount: 120,
      pricePerPage: 2,
      finishingFee: 0,
    });
    vi.doMock("@/lib/prisma", () => ({ prisma: { order: { findUnique: (...a: unknown[]) => orderFindUnique(...a) } } }));
    const { GET } = (await import("@/app/api/orders/[id]/route")) as unknown as {
      GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
    };
    const res = await GET(new Request(`http://localhost/api/orders/${ORDER_ID}`), {
      params: Promise.resolve({ id: ORDER_ID }),
    });
    return (await res.json()).order as Record<string, unknown>;
  }

  it("shows the desk's reason while the payment is rejected, and keeps paymentNote hidden", async () => {
    const order = await getOrder(rejectedOrder());
    expect(order.rejectionReason).toBe("Amount does not match the order total.");
    expect(order.paymentNote).toBeNull();
  });

  it("does not show a stale reason once the payment is pending again", async () => {
    const order = await getOrder(rejectedOrder({ paymentStatus: "PAYMENT_PENDING" }));
    expect(order.rejectionReason).toBeNull();
    expect(order.paymentNote).toBeNull();
  });
});

describe("payment form (rendered on the server to check its content)", () => {
  it("shows the rejection reason and no dead 'Open payment QR' link", async () => {
    const { PaymentForm } = await import("@/features/student/payment-form");
    const html = renderToStaticMarkup(
      createElement(PaymentForm, {
        orderId: ORDER_ID,
        orderNumber: "XE-2026-000042",
        totalAmount: 120,
        rejectionReason: "Amount does not match the order total.",
        onSubmitted: () => undefined,
      })
    );
    expect(html).toContain("Amount does not match the order total.");
    expect(html).toContain("Transaction reference");
    expect(html).not.toContain("Open payment QR");
    expect(html).not.toContain("pay later");
  });

  it("shows no rejection banner for a first-time payment, and the pay-later option only when asked", async () => {
    const { PaymentForm } = await import("@/features/student/payment-form");
    const plain = renderToStaticMarkup(
      createElement(PaymentForm, { orderId: ORDER_ID, orderNumber: "XE-1", totalAmount: 10, onSubmitted: () => undefined })
    );
    expect(plain).not.toContain("could not accept your last payment reference");
    expect(plain).not.toContain("pay later");

    const withLater = renderToStaticMarkup(
      createElement(PaymentForm, {
        orderId: ORDER_ID, orderNumber: "XE-1", totalAmount: 10, onSubmitted: () => undefined, onLater: () => undefined,
      })
    );
    expect(withLater).toContain("pay later");
  });
});
