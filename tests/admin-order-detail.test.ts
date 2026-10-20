// GET /api/admin/orders/:id — authorized full detail, no storage secrets.
//
// The detail screen is the only place an administrator sees a student's order in
// full, so the contract is pinned here: admin-only, canonical next transitions,
// resolved actor names, payment history as numbers, and never a storage key,
// collection-token hash or unrelated student record.

import { describe, it, expect, beforeEach, vi } from "vitest";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const ORDER = "33333333-3333-4333-8333-333333333333";

let role = "ADMIN";
let order: any;

let route: typeof import("@/app/api/admin/orders/[id]/route");

async function load() {
  vi.resetModules();

  vi.doMock("@/server/auth", () => ({
    requireRole: vi.fn(async (...roles: string[]) => {
      if (!roles.includes(role)) throw Object.assign(new Error("Forbidden"), { status: 403 });
      return { id: ADMIN, role };
    }),
  }));

  vi.doMock("@/server/rate-limit", () => ({
    RATE_LIMITS: { admin: { limit: 60, windowMs: 60_000 } },
    rateLimitAsync: vi.fn(async () => ({ ok: true, retryAfterSec: 0, remaining: 59 })),
  }));

  vi.doMock("@/lib/prisma", () => ({
    prisma: {
      order: { findUnique: vi.fn(async () => order) },
      user: {
        findMany: vi.fn(async () => [
          { id: "admin-1", name: "Desk Admin", role: "ADMIN" },
          { id: "student-1", name: "Asha", role: "STUDENT" },
        ]),
      },
    },
  }));

  route = await import("@/app/api/admin/orders/[id]/route");
}

function request(id = ORDER) {
  return new Request(`https://app.test/api/admin/orders/${id}`);
}

beforeEach(async () => {
  role = "ADMIN";
  order = {
    id: ORDER,
    orderNumber: "XE-2026-000001",
    userId: "student-1",
    status: "ORDER_RECEIVED",
    paymentStatus: "PAYMENT_PENDING",
    paymentMethod: null,
    paymentRef: null,
    paymentProofAt: null,
    paymentVerifiedBy: null,
    paymentVerifiedAt: null,
    paymentNote: null,
    createdAt: new Date("2026-10-19T10:00:00Z"),
    updatedAt: new Date("2026-10-19T11:00:00Z"),
    acceptedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    deliveredAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
    adminNotes: null,
    totalAmount: "240.50",
    pricePerPage: "2.00",
    finishingFee: "5.00",
    pricingSnapshot: { version: 1, applied: { total: 240.5 } },
    finishingOptions: ["STAPLE"],
    totalPages: 30,
    billablePages: 30,
    paperSize: "A4",
    colorMode: "BW",
    sides: "SINGLE",
    copies: 1,
    pageSelection: "ALL",
    customPages: null,
    collectionTokenHash: "super-secret-hash",
    user: {
      id: "student-1",
      name: "Asha",
      email: "asha@example.test",
      regNo: "R001",
      phone: "9000000000",
      branch: "CSE",
      section: "A",
      year: 3,
    },
    files: [
      {
        id: "file-1",
        originalName: "Assignment.pdf",
        mimeType: "application/pdf",
        sizeBytes: 12345,
        status: "COMPLETED",
        pageCount: 30,
        pageCountSource: "DOCUMENT_PARSER",
        analysisStatus: "COMPLETED",
        analysisError: null,
        analyzedAt: new Date("2026-10-19T10:05:00Z"),
        createdAt: new Date("2026-10-19T10:01:00Z"),
      },
    ],
    events: [
      {
        id: "event-1",
        type: "STATUS_CHANGE",
        fromStatus: null,
        toStatus: "ORDER_RECEIVED",
        message: null,
        actorId: "student-1",
        actorRole: "STUDENT",
        createdAt: new Date("2026-10-19T10:00:00Z"),
      },
    ],
    payments: [
      {
        id: "pay-1",
        type: "SUBMITTED",
        amount: "240.50",
        reference: "UPI-123456",
        note: null,
        actorRole: "STUDENT",
        createdAt: new Date("2026-10-19T10:30:00Z"),
        actor: { id: "student-1", name: "Asha" },
      },
    ],
    feedback: null,
  };
  await load();
});

describe("GET /api/admin/orders/:id", () => {
  it("is admin-only", async () => {
    role = "STUDENT";
    const res = await route.GET(request(), { params: Promise.resolve({ id: ORDER }) });
    expect(res.status).toBe(403);
  });

  it("rejects malformed ids and missing orders", async () => {
    let res = await route.GET(request(), { params: Promise.resolve({ id: "../etc/passwd" }) });
    expect(res.status).toBe(400);

    order = null;
    res = await route.GET(request(), { params: Promise.resolve({ id: ORDER }) });
    expect(res.status).toBe(404);
  });

  it("returns the full authorized record with canonical transitions", async () => {
    const res = await route.GET(request(), { params: Promise.resolve({ id: ORDER }) });
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.order).toMatchObject({
      id: ORDER,
      orderNumber: "XE-2026-000001",
      statusLabel: "Order Received",
      stageIndex: 0,
      allowedNextStatuses: ["ACCEPTED", "REJECTED", "CANCELLED"],
      totalAmount: 240.5,
      pricePerPage: 2,
      finishingFee: 5,
      student: { name: "Asha", regNo: "R001" },
    });

    expect(body.order.files).toEqual([
      expect.objectContaining({
        id: "file-1",
        originalName: "Assignment.pdf",
        pageCount: 30,
        pageCountVerified: true,
      }),
    ]);
    expect(body.order.statusHistory[0]).toMatchObject({ actorId: "student-1", actorName: "Asha" });
    expect(body.order.payment.history[0]).toMatchObject({ type: "SUBMITTED", amount: 240.5 });
  });

  it("never leaks storage keys, token hashes or unrelated student password data", async () => {
    const res = await route.GET(request(), { params: Promise.resolve({ id: ORDER }) });
    const serialized = JSON.stringify(await res.json());

    expect(serialized).not.toContain("collectionTokenHash");
    expect(serialized).not.toContain("super-secret-hash");
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("SESSION_SECRET");
  });

  it("offers only valid next transitions at each stage and none when terminal", async () => {
    order = { ...order, status: "READY_FOR_PICKUP" };
    let body = (await (await route.GET(request(), { params: Promise.resolve({ id: ORDER }) })).json()) as any;
    expect(body.order.allowedNextStatuses).toEqual(["DELIVERED"]);
    expect(body.order.stageIndex).toBe(3);

    order = { ...order, status: "DELIVERED" };
    body = (await (await route.GET(request(), { params: Promise.resolve({ id: ORDER }) })).json()) as any;
    expect(body.order.allowedNextStatuses).toEqual([]);
    expect(body.order.stageIndex).toBe(4);
  });
});
