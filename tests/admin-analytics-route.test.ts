// GET /api/admin/analytics — pool-pressure and failure-handling contract.
//
// The production symptom this file pins: repeated requests failed with Prisma
// connection-pool timeouts (P2024) while the configured pool had a single
// connection. One request issued fifteen queries in a single Promise.all, so
// fourteen of them were pool waiters on every poll. The route now submits them
// through `runWithDbConcurrency`, which keeps the queue bounded no matter what
// `connection_limit` the deployment uses.

import { describe, it, expect, beforeEach, vi } from "vitest";

const ADMIN = "11111111-1111-4111-8111-111111111111";

let session: { id: string; role: string } | null = { id: ADMIN, role: "ADMIN" };
let failWith: Error | null = null;

let inFlight = 0;
let peak = 0;

/** A query stand-in that measures how many Prisma calls overlap. */
function query<T>(value: T): Promise<T> {
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      inFlight -= 1;
      if (failWith) reject(failWith);
      else resolve(value);
    }, 3);
  });
}

type Route = typeof import("@/app/api/admin/analytics/route");
let route: Route;

async function load() {
  vi.resetModules();
  peak = 0;
  inFlight = 0;

  vi.doMock("@/server/auth", () => ({
    getSessionUser: vi.fn(async () => session),
    isAdminRole: (role: string) => role === "ADMIN" || role === "SUPER_ADMIN",
    requireUser: vi.fn(async () => {
      if (!session) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      return session;
    }),
  }));

  vi.doMock("@/lib/prisma", () => ({
    prisma: {
      order: {
        count: vi.fn(async () => query(7)),
        aggregate: vi.fn(async (args: any) =>
          args._sum.totalAmount
            ? query({ _sum: { totalAmount: 1234.5 } })
            : query({ _sum: { billablePages: 42 } })
        ),
        groupBy: vi.fn(async (args: any) =>
          args.by.includes("status")
            ? query([
                { status: "COMPLETED", _count: 3 },
                { status: "PRINTING", _count: 2 },
              ])
            : query([{ colorMode: "BW", _count: 5 }])
        ),
      },
      feedback: {
        aggregate: vi.fn(async () => query({ _avg: { rating: 4.25 }, _count: 8 })),
        findMany: vi.fn(async () =>
          query([
            {
              id: "fb-1",
              rating: 5,
              comment: "Great",
              createdAt: new Date("2026-10-15T10:00:00.000Z"),
              order: { orderNumber: "XE-2026-000007" },
            },
          ])
        ),
      },
    },
  }));

  route = await import("@/app/api/admin/analytics/route");
}

beforeEach(async () => {
  session = { id: ADMIN, role: "ADMIN" };
  failWith = null;
  await load();
});

describe("GET /api/admin/analytics", () => {
  it("rejects anonymous and non-admin callers before querying", async () => {
    session = null;
    expect((await route.GET()).status).toBe(403);

    session = { id: ADMIN, role: "STUDENT" };
    expect((await route.GET()).status).toBe(403);
    expect(inFlight).toBe(0);
    expect(peak).toBe(0);
  });

  it("answers the dashboard with the full payload", async () => {
    const res = await route.GET();
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.cards).toMatchObject({
      totalOrders: 7,
      revenue: 1234.5,
      pagesToday: 42,
      avgRating: 4.25,
      feedbackCount: 8,
    });
    expect(body.recentFeedback).toEqual([
      {
        id: "fb-1",
        rating: 5,
        comment: "Great",
        orderNumber: "XE-2026-000007",
        createdAt: "2026-10-15T10:00:00.000Z",
      },
    ]);
    expect(body.statusDistribution).toEqual([
      { status: "COMPLETED", count: 3 },
      { status: "PRINTING", count: 2 },
    ]);
    expect(body.colourSplit).toEqual([{ colorMode: "BW", count: 5 }]);
  });

  it("bounds concurrent database queries even on a one-connection pool", async () => {
    await route.GET();
    // Fifteen queries in total, never more than the documented batch size at once.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("turns a pool timeout into a 503 without leaking the connection string", async () => {
    failWith = Object.assign(
      new Error(
        "Timed out fetching a new connection from the connection pool: postgresql://postgres:secret@aws-0.pooler.supabase.com:6543/postgres"
      ),
      { code: "P2024" }
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const res = await route.GET();
      expect(res.status).toBe(503);

      const body = await res.json();
      expect(body).toMatchObject({ error: expect.any(String), code: "SERVICE_UNAVAILABLE" });

      const serialised = JSON.stringify(body);
      for (const leak of ["postgresql://", "secret", "P2024", "pooler.supabase.com", "Timed out"]) {
        expect(serialised).not.toContain(leak);
      }

      // Full detail stays in the server log, behind a correlation id.
      expect(consoleError).toHaveBeenCalled();
      const correlation = consoleError.mock.calls.some(
        (call) => typeof call[1] === "object" && call[1] !== null && "requestId" in (call[1] as object)
      );
      expect(correlation).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });
});
