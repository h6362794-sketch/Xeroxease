import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Self-service page-count confirmation must only ever act as the exit from the review
 * state. A count produced by the parser (or set by an admin) is what an order is priced
 * from, so a student must not be able to overwrite it.
 */

const findFirst = vi.fn();
const updateMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { uploadedFile: { findFirst: (...a: unknown[]) => findFirst(...a), updateMany: (...a: unknown[]) => updateMany(...a) } },
}));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => undefined) }));

let confirmFilePageCount: typeof import("@/server/documents").confirmFilePageCount;

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  uploaderId: "user-1",
  orderId: null,
  pageCount: 100,
  pageCountSource: "DOCUMENT_PARSER",
  analysisStatus: "COMPLETED",
};

beforeEach(async () => {
  findFirst.mockReset();
  updateMany.mockReset();
  vi.resetModules();
  ({ confirmFilePageCount } = await import("@/server/documents"));
});

const call = (pageCount: number) =>
  confirmFilePageCount({ fileId: base.id, userId: "user-1", pageCount });

describe("confirmFilePageCount", () => {
  it("refuses to overwrite a page count the parser verified (the 100-page -> 1-page exploit)", async () => {
    findFirst.mockResolvedValue({ ...base });
    await expect(call(1)).rejects.toMatchObject({ status: 409 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an administrator-verified count", async () => {
    findFirst.mockResolvedValue({ ...base, pageCountSource: "ADMIN_VERIFIED" });
    await expect(call(1)).rejects.toMatchObject({ status: 409 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("accepts a count for a document in the review state", async () => {
    findFirst.mockResolvedValue({ ...base, pageCount: 1, pageCountSource: null, analysisStatus: "NEEDS_REVIEW" });
    updateMany.mockResolvedValue({ count: 1 });
    const res = await call(12);
    expect(res).toEqual({ id: base.id, pageCount: 12 });
    const args = updateMany.mock.calls[0][0];
    // The guard is repeated in the WHERE clause, so a concurrent change cannot slip past it.
    expect(args.where.orderId).toBeNull();
    expect(args.where.uploaderId).toBe("user-1");
    expect(args.where.OR).toEqual(
      expect.arrayContaining([{ analysisStatus: { in: ["NEEDS_REVIEW", "FAILED"] } }])
    );
    expect(args.data).toMatchObject({ pageCount: 12, pageCountSource: "USER_CONFIRMED", analysisStatus: "COMPLETED" });
  });

  it("accepts a count for a FAILED analysis", async () => {
    findFirst.mockResolvedValue({ ...base, pageCount: null, pageCountSource: null, analysisStatus: "FAILED" });
    updateMany.mockResolvedValue({ count: 1 });
    await expect(call(3)).resolves.toMatchObject({ pageCount: 3 });
  });

  it("lets a student correct their own earlier confirmation (typo fix)", async () => {
    findFirst.mockResolvedValue({ ...base, pageCount: 12, pageCountSource: "USER_CONFIRMED" });
    updateMany.mockResolvedValue({ count: 1 });
    await expect(call(21)).resolves.toMatchObject({ pageCount: 21 });
  });

  it("fails closed when the row changed between read and write (atomic guard)", async () => {
    findFirst.mockResolvedValue({ ...base, pageCount: 1, pageCountSource: null, analysisStatus: "NEEDS_REVIEW" });
    updateMany.mockResolvedValue({ count: 0 });
    await expect(call(5)).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a document already attached to an order", async () => {
    findFirst.mockResolvedValue({ ...base, orderId: "order-1", analysisStatus: "NEEDS_REVIEW" });
    await expect(call(5)).rejects.toMatchObject({ status: 409 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects out-of-range counts before touching the database", async () => {
    await expect(call(0)).rejects.toMatchObject({ status: 400 });
    await expect(call(10001)).rejects.toMatchObject({ status: 400 });
    expect(findFirst).not.toHaveBeenCalled();
  });
});
