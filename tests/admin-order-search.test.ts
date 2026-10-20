// Admin order search — validated input, bounded pagination, admin-only route.
//
// Every query value is bound through Prisma; this file pins the validation layer
// (length, enum, calendar-date and range guards) and the route's authorization.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ADMIN_ORDER_SEARCH_MAX_PAGE_SIZE,
  adminOrderWhere,
  parseAdminOrderSearch,
} from "@/lib/admin-search";

function params(record: Record<string, string>) {
  return new URLSearchParams(record);
}

const ANY_UUID = "33333333-3333-4333-8333-333333333333";

describe("parseAdminOrderSearch", () => {
  it("accepts an empty query with safe defaults", () => {
    const result = parseAdminOrderSearch(params({}));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        q: "",
        status: null,
        paymentStatus: null,
        from: null,
        to: null,
        page: 1,
        pageSize: 20,
      });
    }
  });

  it("treats ALL as no filter", () => {
    const result = parseAdminOrderSearch(params({ status: "ALL", paymentStatus: "ALL" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBeNull();
      expect(result.value.paymentStatus).toBeNull();
    }
  });

  it("rejects over-long and control-character search text", () => {
    expect(parseAdminOrderSearch(params({ q: "x".repeat(101) })).ok).toBe(false);
    expect(parseAdminOrderSearch(params({ q: "XE\u0000-2026" })).ok).toBe(false);
    expect(parseAdminOrderSearch(params({ q: "line\nbreak" })).ok).toBe(false);
  });

  it("rejects unknown status filters", () => {
    expect(parseAdminOrderSearch(params({ status: "PAID_AND_HAPPY" })).ok).toBe(false);
    expect(parseAdminOrderSearch(params({ paymentStatus: "REFUNDED" })).ok).toBe(false);
    expect(parseAdminOrderSearch(params({ status: "ACCEPTED" })).ok).toBe(true);
    expect(parseAdminOrderSearch(params({ paymentStatus: "PAYMENT_CONFIRMED" })).ok).toBe(true);
  });

  it("requires YYYY-MM-DD and rejects impossible calendar dates", () => {
    expect(parseAdminOrderSearch(params({ from: "20-10-2026" })).ok).toBe(false);
    expect(parseAdminOrderSearch(params({ from: "2026-13-01" })).ok).toBe(false);
    expect(parseAdminOrderSearch(params({ from: "2026-02-31" })).ok).toBe(false);
    expect(parseAdminOrderSearch(params({ to: "2026-02-29" })).ok).toBe(false);
    expect(parseAdminOrderSearch(params({ from: "2026-02-28" })).ok).toBe(true);
  });

  it("rejects reversed and over-long date ranges", () => {
    expect(parseAdminOrderSearch(params({ from: "2026-10-20", to: "2026-10-01" })).ok).toBe(false);
    expect(parseAdminOrderSearch(params({ from: "2024-01-01", to: "2026-10-01" })).ok).toBe(false);
    expect(parseAdminOrderSearch(params({ from: "2025-10-01", to: "2026-10-01" })).ok).toBe(true);
  });

  it("clamps pagination instead of trusting the client", () => {
    const big = parseAdminOrderSearch(params({ page: "999999", pageSize: "100000" }));
    expect(big.ok).toBe(true);
    if (big.ok) {
      expect(big.value.pageSize).toBe(ADMIN_ORDER_SEARCH_MAX_PAGE_SIZE);
      expect(big.value.page).toBe(100_000);
    }

    const junk = parseAdminOrderSearch(params({ page: "abc", pageSize: "-5" }));
    expect(junk.ok).toBe(true);
    if (junk.ok) {
      expect(junk.value.page).toBe(1);
      expect(junk.value.pageSize).toBe(1);
    }
  });
});

describe("adminOrderWhere", () => {
  const base = {
    q: "",
    status: null,
    paymentStatus: null,
    from: null,
    to: null,
    page: 1,
    pageSize: 20,
  };

  it("adds an exact id match when the query is a UUID", () => {
    const where = adminOrderWhere({ ...base, q: ANY_UUID }) as any;
    expect(where.OR[0]).toEqual({ id: ANY_UUID });
    expect(JSON.stringify(where)).toContain("orderNumber");
  });

  it("searches order number, student name, email and registration number", () => {
    const where = adminOrderWhere({ ...base, q: "Asha" }) as any;
    const flat = JSON.stringify(where);
    expect(flat).toContain("orderNumber");
    expect(flat).toContain("name");
    expect(flat).toContain("email");
    expect(flat).toContain("regNo");
    expect(flat).not.toContain('"id"');
  });

  it("applies enum filters and an inclusive end-of-day date range", () => {
    const from = new Date("2026-10-01T00:00:00.000Z");
    const to = new Date("2026-10-20T00:00:00.000Z");
    const where = adminOrderWhere({ ...base, status: "ACCEPTED", paymentStatus: "PAYMENT_UNDER_REVIEW", from, to }) as any;

    expect(where.status).toBe("ACCEPTED");
    expect(where.paymentStatus).toBe("PAYMENT_UNDER_REVIEW");
    expect(where.createdAt.gte).toBe(from);
    expect(where.createdAt.lte.toISOString()).toBe("2026-10-20T23:59:59.999Z");
  });

  it("does not add an OR clause when no search text was supplied", () => {
    const where = adminOrderWhere(base) as any;
    expect(where.OR).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Route authorization + pagination contract.
// ---------------------------------------------------------------------------

let role = "ADMIN";
let capturedArgs: any[] = [];
let total = 0;

let route: typeof import("@/app/api/admin/orders/lookup/route");

async function load() {
  vi.resetModules();
  capturedArgs = [];

  vi.doMock("@/server/auth", () => ({
    requireRole: vi.fn(async (...roles: string[]) => {
      if (!roles.includes(role)) throw Object.assign(new Error("Forbidden"), { status: 403 });
      return { id: "admin-1", role };
    }),
  }));

  vi.doMock("@/server/rate-limit", () => ({
    RATE_LIMITS: { adminSearch: { limit: 60, windowMs: 60_000 } },
    rateLimitAsync: vi.fn(async () => ({ ok: true, retryAfterSec: 0, remaining: 59 })),
  }));

  vi.doMock("@/lib/prisma", () => ({
    prisma: {
      order: {
        count: vi.fn(async () => total),
        findMany: vi.fn(async (args: any) => {
          capturedArgs.push(args);
          return [
            {
              id: ANY_UUID,
              orderNumber: "XE-2026-000001",
              status: "ACCEPTED",
              paymentStatus: "PAYMENT_PENDING",
              paymentMethod: null,
              totalAmount: 240,
              totalPages: 30,
              copies: 2,
              colorMode: "BW",
              paperSize: "A4",
              createdAt: new Date("2026-10-19T10:00:00Z"),
              updatedAt: new Date("2026-10-19T11:00:00Z"),
              user: { name: "Asha", email: "asha@example.test", regNo: "R001", phone: "9000000000" },
              _count: { files: 2 },
            },
          ];
        }),
      },
    },
  }));

  route = await import("@/app/api/admin/orders/lookup/route");
}

beforeEach(async () => {
  role = "ADMIN";
  total = 1;
  await load();
});

describe("GET /api/admin/orders/lookup", () => {
  it("is admin-only", async () => {
    role = "STUDENT";
    const res = await route.GET(new Request("https://app.test/api/admin/orders/lookup?q=XE"));
    expect(res.status).toBe(403);
    expect(capturedArgs).toHaveLength(0);
  });

  it("returns 422 for invalid filters without querying", async () => {
    const res = await route.GET(
      new Request("https://app.test/api/admin/orders/lookup?from=2026-02-31")
    );
    expect(res.status).toBe(422);
    expect(capturedArgs).toHaveLength(0);
  });

  it("caps page size and reports pagination", async () => {
    total = 101;
    const res = await route.GET(
      new Request("https://app.test/api/admin/orders/lookup?pageSize=100000&page=2")
    );
    expect(res.status).toBe(200);

    expect(capturedArgs[0].take).toBe(50);
    expect(capturedArgs[0].skip).toBe(50);

    const body = (await res.json()) as any;
    expect(body).toMatchObject({ total: 101, page: 2, pageSize: 50, pageCount: 3 });
  });

  it("returns only summary fields (no storage keys or tokens)", async () => {
    const res = await route.GET(new Request("https://app.test/api/admin/orders/lookup?q=XE-2026"));
    const body = (await res.json()) as any;
    const serialized = JSON.stringify(body);

    expect(serialized).toContain("XE-2026-000001");
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain("storage_key");
    expect(serialized).not.toContain("collectionToken");
    expect(serialized).not.toContain("passwordHash");
  });
});
