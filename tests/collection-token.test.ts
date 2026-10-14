import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Concurrency regression tests for QR collection.
 *
 * The original implementation read the order, checked `collectionTokenUsedAt`, and
 * then issued a separate UPDATE. Two simultaneous scans therefore both observed an
 * unused token and both completed the order. The fix performs one guarded
 * `updateMany` (predicate `collectionTokenUsedAt IS NULL` + status) inside a single
 * transaction, so exactly one request can win.
 *
 * We model the database rather than run a real PostgreSQL instance, and model it
 * faithfully: the guarded UPDATE is applied under a per-row lock, which is what
 * makes the predicate effective.
 */

type OrderRow = {
  id: string;
  orderNumber: string;
  userId: string;
  status: string;
  collectionTokenHash: string | null;
  collectionTokenUsedAt: Date | null;
};

type Tx = {
  order: {
    findMany: (args: { where: { collectionTokenHash: string } }) => Promise<OrderRow[]>;
    findFirst: (args: { where: { collectionTokenHash: string } }) => Promise<OrderRow | null>;
    updateMany: (args: {
      where: { id: string; collectionTokenHash: string; collectionTokenUsedAt: null; status: string };
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
  orderEvent: { create: (args: { data: unknown }) => Promise<void> };
};

import { createHmac } from "crypto";

const events: unknown[] = [];
let orders: OrderRow[] = [];
let rowLocks = new Map<string, Promise<unknown>>();

// Same derivation the module uses, so the fixtures match what it looks up.
const TEST_SECRET = "test-secret-that-is-at-least-32-characters-long";
const HASH = createHmac("sha256", TEST_SECRET).update("collection:token").digest("hex");

function makeTx(): Tx {
  return {
    order: {
      findMany: async (args) => orders.filter((o) => o.collectionTokenHash === args.where.collectionTokenHash),
      findFirst: async (args) => orders.find((o) => o.collectionTokenHash === args.where.collectionTokenHash) ?? null,
      updateMany: async (args) => {
        // Serialise per-row, exactly as a row lock would.
        const prior = rowLocks.get(args.where.id) ?? Promise.resolve();
        const run = prior.then(async () => {
          const row = orders.find((o) => o.id === args.where.id);
          if (!row) return { count: 0 };
          if (
            row.collectionTokenHash !== args.where.collectionTokenHash ||
            row.collectionTokenUsedAt !== null ||
            row.status !== args.where.status
          ) {
            return { count: 0 };
          }
          Object.assign(row, args.data);
          return { count: 1 };
        });
        rowLocks.set(args.where.id, run.catch(() => undefined));
        return run;
      },
    },
    orderEvent: {
      create: async (args) => {
        events.push(args.data);
      },
    },
  };
}

// The module under test imports @/lib/prisma -> @prisma/client, which requires a
// generated client. Stub it so these rules stay testable on a clean checkout.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    order: {
      findFirst: (args: { where: { collectionTokenHash: string } }) =>
        Promise.resolve(orders.find((o) => o.collectionTokenHash === args.where.collectionTokenHash) ?? null),
    },
    $transaction: (fn: (tx: Tx) => Promise<unknown>) => fn(makeTx()),
  },
}));

vi.mock("@/server/env", () => ({
  env: {
    get SESSION_SECRET() {
      return TEST_SECRET;
    },
  },
}));

vi.mock("@/server/notifications", () => ({
  NOTIFY: {
    orderCompleted: vi.fn(async () => undefined),
  },
}));

vi.mock("@/server/audit", () => ({
  audit: vi.fn(async () => undefined),
}));

let collection: typeof import("@/server/collection");

beforeEach(async () => {
  rowLocks = new Map();
  events.length = 0;
  orders = [
    {
      id: "order-1",
      orderNumber: "XE-2026-000001",
      userId: "user-1",
      status: "READY_FOR_COLLECTION",
      collectionTokenHash: HASH,
      collectionTokenUsedAt: null,
    },
  ];
  collection = await import("@/server/collection");
});

describe("collection token consumption", () => {
  it("consumes a valid token exactly once", async () => {
    const first = await collection.consumeCollectionToken("token", { id: "admin", role: "ADMIN" });
    expect(first.ok).toBe(true);
    expect(orders[0].status).toBe("COMPLETED");
    expect(orders[0].collectionTokenUsedAt).not.toBeNull();

    const second = await collection.consumeCollectionToken("token", { id: "admin", role: "ADMIN" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("ALREADY_USED");
  });

  it("allows exactly one winner when the same token is scanned concurrently", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        collection.consumeCollectionToken("token", { id: "admin", role: "ADMIN" })
      )
    );
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    // Exactly one status-change event is recorded — no double fulfilment.
    expect(events).toHaveLength(1);
    expect(orders[0].collectionTokenUsedAt).not.toBeNull();
  });

  it("rejects an unknown token", async () => {
    const res = await collection.consumeCollectionToken("not-a-real-token", { id: "admin", role: "ADMIN" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("INVALID");
  });

  it("refuses collection when the order is not ready", async () => {
    orders[0].status = "PRINTING";
    const res = await collection.consumeCollectionToken("token", { id: "admin", role: "ADMIN" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("NOT_READY");
    expect(orders[0].collectionTokenUsedAt).toBeNull();
    expect(orders[0].status).toBe("PRINTING");
  });

  it("verify-only mode never mutates the order", async () => {
    const verify = await collection.verifyCollectionToken("token");
    expect(verify.ok).toBe(true);
    expect(orders[0].collectionTokenUsedAt).toBeNull();
    expect(orders[0].status).toBe("READY_FOR_COLLECTION");
  });

  it("verify-only reports already-used tokens", async () => {
    orders[0].collectionTokenUsedAt = new Date();
    const verify = await collection.verifyCollectionToken("token");
    expect(verify.ok).toBe(false);
    if (!verify.ok) expect(verify.code).toBe("ALREADY_USED");
  });
});
