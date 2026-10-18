import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The admin page-count correction used to write any count to any file on any order, in any state,
 * without repricing the order. It now refuses every correction (409 ORDER_PRICED) and writes
 * nothing. These tests pin that for every order status, for a concurrent status change, and for the
 * malformed and foreign-file cases, and check that the route source has no write path at all.
 */

const ORDER_ID = "44444444-4444-4444-8444-444444444444";
const FILE_ID = "55555555-5555-4555-8555-555555555555";
const ADMIN = { id: "admin-1", role: "ADMIN" as const };

const fileFindFirst = vi.fn();
const orderFindUnique = vi.fn();
const fileUpdate = vi.fn();
const fileUpdateMany = vi.fn();
const orderUpdate = vi.fn();
const orderUpdateMany = vi.fn();
const transaction = vi.fn();
const auditSpy = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    uploadedFile: {
      findFirst: (...a: unknown[]) => fileFindFirst(...a),
      update: (...a: unknown[]) => fileUpdate(...a),
      updateMany: (...a: unknown[]) => fileUpdateMany(...a),
    },
    order: {
      findUnique: (...a: unknown[]) => orderFindUnique(...a),
      update: (...a: unknown[]) => orderUpdate(...a),
      updateMany: (...a: unknown[]) => orderUpdateMany(...a),
    },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}));
vi.mock("@/server/auth", () => ({ requireRole: vi.fn(async () => ADMIN) }));
vi.mock("@/server/audit", () => ({ audit: (...a: unknown[]) => auditSpy(...a) }));

const ctx = { params: Promise.resolve({ id: ORDER_ID, fileId: FILE_ID }) };
const patch = (body: unknown) =>
  new Request(`http://localhost/api/admin/orders/${ORDER_ID}/files/${FILE_ID}/pagecount`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const ROUTE = join(process.cwd(), "src/app/api/admin/orders/[id]/files/[fileId]/pagecount/route.ts");

function noWrites() {
  expect(fileUpdate).not.toHaveBeenCalled();
  expect(fileUpdateMany).not.toHaveBeenCalled();
  expect(orderUpdate).not.toHaveBeenCalled();
  expect(orderUpdateMany).not.toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();
  expect(auditSpy).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const m of [fileFindFirst, orderFindUnique, fileUpdate, fileUpdateMany, orderUpdate, orderUpdateMany, transaction, auditSpy]) {
    m.mockReset();
  }
  fileFindFirst.mockResolvedValue({ id: FILE_ID });
  orderFindUnique.mockResolvedValue({ id: ORDER_ID, status: "PAYMENT_PENDING", totalAmount: 120 });
});

const STATUSES = [
  "ORDER_PLACED",
  "PAYMENT_PENDING",
  "PAYMENT_UNDER_REVIEW",
  "PAYMENT_CONFIRMED",
  "DOCUMENTS_RECEIVED",
  "PROCESSING",
  "PRINTING",
  "QUALITY_CHECK",
  "READY_FOR_COLLECTION",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
] as const;

describe("admin page-count correction is refused for every order state", () => {
  it.each(STATUSES)("refuses a correction on an order in %s, with no write", async (status) => {
    orderFindUnique.mockResolvedValue({ id: ORDER_ID, status, totalAmount: 120 });
    const { PATCH } = await import("@/app/api/admin/orders/[id]/files/[fileId]/pagecount/route");
    const res = await PATCH(patch({ fileId: FILE_ID, pageCount: 3 }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ORDER_PRICED");
    noWrites();
  });

  it("refuses a correction that would lower the count (the underbilling case) with no write", async () => {
    const { PATCH } = await import("@/app/api/admin/orders/[id]/files/[fileId]/pagecount/route");
    const res = await PATCH(patch({ fileId: FILE_ID, pageCount: 1 }), ctx);
    expect(res.status).toBe(409);
    noWrites();
  });

  it("refuses a correction that would raise the count, with no write", async () => {
    const { PATCH } = await import("@/app/api/admin/orders/[id]/files/[fileId]/pagecount/route");
    const res = await PATCH(patch({ fileId: FILE_ID, pageCount: 500 }), ctx);
    expect(res.status).toBe(409);
    noWrites();
  });

  it("refuses when the order changes state between the reads (a concurrent desk move)", async () => {
    // The route does not consult the order status to decide, so a change between reads cannot
    // open a window. Both reads return a refusal and no write happens.
    orderFindUnique
      .mockResolvedValueOnce({ id: ORDER_ID, status: "PAYMENT_PENDING", totalAmount: 120 })
      .mockResolvedValueOnce({ id: ORDER_ID, status: "PAYMENT_CONFIRMED", totalAmount: 120 });
    const { PATCH } = await import("@/app/api/admin/orders/[id]/files/[fileId]/pagecount/route");
    const res = await PATCH(patch({ fileId: FILE_ID, pageCount: 4 }), ctx);
    expect(res.status).toBe(409);
    noWrites();
  });

  it("refuses when the file was detached or belongs to another order (404), with no write", async () => {
    fileFindFirst.mockResolvedValue(null);
    const { PATCH } = await import("@/app/api/admin/orders/[id]/files/[fileId]/pagecount/route");
    const res = await PATCH(patch({ fileId: FILE_ID, pageCount: 2 }), ctx);
    expect(res.status).toBe(404);
    noWrites();
  });

  it.each([[0], [-1], [10001], ["abc"], [1.5]])("rejects a malformed count %j with 422 and no write", async (pageCount) => {
    const { PATCH } = await import("@/app/api/admin/orders/[id]/files/[fileId]/pagecount/route");
    const res = await PATCH(patch({ pageCount }), ctx);
    expect(res.status).toBe(422);
    noWrites();
  });

  it("rejects a malformed identifier with 400 and no write", async () => {
    const { PATCH } = await import("@/app/api/admin/orders/[id]/files/[fileId]/pagecount/route");
    const bad = { params: Promise.resolve({ id: "not-a-uuid", fileId: FILE_ID }) };
    const res = await PATCH(patch({ fileId: FILE_ID, pageCount: 2 }), bad);
    expect(res.status).toBe(400);
    noWrites();
  });
});

describe("the correction route has no write path at all", () => {
  it("contains no Prisma write, transaction or audit call", () => {
    const source = readFileSync(ROUTE, "utf8");
    expect(source).not.toMatch(/\.update(Many)?\(/);
    expect(source).not.toMatch(/\$transaction/);
    expect(source).not.toMatch(/\.(create|delete|upsert)(Many)?\(/);
    expect(source).not.toMatch(/\baudit\(/);
  });
});
