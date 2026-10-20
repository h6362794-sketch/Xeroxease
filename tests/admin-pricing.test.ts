// Admin-managed pricing.
//
// Invariants:
//   * only SUPER_ADMIN may write (ADMIN can read, students cannot);
//   * values are finite, non-negative, bounded and 2-dp;
//   * the write is conditional on the previous value and audited in the SAME
//     transaction;
//   * existing orders are never touched, so past totals cannot change.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { pricingUpdateSchema } from "@/server/validation";

describe("pricingUpdateSchema", () => {
  const validate = (items: unknown[]) => pricingUpdateSchema.safeParse({ items });

  it("accepts valid prices", () => {
    expect(validate([{ key: "A4_BW", unitPrice: 2.25 }]).success).toBe(true);
    expect(validate([{ key: "STAPLE", unitPrice: "5" }]).success).toBe(true);
    expect(validate([{ key: "A4_BW", unitPrice: 0 }]).success).toBe(true);
  });

  it("rejects negative, unbounded, non-finite and sub-cent values", () => {
    expect(validate([{ key: "A4_BW", unitPrice: -1 }]).success).toBe(false);
    expect(validate([{ key: "A4_BW", unitPrice: 10001 }]).success).toBe(false);
    expect(validate([{ key: "A4_BW", unitPrice: "abc" }]).success).toBe(false);
    expect(validate([{ key: "A4_BW", unitPrice: 2.001 }]).success).toBe(false);
  });

  it("rejects empty payloads, oversized payloads and duplicate keys", () => {
    expect(validate([]).success).toBe(false);
    expect(
      validate(Array.from({ length: 51 }, (_, i) => ({ key: `KEY_${i}`, unitPrice: 1 }))).success
    ).toBe(false);
    expect(
      validate([
        { key: "A4_BW", unitPrice: 2 },
        { key: "A4_BW", unitPrice: 3 },
      ]).success
    ).toBe(false);
  });

  it("validates the key and isActive flag", () => {
    expect(validate([{ key: "x", unitPrice: 1 }]).success).toBe(false);
    expect(validate([{ key: "A4_BW", unitPrice: 1, isActive: "yes" }]).success).toBe(false);
    expect(validate([{ key: "A4_BW", unitPrice: 1, isActive: false }]).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route contract.
// ---------------------------------------------------------------------------

type PriceRow = { key: string; label: string; category: string; unit: string; unitPrice: number; isActive: boolean };

let role = "SUPER_ADMIN";
let rows: PriceRow[];
let stagedPrices: Array<{ key: string; unitPrice: number; isActive: boolean; updatedBy: string }>;
let stagedAudits: any[];
let conflictKey: string | null;
/** Proves the route never reaches the order table. */
let orderTouched: boolean;

let route: typeof import("@/app/api/admin/pricing/route");

async function load() {
  vi.resetModules();
  stagedPrices = [];
  stagedAudits = [];
  conflictKey = null;
  orderTouched = false;

  vi.doMock("@/server/auth", () => ({
    requireRole: vi.fn(async (...roles: string[]) => {
      if (!roles.includes(role)) throw Object.assign(new Error("Forbidden"), { status: 403 });
      return { id: "super-1", role };
    }),
  }));

  vi.doMock("@/server/rate-limit", () => ({
    RATE_LIMITS: { admin: { limit: 60, windowMs: 60_000 } },
    rateLimitAsync: vi.fn(async () => ({ ok: true, retryAfterSec: 0, remaining: 59 })),
  }));

  vi.doMock("@/lib/prisma", () => ({
    prisma: {
      pricingConfig: { findMany: vi.fn(async () => rows.map((r) => ({ ...r }))) },
      order: {
        findMany: vi.fn(async () => {
          orderTouched = true;
          return [];
        }),
        update: vi.fn(async () => {
          orderTouched = true;
          return {};
        }),
      },
      auditLog: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => {
        const tx = {
          pricingConfig: {
            updateMany: vi.fn(async (args: any) => {
              const row = rows.find((r) => r.key === args.where.key);
              if (!row) return { count: 0 };
              if (args.where.unitPrice !== row.unitPrice || args.where.isActive !== row.isActive) {
                return { count: 0 };
              }
              if (conflictKey === row.key) return { count: 0 };
              stagedPrices.push({ ...args.data });
              Object.assign(row, args.data);
              return { count: 1 };
            }),
          },
          auditLog: {
            create: vi.fn(async (args: any) => {
              stagedAudits.push(args.data);
              return args.data;
            }),
          },
        };
        const result = await fn(tx);
        return result;
      }),
    },
  }));

  route = await import("@/app/api/admin/pricing/route");
}

function patch(body: unknown) {
  return new Request("https://app.test/api/admin/pricing", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  role = "SUPER_ADMIN";
  rows = [
    { key: "A4_BW", label: "A4 B&W", category: "PRINT", unit: "page", unitPrice: 2, isActive: true },
    { key: "STAPLE", label: "Staple", category: "FINISHING", unit: "item", unitPrice: 5, isActive: true },
  ];
  await load();
});

describe("PATCH /api/admin/pricing", () => {
  it("refuses ADMIN and students", async () => {
    role = "ADMIN";
    let res = await route.PATCH(patch({ items: [{ key: "A4_BW", unitPrice: 3 }] }));
    expect(res.status).toBe(403);
    expect(stagedPrices).toHaveLength(0);

    role = "STUDENT";
    res = await route.PATCH(patch({ items: [{ key: "A4_BW", unitPrice: 3 }] }));
    expect(res.status).toBe(403);
  });

  it("rejects unknown keys with 422 and writes nothing", async () => {
    const res = await route.PATCH(
      patch({ items: [{ key: "A4_BW", unitPrice: 3 }, { key: "GOLD_LEAF", unitPrice: 9 }] })
    );
    expect(res.status).toBe(422);
    expect(stagedPrices).toHaveLength(0);
    expect(stagedAudits).toHaveLength(0);
  });

  it("is a no-op when nothing changed", async () => {
    const res = await route.PATCH(patch({ items: [{ key: "A4_BW", unitPrice: 2 }] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ ok: true, updated: 0, changes: [] });
    expect(stagedPrices).toHaveLength(0);
    expect(stagedAudits).toHaveLength(0);
  });

  it("updates, records previous and new values, and does not touch orders", async () => {
    const res = await route.PATCH(
      patch({ items: [{ key: "A4_BW", unitPrice: 3.5 }, { key: "STAPLE", unitPrice: 5 }] })
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.updated).toBe(1);
    expect(body.changes).toEqual([
      {
        key: "A4_BW",
        from: 2,
        to: 3.5,
        activeFrom: true,
        activeTo: true,
        changed: true,
      },
    ]);

    expect(stagedPrices).toEqual([{ unitPrice: 3.5, isActive: true, updatedBy: "super-1" }]);
    expect(stagedAudits).toHaveLength(1);
    expect(stagedAudits[0]).toMatchObject({
      actorId: "super-1",
      actorRole: "SUPER_ADMIN",
      action: "PRICING_UPDATED",
      targetType: "PRICING",
    });
    expect(stagedAudits[0].metadata.changes).toEqual([
      { key: "A4_BW", from: 2, to: 3.5, activeFrom: true, activeTo: true },
    ]);
    expect(orderTouched).toBe(false);
  });

  it("can deactivate a price without deleting it", async () => {
    const res = await route.PATCH(patch({ items: [{ key: "STAPLE", unitPrice: 5, isActive: false }] }));
    expect(res.status).toBe(200);
    expect(stagedPrices).toEqual([{ unitPrice: 5, isActive: false, updatedBy: "super-1" }]);
    expect(stagedAudits[0].metadata.changes[0]).toMatchObject({ activeFrom: true, activeTo: false });
  });

  it("returns 409 and rolls back both price and audit on a concurrent edit", async () => {
    conflictKey = "A4_BW";
    const res = await route.PATCH(patch({ items: [{ key: "A4_BW", unitPrice: 4 }] }));

    expect(res.status).toBe(409);
    expect(stagedAudits).toHaveLength(0);
    expect(rows.find((r) => r.key === "A4_BW")!.unitPrice).toBe(2);
    expect(orderTouched).toBe(false);
  });

  it("rejects invalid numbers before reading the price table", async () => {
    for (const unitPrice of [-1, 10001, 1.234, "abc"]) {
      const res = await route.PATCH(patch({ items: [{ key: "A4_BW", unitPrice }] }));
      expect(res.status).toBe(422);
    }
    expect(stagedPrices).toHaveLength(0);
  });
});
