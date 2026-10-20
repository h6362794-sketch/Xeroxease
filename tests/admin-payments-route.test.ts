// Admin payment desk routes.
//
// GET is admin-only and rejects unknown state tabs instead of silently returning
// every order. PATCH verify requires the explicit acknowledgement the schema
// documents and delegates to the service with the order id — never a client
// supplied amount or status.

import { describe, it, expect, beforeEach, vi } from "vitest";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const ORDER = "33333333-3333-4333-8333-333333333333";

let session: { id: string; role: string } | null = { id: ADMIN, role: "ADMIN" };
let whereArgs: any[] = [];
let verifyCalls: any[] = [];
let rejectCalls: any[] = [];

let listRoute: typeof import("@/app/api/admin/payments/route");
let verifyRoute: typeof import("@/app/api/admin/payments/[id]/verify/route");
let rejectRoute: typeof import("@/app/api/admin/payments/[id]/reject/route");

async function load() {
  vi.resetModules();
  whereArgs = [];
  verifyCalls = [];
  rejectCalls = [];

  vi.doMock("@/server/auth", () => ({
    getSessionUser: vi.fn(async () => session),
    isAdminRole: (role: string) => role === "ADMIN" || role === "SUPER_ADMIN",
    requireRole: vi.fn(async (...roles: string[]) => {
      if (!session || !roles.includes(session.role)) {
        throw Object.assign(new Error("Forbidden"), { status: 403 });
      }
      return session;
    }),
  }));

  vi.doMock("@/server/rate-limit", () => ({
    RATE_LIMITS: { admin: { limit: 60, windowMs: 60_000 } },
    rateLimitAsync: vi.fn(async () => ({ ok: true, retryAfterSec: 0, remaining: 59 })),
  }));

  vi.doMock("@/lib/prisma", () => ({
    prisma: {
      order: {
        count: vi.fn(async (args: any) => {
          whereArgs.push(args.where);
          return 3;
        }),
        findMany: vi.fn(async (args: any) => [
          {
            id: ORDER,
            orderNumber: "XE-2026-000001",
            user: { name: "Asha", regNo: "R001", email: "asha@example.test", phone: "9000000000" },
            totalAmount: "240.50",
            status: "ACCEPTED",
            paymentMethod: "UPI",
            paymentRef: "UPI-123456",
            paymentProofAt: new Date("2026-10-19T10:30:00Z"),
            paymentStatus: "PAYMENT_UNDER_REVIEW",
            paymentNote: null,
            paymentVerifiedAt: null,
            createdAt: new Date("2026-10-19T10:00:00Z"),
          },
        ]),
      },
    },
  }));

  vi.doMock("@/server/payments", () => ({
    verifyPayment: vi.fn(async (args: any) => {
      verifyCalls.push(args);
    }),
    rejectPayment: vi.fn(async (args: any) => {
      rejectCalls.push(args);
    }),
  }));

  listRoute = await import("@/app/api/admin/payments/route");
  verifyRoute = await import("@/app/api/admin/payments/[id]/verify/route");
  rejectRoute = await import("@/app/api/admin/payments/[id]/reject/route");
}

function patch(body: unknown) {
  return new Request(`https://app.test/api/admin/payments/${ORDER}/verify`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  session = { id: ADMIN, role: "ADMIN" };
  await load();
});

describe("GET /api/admin/payments", () => {
  it("is admin-only", async () => {
    session = null;
    expect((await listRoute.GET(new Request("https://app.test/api/admin/payments"))).status).toBe(403);

    session = { id: "student-1", role: "STUDENT" };
    expect((await listRoute.GET(new Request("https://app.test/api/admin/payments"))).status).toBe(403);
    expect(whereArgs).toHaveLength(0);
  });

  it("rejects an unknown state instead of returning every order", async () => {
    const res = await listRoute.GET(
      new Request("https://app.test/api/admin/payments?state=SOMETHING_ELSE")
    );
    expect(res.status).toBe(400);
    expect(whereArgs).toHaveLength(0);
  });

  it("filters the review desk to submitted/under-review payments", async () => {
    const res = await listRoute.GET(
      new Request("https://app.test/api/admin/payments?state=PENDING_REVIEW")
    );
    expect(res.status).toBe(200);
    expect(whereArgs[0]).toEqual({
      paymentStatus: { in: ["PAYMENT_PROOF_SUBMITTED", "PAYMENT_UNDER_REVIEW"] },
    });

    const body = (await res.json()) as any;
    expect(body).toMatchObject({ total: 3, page: 1, pageSize: 50 });
    expect(body.orders[0]).toMatchObject({
      id: ORDER,
      amount: 240.5,
      orderStatus: "ACCEPTED",
      paymentStatus: "PAYMENT_UNDER_REVIEW",
    });
  });

  it("filters cash-at-pickup separately", async () => {
    await listRoute.GET(new Request("https://app.test/api/admin/payments?state=AWAITING_CASH"));
    expect(whereArgs[0]).toEqual({
      paymentMethod: "CASH_ON_DELIVERY",
      paymentStatus: "PAYMENT_PENDING",
    });
  });

  it("bounds page size", async () => {
    const res = await listRoute.GET(
      new Request("https://app.test/api/admin/payments?pageSize=100000&page=2")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.pageSize).toBe(100);
    expect(body.page).toBe(2);
  });
});

describe("PATCH /api/admin/payments/:id/verify", () => {
  it("is admin-only", async () => {
    session = { id: "student-1", role: "STUDENT" };
    const res = await verifyRoute.PATCH(patch({ confirm: true }), {
      params: Promise.resolve({ id: ORDER }),
    });
    expect(res.status).toBe(403);
    expect(verifyCalls).toHaveLength(0);
  });

  it("requires an explicit confirmation flag", async () => {
    const res = await verifyRoute.PATCH(patch({ note: "checked" }), {
      params: Promise.resolve({ id: ORDER }),
    });
    expect(res.status).toBe(422);
    expect(verifyCalls).toHaveLength(0);
  });

  it("delegates with the order id and authenticated actor", async () => {
    const res = await verifyRoute.PATCH(patch({ note: "checked", confirm: true }), {
      params: Promise.resolve({ id: ORDER }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, paymentStatus: "PAYMENT_CONFIRMED" });
    expect(verifyCalls).toEqual([
      { orderId: ORDER, actorId: ADMIN, actorRole: "ADMIN", note: "checked" },
    ]);
  });

  it("rejects malformed ids", async () => {
    const res = await verifyRoute.PATCH(patch({ confirm: true }), {
      params: Promise.resolve({ id: "../etc" }),
    });
    expect(res.status).toBe(400);
    expect(verifyCalls).toHaveLength(0);
  });
});

describe("PATCH /api/admin/payments/:id/reject", () => {
  it("requires a real reason", async () => {
    const res = await rejectRoute.PATCH(patch({ reason: "no" }), {
      params: Promise.resolve({ id: ORDER }),
    });
    expect(res.status).toBe(422);
    expect(rejectCalls).toHaveLength(0);
  });

  it("delegates with the trimmed reason", async () => {
    const res = await rejectRoute.PATCH(patch({ reason: "  not in statement  " }), {
      params: Promise.resolve({ id: ORDER }),
    });
    expect(res.status).toBe(200);
    expect(rejectCalls[0]).toMatchObject({
      orderId: ORDER,
      actorId: ADMIN,
      reason: "not in statement",
    });
  });

  it("is admin-only", async () => {
    session = null;
    const res = await rejectRoute.PATCH(patch({ reason: "not in statement" }), {
      params: Promise.resolve({ id: ORDER }),
    });
    expect(res.status).toBe(403);
    expect(rejectCalls).toHaveLength(0);
  });
});
