// Document purge and retention — lifecycle tests.
//
// Database and object storage are faked. What these tests pin is the ordering and the
// conditions that keep the purge safe: the claim lands before the object is deleted, a failed
// object delete releases the claim, a lost race never deletes, and retention measures the
// right clock. The SQL itself is exercised by the migration check in CI, not here.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Fn = ReturnType<typeof vi.fn>;

let prisma: {
  uploadedFile: {
    findFirst: Fn;
    findMany: Fn;
    updateMany: Fn;
    deleteMany: Fn;
  };
};
let deleteFile: Fn;
let getSettings: Fn;
let releaseExpiredIntents: Fn;
let lifecycle: typeof import("@/server/document-lifecycle");

async function load(retentionDays = 30) {
  vi.resetModules();
  vi.setSystemTime(NOW);
  prisma = {
    uploadedFile: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  deleteFile = vi.fn(async () => undefined);
  getSettings = vi.fn(async () => ({ retentionDays }));
  releaseExpiredIntents = vi.fn(async () => ({ released: 0, attempted: 0, failed: 0 }));
  vi.doMock("@/lib/prisma", () => ({ prisma }));
  vi.doMock("@/server/storage", () => ({ deleteFile }));
  vi.doMock("@/server/settings", () => ({ getSettings }));
  vi.doMock("@/server/direct-upload/service", () => ({ releaseExpiredIntents }));
  lifecycle = await import("@/server/document-lifecycle");
}

beforeEach(async () => {
  await load();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("purgeUnattachedUpload", () => {
  it("answers not_found for a document that is not the caller's, attached, or already purged", async () => {
    prisma.uploadedFile.findFirst.mockResolvedValueOnce(null);
    expect(await lifecycle.purgeUnattachedUpload("file-1", "user-b")).toBe("not_found");
    expect(prisma.uploadedFile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "file-1", orderId: null, purgedAt: null, uploaderId: "user-b" }),
      })
    );
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("claims the row before deleting the object, then removes the row", async () => {
    prisma.uploadedFile.findFirst.mockResolvedValueOnce({ storageKey: "user-a/a.pdf" });
    expect(await lifecycle.purgeUnattachedUpload("file-1", "user-a")).toBe("purged");

    const claim = prisma.uploadedFile.updateMany.mock.invocationCallOrder[0];
    const objectDelete = deleteFile.mock.invocationCallOrder[0];
    const rowDelete = prisma.uploadedFile.deleteMany.mock.invocationCallOrder[0];
    expect(claim).toBeLessThan(objectDelete);
    expect(objectDelete).toBeLessThan(rowDelete);
    expect(deleteFile).toHaveBeenCalledWith("user-a/a.pdf");
  });

  it("releases the claim and keeps the row when the object cannot be deleted", async () => {
    prisma.uploadedFile.findFirst.mockResolvedValueOnce({ storageKey: "user-a/a.pdf" });
    deleteFile.mockRejectedValueOnce(new Error("Storage delete failed (503)"));

    expect(await lifecycle.purgeUnattachedUpload("file-1", "user-a")).toBe("failed");

    const claimedAt = prisma.uploadedFile.updateMany.mock.calls[0][0].data.purgedAt;
    expect(claimedAt).toBeInstanceOf(Date);
    // The release only undoes *this* claim, never a later one.
    expect(prisma.uploadedFile.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ id: "file-1", orderId: null, purgedAt: claimedAt }),
      data: { purgedAt: null },
    });
    expect(prisma.uploadedFile.deleteMany).not.toHaveBeenCalled();
  });

  it("never deletes when another request won the claim (for example, an order linked first)", async () => {
    prisma.uploadedFile.findFirst.mockResolvedValueOnce({ storageKey: "user-a/a.pdf" });
    prisma.uploadedFile.updateMany.mockResolvedValueOnce({ count: 0 });

    expect(await lifecycle.purgeUnattachedUpload("file-1", "user-a")).toBe("not_found");
    expect(deleteFile).not.toHaveBeenCalled();
    expect(prisma.uploadedFile.deleteMany).not.toHaveBeenCalled();
  });
});

describe("purgeAbandonedUploads", () => {
  it("selects only unattached, unpurged documents older than the 24-hour TTL", async () => {
    await lifecycle.purgeAbandonedUploads(NOW, 25);
    const { where, take } = prisma.uploadedFile.findMany.mock.calls[0][0];
    expect(take).toBe(25);
    expect(where).toMatchObject({ orderId: null, purgedAt: null });
    expect(where.createdAt.lt.getTime()).toBe(NOW.getTime() - 24 * HOUR);
  });

  it("leaves a PENDING upload with a live intent alone", async () => {
    await lifecycle.purgeAbandonedUploads(NOW, 25);
    const { where } = prisma.uploadedFile.findMany.mock.calls[0][0];
    expect(where.OR).toEqual([
      { status: { not: "PENDING" } },
      { intentExpiresAt: null },
      { intentExpiresAt: { lt: NOW } },
    ]);
  });

  it("purges each candidate through the claim path and clears only old leftover claims", async () => {
    prisma.uploadedFile.findMany.mockResolvedValueOnce([{ id: "x" }, { id: "y" }]);
    prisma.uploadedFile.findFirst.mockResolvedValue({ storageKey: "k" });
    prisma.uploadedFile.deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 3 });

    const report = await lifecycle.purgeAbandonedUploads(NOW, 25);
    expect(report).toEqual({ attempted: 2, purged: 2, failed: 0, leftoversRemoved: 3 });

    const leftover = prisma.uploadedFile.deleteMany.mock.calls.at(-1)?.[0].where;
    expect(leftover.orderId).toBeNull();
    expect(leftover.purgedAt.lt.getTime()).toBe(NOW.getTime() - 24 * HOUR);
    // A claim made moments ago is in progress and must not be swept as a leftover.
    expect(leftover.purgedAt.not).toBeNull();
  });
});

describe("purgeRetainedDocuments", () => {
  it("measures retention from completed, cancelled, or failed time, using the settings value", async () => {
    await load(45);
    await lifecycle.purgeRetainedDocuments(NOW, 10);
    const { where } = prisma.uploadedFile.findMany.mock.calls[0][0];
    const cutoff = (NOW.getTime() - 45 * DAY);
    expect(where.purgedAt).toBeNull();
    expect(where.order.is.OR).toEqual([
      { status: "COMPLETED", completedAt: { lt: new Date(cutoff) } },
      { status: "CANCELLED", cancelledAt: { lt: new Date(cutoff) } },
      { status: "FAILED", updatedAt: { lt: new Date(cutoff) } },
    ]);
  });

  it("never selects a document of an order that is still in progress", async () => {
    await lifecycle.purgeRetainedDocuments(NOW, 10);
    const { where } = prisma.uploadedFile.findMany.mock.calls[0][0];
    const statuses = where.order.is.OR.map((c: { status: string }) => c.status);
    expect(statuses.sort()).toEqual(["CANCELLED", "COMPLETED", "FAILED"]);
  });

  it("marks a document purged only after its object is gone", async () => {
    prisma.uploadedFile.findMany.mockResolvedValueOnce([{ id: "a", storageKey: "k-a" }]);
    const report = await lifecycle.purgeRetainedDocuments(NOW, 10);
    expect(report).toEqual({ attempted: 1, purged: 1, failed: 0, retentionDays: 30 });
    expect(deleteFile.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.uploadedFile.updateMany.mock.invocationCallOrder[0]
    );
    expect(prisma.uploadedFile.updateMany).toHaveBeenCalledWith({
      where: { id: "a", purgedAt: null },
      data: { purgedAt: NOW },
    });
  });

  it("leaves a failed document unmarked so the next run retries it", async () => {
    prisma.uploadedFile.findMany.mockResolvedValueOnce([{ id: "a", storageKey: "k-a" }]);
    deleteFile.mockRejectedValueOnce(new Error("Storage delete failed (500)"));
    const report = await lifecycle.purgeRetainedDocuments(NOW, 10);
    expect(report).toMatchObject({ attempted: 1, purged: 0, failed: 1 });
    expect(prisma.uploadedFile.updateMany).not.toHaveBeenCalled();
  });
});

describe("runUploadSweep", () => {
  it("runs intent release only when direct uploads are enabled, but always runs the purges", async () => {
    await lifecycle.runUploadSweep({ limit: 20, intents: false }, NOW);
    expect(releaseExpiredIntents).not.toHaveBeenCalled();
    expect(prisma.uploadedFile.findMany).toHaveBeenCalledTimes(2);

    await lifecycle.runUploadSweep({ limit: 20, intents: true }, NOW);
    expect(releaseExpiredIntents).toHaveBeenCalledWith(20);
  });

  it("reports every job, including retention days", async () => {
    const report = await lifecycle.runUploadSweep({ limit: 20, intents: true }, NOW);
    expect(Object.keys(report).sort()).toEqual(
      [
        "attempted",
        "intentsFailed",
        "leftoversRemoved",
        "released",
        "retentionAttempted",
        "retentionDays",
        "retentionFailed",
        "retentionPurged",
        "unattachedAttempted",
        "unattachedFailed",
        "unattachedPurged",
      ].sort()
    );
    expect(report.retentionDays).toBe(30);
  });
});
