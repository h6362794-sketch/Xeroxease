// Order lifecycle service — admin transitions and student cancellation.
//
// These tests exercise the real service functions against an in-memory Prisma
// stand-in. The stand-in applies the same conditional predicates the SQL does, so
// the concurrency guarantees are genuinely exercised rather than mocked away.

import { describe, it, expect, beforeEach, vi } from "vitest";

const STUDENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const ORDER = "33333333-3333-4333-8333-333333333333";

type Row = {
  id: string;
  userId: string;
  orderNumber: string;
  status: string;
  acceptedAt?: Date | null;
  acceptedBy?: string | null;
  rejectedAt?: Date | null;
  rejectedBy?: string | null;
  rejectionReason?: string | null;
  deliveredAt?: Date | null;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
  cancelledBy?: string | null;
  cancelReason?: string | null;
  collectionTokenHash?: string | null;
  collectionTokenUsedAt?: Date | null;
  totalAmount?: number;
};

let row: Row;
let events: any[];
let audits: any[];
let notifications: string[];
let settings: { cancellationAllowedStatuses: string[] };
/** Simulates a competing writer between the read and the conditional update. */
let beforeUpdate: ((row: Row) => void) | null;

let adminUpdateOrderStatus: typeof import("@/server/orders").adminUpdateOrderStatus;
let cancelOrder: typeof import("@/server/orders").cancelOrder;
let OrderError: typeof import("@/server/orders").OrderError;

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: ORDER,
    userId: STUDENT,
    orderNumber: "XE-2026-000001",
    status: "ORDER_RECEIVED",
    acceptedAt: null,
    acceptedBy: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectionReason: null,
    deliveredAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    collectionTokenHash: null,
    collectionTokenUsedAt: null,
    totalAmount: 240,
    ...overrides,
  };
}

async function load() {
  vi.resetModules();
  events = [];
  audits = [];
  notifications = [];
  beforeUpdate = null;

  vi.doMock("@/lib/prisma", () => ({
    prisma: {
      order: { findUnique: vi.fn(async () => ({ ...row })) },
      $transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => {
        const staged: any[] = [];
        const tx = {
          order: {
            updateMany: vi.fn(async (args: any) => {
              if (beforeUpdate) {
                beforeUpdate(row);
                beforeUpdate = null;
              }
              const where = args.where;
              if (where.id !== row.id) return { count: 0 };
              if (where.userId && where.userId !== row.userId) return { count: 0 };
              if (typeof where.status === "string" && where.status !== row.status) return { count: 0 };
              if (where.status?.in && !where.status.in.includes(row.status)) return { count: 0 };
              Object.assign(row, args.data);
              return { count: 1 };
            }),
          },
          orderEvent: {
            create: vi.fn(async (args: any) => {
              staged.push(args.data);
              return args.data;
            }),
          },
        };
        const result = await fn(tx);
        events.push(...staged);
        return result;
      }),
    },
  }));

  vi.doMock("@/server/settings", () => ({
    getSettings: vi.fn(async () => settings),
    getPriceTable: vi.fn(async () => ({ A4_BW: 2, A4_COLOR: 8, STAPLE: 5 })),
  }));

  vi.doMock("@/server/audit", () => ({
    audit: vi.fn(async (entry: any) => audits.push(entry)),
  }));

  vi.doMock("@/server/notifications", () => ({
    notify: vi.fn(async () => undefined),
    NOTIFY: new Proxy(
      {},
      {
        get: (_target, name) =>
          vi.fn(async () => {
            notifications.push(String(name));
          }),
      }
    ),
  }));

  vi.doMock("@/server/collection", () => ({
    signCollectionToken: vi.fn(() => "signed-token"),
    hashCollectionToken: vi.fn(() => "hashed-token"),
  }));

  const mod = await import("@/server/orders");
  adminUpdateOrderStatus = mod.adminUpdateOrderStatus;
  cancelOrder = mod.cancelOrder;
  OrderError = mod.OrderError;
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  await expect(promise).rejects.toBeInstanceOf(OrderError);
  await expect(promise).rejects.toMatchObject({ status });
}

beforeEach(async () => {
  row = makeRow();
  settings = { cancellationAllowedStatuses: ["PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW"] };
  await load();
});

describe("adminUpdateOrderStatus", () => {
  it("accepts an order, records the actor and appends history", async () => {
    const result = await adminUpdateOrderStatus({
      orderId: ORDER,
      toStatus: "ACCEPTED",
      actorId: ADMIN,
      actorRole: "ADMIN",
    });

    expect(result).toEqual({ fromStatus: "ORDER_RECEIVED", toStatus: "ACCEPTED" });
    expect(row.status).toBe("ACCEPTED");
    expect(row.acceptedAt).toBeInstanceOf(Date);
    expect(row.acceptedBy).toBe(ADMIN);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromStatus: "ORDER_RECEIVED",
      toStatus: "ACCEPTED",
      actorId: ADMIN,
      actorRole: "ADMIN",
    });
    expect(notifications).toContain("orderAccepted");
  });

  it("refuses non-admin actors", async () => {
    await expectStatus(
      adminUpdateOrderStatus({
        orderId: ORDER,
        toStatus: "ACCEPTED",
        actorId: STUDENT,
        actorRole: "STUDENT",
      }),
      403
    );
    expect(row.status).toBe("ORDER_RECEIVED");
    expect(events).toHaveLength(0);
  });

  it("refuses an invalid or repeated transition", async () => {
    await expectStatus(
      adminUpdateOrderStatus({
        orderId: ORDER,
        toStatus: "DELIVERED",
        actorId: ADMIN,
        actorRole: "ADMIN",
        confirm: true,
      }),
      409
    );
    await expectStatus(
      adminUpdateOrderStatus({
        orderId: ORDER,
        toStatus: "ORDER_RECEIVED",
        actorId: ADMIN,
        actorRole: "ADMIN",
      }),
      409
    );
    expect(row.status).toBe("ORDER_RECEIVED");
  });

  it("requires explicit confirmation before delivering", async () => {
    row = makeRow({ status: "READY_FOR_PICKUP" });
    await expectStatus(
      adminUpdateOrderStatus({
        orderId: ORDER,
        toStatus: "DELIVERED",
        actorId: ADMIN,
        actorRole: "ADMIN",
      }),
      422
    );
    expect(row.status).toBe("READY_FOR_PICKUP");

    await adminUpdateOrderStatus({
      orderId: ORDER,
      toStatus: "DELIVERED",
      actorId: ADMIN,
      actorRole: "ADMIN",
      confirm: true,
    });
    expect(row.status).toBe("DELIVERED");
    expect(row.deliveredAt).toBeInstanceOf(Date);
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(notifications).toContain("orderCompleted");
  });

  it("requires a written reason for rejection and stores it", async () => {
    await expectStatus(
      adminUpdateOrderStatus({
        orderId: ORDER,
        toStatus: "REJECTED",
        actorId: ADMIN,
        actorRole: "ADMIN",
        confirm: true,
        note: "  a  ",
      }),
      422
    );

    await adminUpdateOrderStatus({
      orderId: ORDER,
      toStatus: "REJECTED",
      actorId: ADMIN,
      actorRole: "ADMIN",
      confirm: true,
      note: "Document is unreadable",
    });

    expect(row.status).toBe("REJECTED");
    expect(row.rejectionReason).toBe("Document is unreadable");
    expect(row.rejectedAt).toBeInstanceOf(Date);
    expect(row.rejectedBy).toBe(ADMIN);
    expect(row.acceptedAt).toBeNull();
    expect(events[0]).toMatchObject({ fromStatus: "ORDER_RECEIVED", toStatus: "REJECTED" });
  });

  it("attaches a fresh collection token in the same transaction when ready", async () => {
    row = makeRow({ status: "PRINTING", collectionTokenUsedAt: new Date("2026-10-01") });
    await adminUpdateOrderStatus({
      orderId: ORDER,
      toStatus: "READY_FOR_PICKUP",
      actorId: ADMIN,
      actorRole: "ADMIN",
    });

    expect(row.status).toBe("READY_FOR_PICKUP");
    expect(row.collectionTokenHash).toBe("hashed-token");
    expect(row.collectionTokenUsedAt).toBeNull();
    expect(events).toHaveLength(1);
  });

  it("returns 409 and writes no history when another admin won the race", async () => {
    beforeUpdate = (live) => {
      live.status = "PRINTING";
    };
    await expectStatus(
      adminUpdateOrderStatus({
        orderId: ORDER,
        toStatus: "ACCEPTED",
        actorId: ADMIN,
        actorRole: "ADMIN",
      }),
      409
    );
    expect(row.status).toBe("PRINTING");
    expect(events).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });
});

describe("student cancellation", () => {
  it("cancels a pre-acceptance order and records the student", async () => {
    await cancelOrder({ orderId: ORDER, userId: STUDENT, actorRole: "STUDENT", reason: "Changed my mind" });

    expect(row.status).toBe("CANCELLED");
    expect(row.cancelledAt).toBeInstanceOf(Date);
    expect(row.cancelledBy).toBe(STUDENT);
    expect(row.cancelReason).toBe("Changed my mind");
    expect(events[0]).toMatchObject({
      type: "CANCELLED",
      fromStatus: "ORDER_RECEIVED",
      toStatus: "CANCELLED",
      actorRole: "STUDENT",
    });
    expect(notifications).toContain("orderCancelled");
  });

  it("rejects another student's order", async () => {
    await expectStatus(cancelOrder({ orderId: ORDER, userId: OTHER, actorRole: "STUDENT" }), 403);
    expect(row.status).toBe("ORDER_RECEIVED");
  });

  it("refuses to cancel once accepted", async () => {
    row = makeRow({ status: "ACCEPTED" });
    await expectStatus(cancelOrder({ orderId: ORDER, userId: STUDENT, actorRole: "STUDENT" }), 409);
    expect(row.status).toBe("ACCEPTED");
    expect(events).toHaveLength(0);
  });

  it("cannot be re-enabled by an over-broad settings row", async () => {
    settings = { cancellationAllowedStatuses: ["ACCEPTED", "PRINTING", "READY_FOR_PICKUP"] };
    row = makeRow({ status: "ACCEPTED" });
    await expectStatus(cancelOrder({ orderId: ORDER, userId: STUDENT, actorRole: "STUDENT" }), 409);
  });

  it("lets settings narrow legacy pre-acceptance cancellation", async () => {
    settings = { cancellationAllowedStatuses: [] };
    row = makeRow({ status: "PAYMENT_PENDING" });
    await expectStatus(cancelOrder({ orderId: ORDER, userId: STUDENT, actorRole: "STUDENT" }), 409);
  });

  it("cannot race an acceptance: the losing write sees zero rows and gets 409", async () => {
    // An administrator accepts after the student's read but before the guarded
    // UPDATE, exactly what the SQL WHERE status = <old> protects against.
    beforeUpdate = (live) => {
      live.status = "ACCEPTED";
    };
    await expectStatus(cancelOrder({ orderId: ORDER, userId: STUDENT, actorRole: "STUDENT" }), 409);
    expect(row.status).toBe("ACCEPTED");
    expect(events).toHaveLength(0);
  });
});
