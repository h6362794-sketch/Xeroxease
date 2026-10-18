// Lost collection code: Super Admin override. These tests pin the rules that the route relies on:
// who may use it, what must be confirmed, what is written, and that the audit entry is part of the
// same transaction. Database and notifications are faked.
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = {
  id: string;
  orderNumber: string;
  userId: string;
  status: string;
  collectionTokenUsedAt: Date | null;
};

let rows: Row[];
let events: Array<Record<string, unknown>>;
let auditRows: Array<Record<string, unknown>>;
let notifyCompleted: ReturnType<typeof vi.fn>;
let failAudit: boolean;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      // Mirror a real rollback: work done before a throw is discarded.
      const snapEvents = events.length;
      const snapAudit = auditRows.length;
      const snapRows = rows.map((r) => ({ ...r }));
      try {
        return await fn(tx);
      } catch (err) {
        events.length = snapEvents;
        auditRows.length = snapAudit;
        rows = snapRows;
        throw err;
      }
    },
  },
}));

const tx = {
  order: {
    findUnique: async (args: { where: { orderNumber: string } }) => {
      const r = rows.find((o) => o.orderNumber === args.where.orderNumber);
      return r ? { ...r } : null;
    },
    updateMany: async (args: {
      where: { id: string; status: string; collectionTokenUsedAt: null };
      data: Partial<Row>;
    }) => {
      const r = rows.find((o) => o.id === args.where.id);
      if (!r || r.status !== args.where.status || r.collectionTokenUsedAt !== null) return { count: 0 };
      Object.assign(r, args.data);
      return { count: 1 };
    },
  },
  orderEvent: {
    create: async (args: { data: Record<string, unknown> }) => {
      events.push(args.data);
    },
  },
  auditLog: {
    create: async (args: { data: Record<string, unknown> }) => {
      if (failAudit) throw new Error("audit table unavailable");
      auditRows.push(args.data);
    },
  },
};

vi.mock("@/server/env", () => ({
  env: { SESSION_SECRET: "test-secret-that-is-at-least-32-characters-long" },
}));

vi.mock("@/server/notifications", () => ({
  NOTIFY: {
    get orderCompleted() {
      return notifyCompleted;
    },
  },
}));

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const REASON = "Student could not sign in. Checked student ID card in person at the desk.";
const SUPER = { id: "super-1", role: "SUPER_ADMIN" };

let collection: typeof import("@/server/collection");

beforeEach(async () => {
  vi.resetModules();
  notifyCompleted = vi.fn(async () => undefined);
  failAudit = false;
  events = [];
  auditRows = [];
  rows = [
    { id: ORDER_ID, orderNumber: "XE-2026-000042", userId: "student-1", status: "READY_FOR_COLLECTION", collectionTokenUsedAt: null },
  ];
  collection = await import("@/server/collection");
});

function input(over: Partial<Parameters<typeof collection.overrideLostCollectionCode>[0]> = {}) {
  return {
    actor: SUPER,
    orderNumber: "XE-2026-000042",
    confirmOrderNumber: "XE-2026-000042",
    reason: REASON,
    identityChecked: true,
    ...over,
  };
}

describe("overrideLostCollectionCode", () => {
  it("completes a ready order, burns its code, and records the reason only in the audit log", async () => {
    const res = await collection.overrideLostCollectionCode(input());
    expect(res.orderNumber).toBe("XE-2026-000042");

    const row = rows[0];
    expect(row.status).toBe("COMPLETED");
    expect(row.collectionTokenUsedAt).toBeInstanceOf(Date);

    // Audit entry: written, carries the reason, and names the actor and the order.
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "COLLECTION_OVERRIDE",
      actorId: SUPER.id,
      actorRole: "SUPER_ADMIN",
      targetType: "ORDER",
      targetId: ORDER_ID,
    });
    expect((auditRows[0].metadata as { reason: string }).reason).toBe(REASON);

    // The student-visible timeline gets the generic message, never the reason.
    expect(events).toHaveLength(1);
    expect(String(events[0].message)).toBe(collection.OVERRIDE_GENERIC_MESSAGE);
    expect(JSON.stringify(events)).not.toContain("Checked student ID");

    expect(notifyCompleted).toHaveBeenCalledWith("student-1", "XE-2026-000042", ORDER_ID);
  });

  it("refuses anyone who is not a Super Admin, even an ADMIN, and writes nothing", async () => {
    await expect(
      collection.overrideLostCollectionCode(input({ actor: { id: "admin-1", role: "ADMIN" } }))
    ).rejects.toMatchObject({ status: 403 });
    expect(rows[0].status).toBe("READY_FOR_COLLECTION");
    expect(auditRows).toHaveLength(0);
    expect(notifyCompleted).not.toHaveBeenCalled();
  });

  it("requires the in-person identity confirmation", async () => {
    await expect(
      collection.overrideLostCollectionCode(input({ identityChecked: false }))
    ).rejects.toMatchObject({ status: 400 });
    expect(rows[0].status).toBe("READY_FOR_COLLECTION");
  });

  it("requires a reason of at least 20 characters after trimming", async () => {
    await expect(collection.overrideLostCollectionCode(input({ reason: "   short   " }))).rejects.toMatchObject({
      status: 400,
    });
    expect(rows[0].status).toBe("READY_FOR_COLLECTION");
  });

  it("refuses a reason longer than 500 characters", async () => {
    await expect(
      collection.overrideLostCollectionCode(input({ reason: "x".repeat(501) }))
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses when the typed order number does not match, so the wrong order cannot be completed", async () => {
    await expect(
      collection.overrideLostCollectionCode(input({ confirmOrderNumber: "XE-2026-000043" }))
    ).rejects.toMatchObject({ status: 400 });
    expect(rows[0].status).toBe("READY_FOR_COLLECTION");
    expect(auditRows).toHaveLength(0);
  });

  it("refuses an order that is not ready for collection", async () => {
    rows[0].status = "PRINTING";
    await expect(collection.overrideLostCollectionCode(input())).rejects.toMatchObject({ status: 409 });
    expect(rows[0].status).toBe("PRINTING");
    expect(auditRows).toHaveLength(0);
  });

  it("refuses an order whose code was already used", async () => {
    rows[0].collectionTokenUsedAt = new Date("2026-10-18T00:00:00Z");
    await expect(collection.overrideLostCollectionCode(input())).rejects.toMatchObject({ status: 409 });
    expect(auditRows).toHaveLength(0);
  });

  it("does not complete the order when the audit entry cannot be written (no audit, no override)", async () => {
    failAudit = true;
    await expect(collection.overrideLostCollectionCode(input())).rejects.toThrow("audit table unavailable");
    expect(rows[0].status).toBe("READY_FOR_COLLECTION");
    expect(rows[0].collectionTokenUsedAt).toBeNull();
    expect(events).toHaveLength(0);
    expect(notifyCompleted).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown order", async () => {
    await expect(
      collection.overrideLostCollectionCode(input({ orderNumber: "XE-2099-000001", confirmOrderNumber: "XE-2099-000001" }))
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("consumeCollectionToken audit", () => {
  it("writes the consume audit entry inside the transaction, not after it", async () => {
    // The consume path is covered in collection-token.test.ts; here we only pin the placement.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/server/collection.ts", import.meta.url), "utf8")
    );
    const consume = src.slice(src.indexOf("export async function consumeCollectionToken"), src.indexOf("export async function overrideLostCollectionCode"));
    const insideTx = consume.indexOf("tx.auditLog.create");
    const afterTx = consume.indexOf("await audit(");
    expect(insideTx).toBeGreaterThan(-1);
    expect(afterTx).toBe(-1);
  });
});
