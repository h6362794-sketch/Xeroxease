import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Order-creation rules.
 *
 * Focus: the server must never price an unverified page count, must never accept
 * files the caller does not own, and must compute the total itself.
 */

type FileRow = {
  id: string;
  uploaderId: string;
  pageCount: number | null;
  analysisStatus: string;
  orderId: string | null;
  /** Upload lifecycle status. `createOrder` only accepts "COMPLETED". */
  status: string;
  /** Set when the document was purged; such a file must never link to an order. */
  purgedAt?: Date | null;
};

let files: FileRow[] = [];
let created: any[] = [];
let orderSeq = 0;
/** When true, the pre-check reads a stale snapshot (as a concurrent request would). */
let staleRead = false;

/** Shared conditional link: matches only rows still unattached, like the real predicate. */
function linkFiles(
  where: { id: { in: string[] }; uploaderId: string; orderId: null; status: string; purgedAt?: null },
  orderId: string
) {
  let count = 0;
  for (const f of files) {
    if (
      where.id.in.includes(f.id) &&
      f.uploaderId === where.uploaderId &&
      f.orderId === where.orderId &&
      f.status === where.status &&
      // `purgedAt: null` is the purge guard: a claimed or deleted document must never link.
      (where.purgedAt === undefined || !f.purgedAt)
    ) {
      f.orderId = orderId;
      count++;
    }
  }
  return { count };
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    uploadedFile: {
      findMany: async (args: { where: { id: { in: string[] }; uploaderId: string } }) =>
        files
          .filter(
            (f) =>
              args.where.id.in.includes(f.id) &&
              f.uploaderId === args.where.uploaderId
          )
          .map((f) => (staleRead ? { ...f, orderId: null, purgedAt: null } : f)),
    },
    order: {
      findFirst: async () => (orderSeq > 0 ? { orderNumber: `XE-2026-${String(orderSeq).padStart(6, "0")}` } : null),
      create: async (args: { data: any }) => {
        orderSeq++;
        const row = { id: `order-${orderSeq}`, ...args.data };
        created.push(row);
        return row;
      },
      updateMany: async () => ({ count: 1 }),
    },
    orderEvent: { create: async () => ({}) },
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      // Real transactions roll back on throw; mirror that for the rows the callback wrote.
      const snapshotFiles = files.map((f) => ({ ...f }));
      const snapshotCreated = created.length;
      const snapshotSeq = orderSeq;
      try {
        return await fn({
          order: {
            findFirst: async () =>
              orderSeq > 0 ? { orderNumber: `XE-2026-${String(orderSeq).padStart(6, "0")}` } : null,
            create: async (args: { data: any }) => {
              orderSeq++;
              const row = { id: `order-${orderSeq}`, ...args.data };
              created.push(row);
              return row;
            },
          },
          uploadedFile: {
            updateMany: async (args: { where: any; data: { orderId: string } }) =>
              linkFiles(args.where, args.data.orderId),
          },
          orderEvent: { create: async () => ({}) },
        });
      } catch (err) {
        files = snapshotFiles;
        created.length = snapshotCreated;
        orderSeq = snapshotSeq;
        throw err;
      }
    },
  },
}));

vi.mock("@/server/settings", () => ({
  getPriceTable: async () => ({
    A4_BW: 2,
    A4_COLOR: 8,
    LEGAL_BW: 3,
    LEGAL_COLOR: 10,
    STAPLE: 5,
    SPIRAL: 40,
    STICK_FILE: 25,
  }),
  getSettings: async () => ({ cancellationAllowedStatuses: ["PAYMENT_PENDING"] }),
}));

vi.mock("@/server/notifications", () => ({
  notify: vi.fn(async () => undefined),
  NOTIFY: {
    orderCreated: vi.fn(async () => undefined),
    orderCancelled: vi.fn(async () => undefined),
    statusUpdate: vi.fn(async () => undefined),
    orderReady: vi.fn(async () => undefined),
    orderCompleted: vi.fn(async () => undefined),
    paymentSubmitted: vi.fn(async () => undefined),
    paymentConfirmed: vi.fn(async () => undefined),
    paymentRejected: vi.fn(async () => undefined),
  },
}));

vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => undefined) }));

let orders: typeof import("@/server/orders");

const USER = "user-1";

const baseInput = {
  userId: USER,
  fileIds: ["file-1"],
  paperSize: "A4" as const,
  colorMode: "BW" as const,
  sides: "SINGLE" as const,
  copies: 1,
  pageSelection: "ALL" as const,
  finishing: [] as string[],
};

beforeEach(async () => {
  files = [];
  created = [];
  orderSeq = 0;
  staleRead = false;
  vi.resetModules();
  orders = await import("@/server/orders");
});

describe("page-count verification before pricing", () => {
  it("rejects a NEEDS_REVIEW document even when a pageCount estimate exists", async () => {
    files = [{ id: "file-1", uploaderId: USER, pageCount: 42, analysisStatus: "NEEDS_REVIEW", status: "COMPLETED", orderId: null }];
    await expect(orders.createOrder(baseInput)).rejects.toMatchObject({ status: 409 });
    expect(created).toHaveLength(0);
  });

  it("rejects a FAILED document", async () => {
    files = [{ id: "file-1", uploaderId: USER, pageCount: null, analysisStatus: "FAILED", status: "COMPLETED", orderId: null }];
    await expect(orders.createOrder(baseInput)).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a document still being analyzed", async () => {
    files = [{ id: "file-1", uploaderId: USER, pageCount: null, analysisStatus: "PROCESSING", status: "COMPLETED", orderId: null }];
    await expect(orders.createOrder(baseInput)).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a document with no page count", async () => {
    files = [{ id: "file-1", uploaderId: USER, pageCount: null, analysisStatus: "COMPLETED", status: "COMPLETED", orderId: null }];
    await expect(orders.createOrder(baseInput)).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a document that was uploaded but never verified against storage", async () => {
    // The direct-upload path creates PENDING rows the moment the browser is handed an
    // upload URL. Such a row has no verified bytes behind it, so it must not be orderable
    // even though nothing else about it looks wrong.
    files = [{ id: "file-1", uploaderId: USER, pageCount: 10, analysisStatus: "COMPLETED", status: "PENDING", orderId: null }];
    await expect(orders.createOrder(baseInput)).rejects.toMatchObject({ status: 409 });
    expect(created).toHaveLength(0);
  });

  it("accepts a fully verified document and prices it on the server", async () => {
    files = [{ id: "file-1", uploaderId: USER, pageCount: 10, analysisStatus: "COMPLETED", status: "COMPLETED", orderId: null }];
    const order = await orders.createOrder({ ...baseInput, copies: 2, finishing: ["STAPLE"] });
    // 10 pages * 2 copies = 20 billable pages @ 2 = 40, + 5 staple = 45
    expect(Number(order.totalAmount)).toBe(45);
    expect(order.billablePages).toBe(20);
  });
});

describe("ownership and reuse", () => {
  it("refuses files owned by another user (IDOR)", async () => {
    files = [{ id: "file-1", uploaderId: "someone-else", pageCount: 3, analysisStatus: "COMPLETED", status: "COMPLETED", orderId: null }];
    await expect(orders.createOrder(baseInput)).rejects.toMatchObject({ status: 403 });
    expect(created).toHaveLength(0);
  });

  it("refuses documents already attached to an order", async () => {
    files = [{ id: "file-1", uploaderId: USER, pageCount: 3, analysisStatus: "COMPLETED", status: "COMPLETED", orderId: "existing-order" }];
    await expect(orders.createOrder(baseInput)).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a document whose bytes were purged, before any price or order exists", async () => {
    files = [{ id: "file-1", uploaderId: USER, pageCount: 3, analysisStatus: "COMPLETED", status: "COMPLETED", orderId: null, purgedAt: new Date() }];
    await expect(orders.createOrder(baseInput)).rejects.toMatchObject({ status: 409 });
    expect(created).toHaveLength(0);
    expect(files[0].orderId).toBeNull();
  });

  it("rejects an empty file list", async () => {
    await expect(orders.createOrder({ ...baseInput, fileIds: [] })).rejects.toMatchObject({ status: 400 });
  });
});

describe("custom page selection", () => {
  it("validates the range against the verified count", async () => {
    files = [{ id: "file-1", uploaderId: USER, pageCount: 5, analysisStatus: "COMPLETED", status: "COMPLETED", orderId: null }];
    await expect(
      orders.createOrder({ ...baseInput, pageSelection: "CUSTOM", customPages: "1-99" })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("prices only the selected pages", async () => {
    files = [{ id: "file-1", uploaderId: USER, pageCount: 10, analysisStatus: "COMPLETED", status: "COMPLETED", orderId: null }];
    const order = await orders.createOrder({ ...baseInput, pageSelection: "CUSTOM", customPages: "1-4, 7" });
    expect(order.totalPages).toBe(5);
    expect(Number(order.totalAmount)).toBe(10);
  });
});

describe("order numbers", () => {
  it("allocates a sequential number", async () => {
    files = [{ id: "file-1", uploaderId: USER, pageCount: 1, analysisStatus: "COMPLETED", status: "COMPLETED", orderId: null }];
    const order = await orders.createOrder(baseInput);
    expect(order.orderNumber).toMatch(/^XE-\d{4}-\d{6}$/);
  });
});

describe("document linking is atomic (double-order race)", () => {
  it("a purge that lands between the pre-check and the link stops the order, and leaves no order", async () => {
    files = [{ id: "file-1", uploaderId: USER, pageCount: 3, analysisStatus: "COMPLETED", status: "COMPLETED", orderId: null, purgedAt: new Date() }];
    // The pre-check reads the document as still live (it raced the purge).
    staleRead = true;
    await expect(orders.createOrder(baseInput)).rejects.toMatchObject({ status: 409 });
    staleRead = false;
    expect(created).toHaveLength(0);
    expect(files[0].orderId).toBeNull();
  });

  it("a second order for a document another request just claimed is refused and leaves no order", async () => {
    files = [{ id: "file-1", uploaderId: USER, pageCount: 3, analysisStatus: "COMPLETED", status: "COMPLETED", orderId: null }];

    const first = await orders.createOrder(baseInput);
    expect(first).toBeTruthy();
    expect(files[0].orderId).toBe(created[0].id);

    // The second request's pre-check reads the file as unattached (it raced the first).
    staleRead = true;
    await expect(orders.createOrder(baseInput)).rejects.toMatchObject({ status: 409 });
    staleRead = false;

    // Only the first order exists, and the document still belongs to it.
    expect(created).toHaveLength(1);
    expect(files[0].orderId).toBe(created[0].id);
  });
});

