// Payment lifecycle — policy + service invariants.
//
// The single most important rule: a student selecting Cash or submitting a UPI
// reference is NEVER payment confirmation. Only an administrator can record money
// as received, and doing so must not move the printing lifecycle.

import { describe, it, expect, beforeEach, vi } from "vitest";

const STUDENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const ORDER = "33333333-3333-4333-8333-333333333333";

import {
  canAdminRejectPayment,
  canAdminVerifyPayment,
  canChangePaymentMethod,
  canStudentSelectPaymentMethod,
  canStudentSubmitUpiReference,
  isPaymentMethod,
  maskReference,
  normalizeUpiReference,
} from "@/lib/payment-policy";

describe("payment policy", () => {
  it("accepts only the two configured methods", () => {
    expect(isPaymentMethod("CASH_ON_DELIVERY")).toBe(true);
    expect(isPaymentMethod("UPI")).toBe(true);
    expect(isPaymentMethod("CARD")).toBe(false);
    expect(isPaymentMethod(null)).toBe(false);
    expect(isPaymentMethod({ method: "UPI" })).toBe(false);
  });

  it("hides payment controls until the order is accepted", () => {
    expect(canStudentSelectPaymentMethod({ orderStatus: "ORDER_RECEIVED", paymentStatus: "PAYMENT_PENDING" })).toBe(false);
    expect(canStudentSelectPaymentMethod({ orderStatus: "ACCEPTED", paymentStatus: "PAYMENT_PENDING" })).toBe(true);
    expect(canStudentSelectPaymentMethod({ orderStatus: "PRINTING", paymentStatus: "PAYMENT_PENDING" })).toBe(true);
    expect(canStudentSelectPaymentMethod({ orderStatus: "DELIVERED", paymentStatus: "PAYMENT_PENDING" })).toBe(false);
    expect(canStudentSelectPaymentMethod({ orderStatus: "ACCEPTED", paymentStatus: "PAYMENT_CONFIRMED" })).toBe(false);
  });

  it("refuses a no-op method change and rewriting a UPI claim under review", () => {
    expect(
      canChangePaymentMethod({
        orderStatus: "ACCEPTED",
        paymentStatus: "PAYMENT_PENDING",
        currentMethod: "UPI",
        nextMethod: "UPI",
      }).ok
    ).toBe(false);

    const locked = canChangePaymentMethod({
      orderStatus: "ACCEPTED",
      paymentStatus: "PAYMENT_UNDER_REVIEW",
      currentMethod: "UPI",
      nextMethod: "CASH_ON_DELIVERY",
    });
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.status).toBe(409);
  });

  it("allows switching to cash while nothing has been submitted", () => {
    expect(
      canChangePaymentMethod({
        orderStatus: "ACCEPTED",
        paymentStatus: "PAYMENT_PENDING",
        currentMethod: null,
        nextMethod: "CASH_ON_DELIVERY",
      }).ok
    ).toBe(true);
  });

  it("requires UPI to be selected before a reference can be submitted", () => {
    expect(
      canStudentSubmitUpiReference({
        orderStatus: "ACCEPTED",
        paymentStatus: "PAYMENT_PENDING",
        paymentMethod: "CASH_ON_DELIVERY",
      }).ok
    ).toBe(false);
    expect(
      canStudentSubmitUpiReference({
        orderStatus: "ACCEPTED",
        paymentStatus: "PAYMENT_PENDING",
        paymentMethod: "UPI",
      }).ok
    ).toBe(true);
  });

  it("never accepts a second reference while one is under review or already paid", () => {
    for (const paymentStatus of ["PAYMENT_UNDER_REVIEW", "PAYMENT_PROOF_SUBMITTED", "PAYMENT_CONFIRMED"]) {
      expect(
        canStudentSubmitUpiReference({
          orderStatus: "ACCEPTED",
          paymentStatus,
          paymentMethod: "UPI",
        }).ok
      ).toBe(false);
    }
    expect(
      canStudentSubmitUpiReference({
        orderStatus: "ORDER_RECEIVED",
        paymentStatus: "PAYMENT_PENDING",
        paymentMethod: "UPI",
      }).ok
    ).toBe(false);
  });

  it("lets a student resubmit after a rejected claim", () => {
    expect(
      canStudentSubmitUpiReference({
        orderStatus: "ACCEPTED",
        paymentStatus: "PAYMENT_REJECTED",
        paymentMethod: "UPI",
      }).ok
    ).toBe(true);
  });

  it("blocks verification when no money can actually have arrived", () => {
    const base = {
      orderStatus: "ACCEPTED",
      paymentStatus: "PAYMENT_PENDING",
      paymentMethod: "CASH_ON_DELIVERY" as string | null,
      paymentRef: null as string | null,
    };
    expect(canAdminVerifyPayment(base).ok).toBe(true); // cash at pickup
    expect(canAdminVerifyPayment({ ...base, orderStatus: "ORDER_RECEIVED" }).ok).toBe(false);
    expect(canAdminVerifyPayment({ ...base, paymentMethod: null }).ok).toBe(false);
    expect(
      canAdminVerifyPayment({ ...base, paymentMethod: "UPI", paymentStatus: "PAYMENT_PENDING" }).ok
    ).toBe(false);
    expect(
      canAdminVerifyPayment({
        ...base,
        paymentMethod: "UPI",
        paymentStatus: "PAYMENT_UNDER_REVIEW",
        paymentRef: "UPI123456",
      }).ok
    ).toBe(true);
    expect(
      canAdminVerifyPayment({ ...base, paymentStatus: "PAYMENT_CONFIRMED" }).ok
    ).toBe(false);
  });

  it("allows confirming cash after delivery but not cancelling a claim without a reason", () => {
    expect(
      canAdminVerifyPayment({
        orderStatus: "DELIVERED",
        paymentStatus: "PAYMENT_PENDING",
        paymentMethod: "CASH_ON_DELIVERY",
        paymentRef: null,
      }).ok
    ).toBe(true);

    expect(canAdminRejectPayment({ paymentStatus: "PAYMENT_PENDING", reason: "checked statement" }).ok).toBe(false);
    expect(canAdminRejectPayment({ paymentStatus: "PAYMENT_UNDER_REVIEW", reason: "no" }).ok).toBe(false);
    expect(canAdminRejectPayment({ paymentStatus: "PAYMENT_UNDER_REVIEW", reason: "not in statement" }).ok).toBe(true);
  });
});

describe("UPI reference normalization", () => {
  it("normalizes case and surrounding whitespace", () => {
    expect(normalizeUpiReference("  upi-2026/001_a  ")).toEqual({ ok: true, value: "UPI-2026/001_A" });
  });

  it("rejects empty, too short, too long and markup/control input", () => {
    for (const raw of ["", "   ", "ab", "<script>alert(1)</script>", "UPI 123", "UPI\n1234", "A".repeat(65)]) {
      expect(normalizeUpiReference(raw).ok).toBe(false);
    }
    expect(normalizeUpiReference(12345).ok).toBe(false);
    expect(normalizeUpiReference(null).ok).toBe(false);
  });

  it("masks all but the last four characters", () => {
    expect(maskReference("UPI-2026-0001234567")).toBe("••••••••4567");
    expect(maskReference("ABCD")).toBe("ABCD");
    expect(maskReference(null)).toBe("—");
    // Length is not leaked once the reference is longer than 8 hidden chars.
    expect(maskReference("ABCDEFGH12345678")).toBe("••••••••5678");
  });
});

// ---------------------------------------------------------------------------
// Service layer over an in-memory Prisma stand-in.
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  userId: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string | null;
  paymentRef: string | null;
  paymentProofAt: Date | null;
  paymentVerifiedBy: string | null;
  paymentVerifiedAt: Date | null;
  paymentNote: string | null;
  totalAmount: number;
};

let row: Row;
let paymentEvents: any[];
let orderEvents: any[];
let audits: any[];
let conflictNext: boolean;
let notifications: string[];

let verifyPayment: typeof import("@/server/payments").verifyPayment;
let rejectPayment: typeof import("@/server/payments").rejectPayment;
let submitUpiReference: typeof import("@/server/payments").submitUpiReference;
let selectPaymentMethod: typeof import("@/server/payments").selectPaymentMethod;

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: ORDER,
    userId: STUDENT,
    orderNumber: "XE-2026-000001",
    status: "ACCEPTED",
    paymentStatus: "PAYMENT_PENDING",
    paymentMethod: null,
    paymentRef: null,
    paymentProofAt: null,
    paymentVerifiedBy: null,
    paymentVerifiedAt: null,
    paymentNote: null,
    totalAmount: 240.5,
    ...overrides,
  };
}

async function load() {
  vi.resetModules();
  paymentEvents = [];
  orderEvents = [];
  audits = [];
  notifications = [];
  conflictNext = false;

  vi.doMock("@/lib/prisma", () => ({
    prisma: {
      order: {
        findUnique: vi.fn(async () => ({ ...row })),
        findMany: vi.fn(async () => [{ id: ADMIN }]),
      },
      user: { findMany: vi.fn(async () => [{ id: ADMIN }]) },
      $transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => {
        const stagedPayments: any[] = [];
        const stagedOrders: any[] = [];
        const tx = {
          order: {
            updateMany: vi.fn(async (args: any) => {
              if (conflictNext) return { count: 0 };
              // Apply the documented predicates faithfully.
              if (args.where.status?.in && !args.where.status.in.includes(row.status)) return { count: 0 };
              if (args.where.paymentStatus?.in && !args.where.paymentStatus.in.includes(row.paymentStatus)) {
                return { count: 0 };
              }
              if (args.where.paymentMethod === "UPI" && row.paymentMethod !== "UPI") return { count: 0 };
              if (args.where.paymentMethod?.not === null && row.paymentMethod === null) return { count: 0 };
              if (args.where.paymentRef?.not === null && row.paymentRef === null) return { count: 0 };
              Object.assign(row, args.data);
              return { count: 1 };
            }),
          },
          paymentEvent: {
            create: vi.fn(async (args: any) => {
              stagedPayments.push(args.data);
              return args.data;
            }),
          },
          orderEvent: {
            create: vi.fn(async (args: any) => {
              stagedOrders.push(args.data);
              return args.data;
            }),
          },
        };
        const result = await fn(tx);
        // Commit only when the callback resolves without throwing.
        paymentEvents.push(...stagedPayments);
        orderEvents.push(...stagedOrders);
        return result;
      }),
    },
  }));

  vi.doMock("@/server/audit", () => ({
    audit: vi.fn(async (entry: any) => {
      audits.push(entry);
    }),
  }));

  vi.doMock("@/server/notifications", () => ({
    notify: vi.fn(async () => undefined),
    NOTIFY: {
      paymentSubmitted: vi.fn(async () => notifications.push("submitted")),
      paymentConfirmed: vi.fn(async () => notifications.push("confirmed")),
      paymentRejected: vi.fn(async () => notifications.push("rejected")),
    },
  }));

  const mod = await import("@/server/payments");
  verifyPayment = mod.verifyPayment;
  rejectPayment = mod.rejectPayment;
  submitUpiReference = mod.submitUpiReference;
  selectPaymentMethod = mod.selectPaymentMethod;
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  await expect(promise).rejects.toMatchObject({ status });
}

beforeEach(async () => {
  row = makeRow();
  await load();
});

describe("selectPaymentMethod", () => {
  it("records cash as the method but leaves payment pending", async () => {
    const result = await selectPaymentMethod({ orderId: ORDER, userId: STUDENT, method: "CASH_ON_DELIVERY" });

    expect(result).toEqual({ method: "CASH_ON_DELIVERY" });
    expect(row.paymentMethod).toBe("CASH_ON_DELIVERY");
    expect(row.paymentStatus).toBe("PAYMENT_PENDING");
    expect(row.status).toBe("ACCEPTED");
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0]).toMatchObject({ type: "METHOD_SELECTED", amount: 240.5 });
  });

  it("rejects another student's order and pre-acceptance orders", async () => {
    await expectStatus(selectPaymentMethod({ orderId: ORDER, userId: OTHER, method: "UPI" }), 403);

    row = makeRow({ status: "ORDER_RECEIVED" });
    await expectStatus(selectPaymentMethod({ orderId: ORDER, userId: STUDENT, method: "UPI" }), 409);
    expect(paymentEvents).toHaveLength(0);
  });

  it("returns 409 when the order changed in flight", async () => {
    conflictNext = true;
    await expectStatus(selectPaymentMethod({ orderId: ORDER, userId: STUDENT, method: "UPI" }), 409);
    expect(paymentEvents).toHaveLength(0);
  });
});

describe("submitUpiReference", () => {
  beforeEach(() => {
    row = makeRow({ paymentMethod: "UPI" });
  });

  it("stores the claim as UNDER_REVIEW, never as paid", async () => {
    const result = await submitUpiReference({ orderId: ORDER, userId: STUDENT, reference: " upi-123456 " });

    expect(result.reference).toBe("UPI-123456");
    expect(row.paymentStatus).toBe("PAYMENT_UNDER_REVIEW");
    expect(row.paymentRef).toBe("UPI-123456");
    expect(row.paymentVerifiedAt).toBeNull();
    expect(row.status).toBe("ACCEPTED");
    expect(paymentEvents[0]).toMatchObject({ type: "SUBMITTED", reference: "UPI-123456" });
    expect(orderEvents[0]).toMatchObject({ type: "PAYMENT_SUBMITTED" });
    expect(audits[0].metadata).toMatchObject({ referenceLast4: "3456" });
    expect(JSON.stringify(audits)).not.toContain("UPI-123456");
  });

  it("rejects invalid references before touching the database", async () => {
    await expectStatus(submitUpiReference({ orderId: ORDER, userId: STUDENT, reference: "<b>x</b>" }), 422);
    expect(row.paymentStatus).toBe("PAYMENT_PENDING");
    expect(paymentEvents).toHaveLength(0);
  });

  it("refuses a duplicate submission while under review (409)", async () => {
    await submitUpiReference({ orderId: ORDER, userId: STUDENT, reference: "UPI-AAAA" });
    await expectStatus(submitUpiReference({ orderId: ORDER, userId: STUDENT, reference: "UPI-BBBB" }), 409);
    expect(row.paymentRef).toBe("UPI-AAAA");
  });

  it("refuses a reference for another student's order", async () => {
    await expectStatus(submitUpiReference({ orderId: ORDER, userId: OTHER, reference: "UPI-AAAA" }), 403);
  });

  it("returns 409 on a concurrent change without writing an event", async () => {
    conflictNext = true;
    await expectStatus(submitUpiReference({ orderId: ORDER, userId: STUDENT, reference: "UPI-AAAA" }), 409);
    expect(paymentEvents).toHaveLength(0);
    expect(orderEvents).toHaveLength(0);
  });
});

describe("verifyPayment (admin only)", () => {
  it("refuses students", async () => {
    await expectStatus(
      verifyPayment({ orderId: ORDER, actorId: STUDENT, actorRole: "STUDENT", note: "" }),
      403
    );
    expect(row.paymentStatus).toBe("PAYMENT_PENDING");
  });

  it("cannot confirm a UPI payment with no submitted reference", async () => {
    row = makeRow({ paymentMethod: "UPI" });
    await expectStatus(verifyPayment({ orderId: ORDER, actorId: ADMIN, actorRole: "ADMIN" }), 409);
  });

  it("confirms an actual UPI claim and records who/when without moving the order", async () => {
    row = makeRow({
      paymentMethod: "UPI",
      paymentRef: "UPI-123456",
      paymentStatus: "PAYMENT_UNDER_REVIEW",
      paymentProofAt: new Date("2026-10-01T10:00:00Z"),
      status: "PRINTING",
    });

    await verifyPayment({ orderId: ORDER, actorId: ADMIN, actorRole: "ADMIN", note: "statement checked" });

    expect(row.paymentStatus).toBe("PAYMENT_CONFIRMED");
    expect(row.paymentVerifiedBy).toBe(ADMIN);
    expect(row.paymentVerifiedAt).toBeInstanceOf(Date);
    expect(row.paymentNote).toBe("statement checked");
    expect(row.status).toBe("PRINTING"); // printing lifecycle untouched
    expect(paymentEvents[0]).toMatchObject({ type: "VERIFIED", actorId: ADMIN, amount: 240.5 });
    expect(notifications).toContain("confirmed");
  });

  it("records cash received without inventing a UPI reference", async () => {
    row = makeRow({ paymentMethod: "CASH_ON_DELIVERY", status: "READY_FOR_PICKUP" });
    await verifyPayment({ orderId: ORDER, actorId: ADMIN, actorRole: "SUPER_ADMIN" });

    expect(row.paymentStatus).toBe("PAYMENT_CONFIRMED");
    expect(row.paymentRef).toBeNull();
    expect(paymentEvents[0]).toMatchObject({ type: "CASH_RECEIVED", reference: null });
  });

  it("refuses duplicate confirmation", async () => {
    row = makeRow({ paymentMethod: "CASH_ON_DELIVERY", paymentStatus: "PAYMENT_CONFIRMED" });
    await expectStatus(verifyPayment({ orderId: ORDER, actorId: ADMIN, actorRole: "ADMIN" }), 409);
    expect(paymentEvents).toHaveLength(0);
  });

  it("returns 409 and writes nothing when the payment changed concurrently", async () => {
    row = makeRow({ paymentMethod: "CASH_ON_DELIVERY" });
    conflictNext = true;
    await expectStatus(verifyPayment({ orderId: ORDER, actorId: ADMIN, actorRole: "ADMIN" }), 409);
    expect(paymentEvents).toHaveLength(0);
    expect(orderEvents).toHaveLength(0);
    expect(notifications).not.toContain("confirmed");
  });
});

describe("rejectPayment (admin only)", () => {
  beforeEach(() => {
    row = makeRow({
      paymentMethod: "UPI",
      paymentRef: "UPI-123456",
      paymentStatus: "PAYMENT_UNDER_REVIEW",
    });
  });

  it("requires a real reason", async () => {
    await expectStatus(rejectPayment({ orderId: ORDER, actorId: ADMIN, actorRole: "ADMIN", reason: " no " }), 422);
    expect(row.paymentStatus).toBe("PAYMENT_UNDER_REVIEW");
  });

  it("refuses students", async () => {
    await expectStatus(
      rejectPayment({ orderId: ORDER, actorId: STUDENT, actorRole: "STUDENT", reason: "not in statement" }),
      403
    );
  });

  it("records the reason, keeps the reference for history and lets the student resubmit", async () => {
    await rejectPayment({ orderId: ORDER, actorId: ADMIN, actorRole: "ADMIN", reason: "not in statement" });

    expect(row.paymentStatus).toBe("PAYMENT_REJECTED");
    expect(row.paymentNote).toBe("not in statement");
    expect(row.paymentRef).toBe("UPI-123456");
    expect(paymentEvents[0]).toMatchObject({ type: "REJECTED", note: "not in statement" });
    expect(notifications).toContain("rejected");

    const resubmission = await submitUpiReference({
      orderId: ORDER,
      userId: STUDENT,
      reference: "UPI-654321",
    });
    expect(resubmission.reference).toBe("UPI-654321");
    expect(row.paymentStatus).toBe("PAYMENT_UNDER_REVIEW");
  });

  it("cannot reject a payment that was never submitted", async () => {
    row = makeRow({ paymentStatus: "PAYMENT_PENDING" });
    await expectStatus(
      rejectPayment({ orderId: ORDER, actorId: ADMIN, actorRole: "ADMIN", reason: "not in statement" }),
      409
    );
    expect(paymentEvents).toHaveLength(0);
  });

  it("returns 409 on a concurrent decision and writes nothing", async () => {
    conflictNext = true;
    await expectStatus(
      rejectPayment({ orderId: ORDER, actorId: ADMIN, actorRole: "ADMIN", reason: "not in statement" }),
      409
    );
    expect(paymentEvents).toHaveLength(0);
    expect(notifications).not.toContain("rejected");
  });
});
