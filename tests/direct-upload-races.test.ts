// Direct-upload races, decided by the database-shaped store below rather than by call-shape mocks.
//
// The store honours the conditional `where` clauses the service relies on (equality, null, not-null,
// lt, in), so an update that matches zero rows really does match zero rows. Hooks run a competing
// operation at the exact point that matters: between a claim and the object delete, or between a
// completion's verification and its guarded write.
//
// What these tests can show: the ordering logic in service.ts is right for every interleaving named
// below. What they cannot show: that PostgreSQL's row locking behaves as the in-memory store does.
// That is what tests/direct-upload-races.pg.test.ts is for (it runs only against a disposable
// database; see that file).
//
// The invariant checked after every scenario: no COMPLETED row points at an object that is gone.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const OWNER = "user-owner";
const KEY = "user-owner/1700000000000-abc123-notes.pdf";
const PDF_HEADER = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0, 0, 0, 0, 0, 0, 0, 0]);
const student = { id: OWNER, role: "STUDENT" } as const;

interface Row {
  id: string;
  uploaderId: string;
  orderId: string | null;
  storageKey: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string | null;
  status: string;
  analysisStatus: string;
  intentExpiresAt: Date | null;
  intentTokenHash: string | null;
  purgedAt: Date | null;
  verifiedAt: Date | null;
}

/** Matches one column against a Prisma-style condition. Only the forms the service uses. */
function matchValue(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (typeof cond === "object") {
    // Several keys in one condition are ANDed, as in Prisma: { not: null, lt: x } means both.
    const c = cond as Record<string, unknown>;
    return Object.entries(c).every(([op, arg]) => {
      if (op === "not") return arg === null ? value !== null && value !== undefined : value !== arg;
      if (op === "lt") return value instanceof Date && value.getTime() < (arg as Date).getTime();
      if (op === "gt") return value instanceof Date && value.getTime() > (arg as Date).getTime();
      if (op === "in") return (arg as unknown[]).includes(value);
      throw new Error(`unsupported condition ${op}`);
    });
  }
  return value === cond;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, cond]) => matchValue((row as unknown as Record<string, unknown>)[k], cond));
}

function newRow(over: Partial<Row> = {}): Row {
  return {
    id: "file-1",
    uploaderId: OWNER,
    orderId: null,
    storageKey: KEY,
    originalName: "notes.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4096,
    checksum: null,
    status: "PENDING",
    analysisStatus: "PENDING",
    intentExpiresAt: new Date(Date.now() + 600_000),
    intentTokenHash: null,
    purgedAt: null,
    verifiedAt: null,
    ...over,
  };
}

interface Harness {
  rows: Row[];
  objects: Map<string, number>;
  /** Every object delete that reached storage, in order. */
  deletes: string[];
  /** Runs inside deleteFile, before the object is removed. */
  beforeDelete: ((key: string) => Promise<void>) | null;
  /** The next N deletes throw, as a storage outage would. */
  failDeletes: number;
  /** Runs inside getStoredObjectInfo, after it has answered (the caller now holds that answer). */
  afterStat: ((key: string) => Promise<void>) | null;
}

let h: Harness;
let service: typeof import("@/server/direct-upload/service");
let policy: typeof import("@/server/direct-upload/policy");

function freshHarness(): Harness {
  return {
    rows: [],
    objects: new Map(),
    deletes: [],
    beforeDelete: null,
    failDeletes: 0,
    afterStat: null,
  };
}

function prismaLike() {
  const uploadedFile = {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const row = h.rows.find((r) => matches(r, where));
      return row ? { ...row } : null;
    },
    findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
      const found = h.rows.filter((r) => matches(r, where)).map((r) => ({ ...r }));
      return take === undefined ? found : found.slice(0, take);
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      let count = 0;
      for (const r of h.rows) {
        if (matches(r, where)) {
          Object.assign(r, data);
          count++;
        }
      }
      return { count };
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const before = h.rows.length;
      h.rows = h.rows.filter((r) => !matches(r, where));
      return { count: before - h.rows.length };
    },
  };
  const client = { uploadedFile, order: { findFirst: async () => ({ id: "order-1" }) } };
  return {
    ...client,
    $transaction: async (fn: (tx: typeof client) => Promise<unknown>) => fn(client),
  };
}

async function load() {
  vi.resetModules();
  vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));
  vi.doMock("@/server/env", () => ({
    env: {
      SESSION_SECRET: "test-secret-0123456789abcdef-32-chars-min!",
      STORAGE_BACKEND: "supabase",
      STORAGE_BUCKET: "documents",
      SUPABASE_URL: "https://test-project.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      LOCAL_STORAGE_DIR: ".data/uploads",
      DIRECT_UPLOADS_ENABLED: true,
      UPLOAD_INTENT_TTL_SECONDS: 600,
      SIGNED_DOWNLOAD_URL_TTL_SECONDS: 60,
      STORAGE_PROVIDER_MAX_FILE_BYTES: 0,
      RATE_LIMIT_STORAGE: "memory",
      TRUSTED_PROXY_COUNT: 1,
    },
  }));
  vi.doMock("@/lib/prisma", () => ({ prisma: prismaLike() }));
  vi.doMock("@/server/audit", () => ({ audit: vi.fn(async () => undefined) }));
  vi.doMock("@/server/storage", () => ({
    buildStorageKey: () => KEY,
    deleteFile: async (key: string) => {
      h.deletes.push(key);
      if (h.beforeDelete) await h.beforeDelete(key);
      if (h.failDeletes > 0) {
        h.failDeletes--;
        throw new Error("Storage delete failed (503)");
      }
      h.objects.delete(key);
    },
    getStoredObjectInfo: async (key: string) => {
      const answer = h.objects.has(key) ? { sizeBytes: h.objects.get(key), mimeType: "application/pdf" } : null;
      if (h.afterStat) await h.afterStat(key);
      return answer;
    },
    readHeader: async () => PDF_HEADER,
    StorageError: class StorageError extends Error {},
  }));
  vi.doMock("@/server/direct-upload/storage-bridge", () => ({
    createSignedUploadTarget: async () => ({ uploadUrl: "https://x.invalid/u", path: KEY, expiresIn: 600 }),
    createSignedDownloadUrl: async () => ({ url: "https://x.invalid/d", expiresIn: 60 }),
  }));
  policy = await import("@/server/direct-upload/policy");
  service = await import("@/server/direct-upload/service");
}

/** Seed a PENDING row with a live intent and its object, and return the completion token. */
function seedPending(over: Partial<Row> = {}) {
  const row = newRow(over);
  const grant = policy.issueUploadIntentGrant({
    fileId: row.id,
    uploaderId: row.uploaderId,
    storageKey: row.storageKey as string,
    sizeBytes: row.sizeBytes,
    ttlSeconds: 600,
  });
  row.intentTokenHash = grant.tokenHash;
  h.rows.push(row);
  h.objects.set(KEY, row.sizeBytes);
  return { row, token: grant.token };
}

function seedExpired(id: string, over: Partial<Row> = {}) {
  const row = newRow({
    id,
    storageKey: `user-owner/${id}.pdf`,
    intentExpiresAt: new Date(Date.now() - 1_000),
    intentTokenHash: `hash-${id}`,
    ...over,
  });
  h.rows.push(row);
  h.objects.set(row.storageKey as string, row.sizeBytes);
  return row;
}

/** The invariant every scenario must leave true. */
function expectNoOrphanedCompletion() {
  for (const r of h.rows) {
    if (r.status === "COMPLETED") {
      expect(r.storageKey && h.objects.has(r.storageKey), `COMPLETED row ${r.id} has no object`).toBe(true);
    }
  }
}

async function outcome(p: Promise<unknown>) {
  try {
    return { ok: true as const, value: await p };
  } catch (err) {
    return { ok: false as const, error: err as { status?: number; code?: string } };
  }
}

beforeEach(async () => {
  h = freshHarness();
  await load();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("abort against a completion that is verifying the same object", () => {
  it("a completion that runs while the abort holds the claim cannot mark the row COMPLETED", async () => {
    const { token } = seedPending();
    let completion: { ok: boolean; error?: { code?: string; status?: number } } | null = null;
    h.beforeDelete = async () => {
      // The abort has claimed the row and is about to delete the object. Complete now.
      h.beforeDelete = null;
      completion = await outcome(service.completeUploadIntent({ actor: student, fileId: "file-1", token }));
    };

    const res = await service.abortUploadIntent({ actor: student, fileId: "file-1" });

    expect(res).toEqual({ released: true });
    expect(completion).toMatchObject({ ok: false, error: { status: 409, code: "ALREADY_COMPLETED" } });
    expect(h.rows).toHaveLength(0);
    expect(h.objects.has(KEY)).toBe(false);
    expectNoOrphanedCompletion();
  });

  it("a completion that wins first makes the abort refuse, and nothing is deleted", async () => {
    const { token } = seedPending();
    await service.completeUploadIntent({ actor: student, fileId: "file-1", token });

    const res = await outcome(service.abortUploadIntent({ actor: student, fileId: "file-1" }));

    expect(res).toMatchObject({ ok: false, error: { status: 409, code: "ALREADY_COMPLETED" } });
    expect(h.deletes).toHaveLength(0);
    expect(h.rows[0]).toMatchObject({ status: "COMPLETED" });
    expectNoOrphanedCompletion();
  });

  it("a storage failure during abort releases the claim: the row is still PENDING and a retry works", async () => {
    seedPending();
    h.failDeletes = 1;

    const first = await outcome(service.abortUploadIntent({ actor: student, fileId: "file-1" }));
    expect(first).toMatchObject({ ok: false, error: { status: 503, code: "STORAGE_UNAVAILABLE" } });
    expect(h.rows[0]).toMatchObject({ status: "PENDING", purgedAt: null });
    expect(h.objects.has(KEY)).toBe(true);

    const retry = await service.abortUploadIntent({ actor: student, fileId: "file-1" });
    expect(retry).toEqual({ released: true });
    expect(h.rows).toHaveLength(0);
    expect(h.objects.has(KEY)).toBe(false);
  });

  it("two aborts on the same row: exactly one deletes the object", async () => {
    seedPending();
    const results = await Promise.all([
      outcome(service.abortUploadIntent({ actor: student, fileId: "file-1" })),
      outcome(service.abortUploadIntent({ actor: student, fileId: "file-1" })),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ status: 409, code: "ALREADY_PROCESSED" }) }),
    ]);
    expect(h.deletes).toEqual([KEY]);
    expect(h.rows).toHaveLength(0);
  });
});

describe("expiry sweep against a completion", () => {
  it("a completion verified before the sweep claimed the row cannot land on the swept row", async () => {
    const { token } = seedPending({ intentExpiresAt: new Date(Date.now() + 60_000) });
    // Completion reads the row and the object while the intent is still live. Then the intent expires
    // and the sweep runs before completion's guarded write.
    h.afterStat = async () => {
      h.afterStat = null;
      h.rows[0].intentExpiresAt = new Date(Date.now() - 1_000);
      await service.releaseExpiredIntents(50);
    };

    const res = await outcome(service.completeUploadIntent({ actor: student, fileId: "file-1", token }));

    expect(res).toMatchObject({ ok: false, error: { status: 409, code: "ALREADY_COMPLETED" } });
    expect(h.rows).toHaveLength(0);
    expect(h.objects.has(KEY)).toBe(false);
    expectNoOrphanedCompletion();
  });

  it("a completion that wins before the sweep looks is left alone by the sweep", async () => {
    const { token } = seedPending();
    await service.completeUploadIntent({ actor: student, fileId: "file-1", token });
    // Time passes beyond the intent window; a completed row has no live intent to expire.
    h.rows[0].intentExpiresAt = new Date(Date.now() - 1_000);

    const report = await service.releaseExpiredIntents(50);

    expect(report).toMatchObject({ released: 0, attempted: 0 });
    expect(h.rows[0]).toMatchObject({ status: "COMPLETED" });
    expectNoOrphanedCompletion();
  });

  it("an expired completion that cannot delete its object keeps the row PENDING, so the sweep retries it", async () => {
    const { token } = seedPending({ intentExpiresAt: new Date(Date.now() - 1_000) });
    h.failDeletes = 1;

    const res = await outcome(service.completeUploadIntent({ actor: student, fileId: "file-1", token }));

    expect(res).toMatchObject({ ok: false, error: { status: 410, code: "EXPIRED" } });
    // Not FAILED: FAILED rows are not retried by the sweep, so the object would be stranded.
    expect(h.rows[0]).toMatchObject({ status: "PENDING", purgedAt: null });
    expect(h.objects.has(KEY)).toBe(true);

    const report = await service.releaseExpiredIntents(50);
    expect(report).toMatchObject({ released: 1, failed: 0 });
    expect(h.rows).toHaveLength(0);
    expect(h.objects.has(KEY)).toBe(false);
  });

  it("an expired completion whose delete succeeds marks the row FAILED under its claim, with the object gone", async () => {
    const { token } = seedPending({ intentExpiresAt: new Date(Date.now() - 1_000) });

    const res = await outcome(service.completeUploadIntent({ actor: student, fileId: "file-1", token }));

    expect(res).toMatchObject({ ok: false, error: { status: 410, code: "EXPIRED" } });
    expect(h.objects.has(KEY)).toBe(false);
    expect(h.rows[0]).toMatchObject({ status: "FAILED", analysisStatus: "FAILED" });
    expect(h.rows[0].purgedAt).toBeInstanceOf(Date);
    expectNoOrphanedCompletion();
  });

  it("two sweeps running together delete each object exactly once", async () => {
    seedExpired("a");
    seedExpired("b");

    const [one, two] = await Promise.all([service.releaseExpiredIntents(50), service.releaseExpiredIntents(50)]);

    expect(h.deletes.slice().sort()).toEqual(["user-owner/a.pdf", "user-owner/b.pdf"]);
    expect(h.rows).toHaveLength(0);
    expect(one.released + two.released).toBe(2);
  });
});

describe("claims left behind by a stopped request", () => {
  it("a claim younger than the lease is not touched by the sweep", async () => {
    seedExpired("a", { purgedAt: new Date(Date.now() - 60_000), status: "PENDING" });

    const report = await service.releaseExpiredIntents(50);

    expect(report).toMatchObject({ released: 0 });
    expect(h.deletes).toHaveLength(0);
    expect(h.rows).toHaveLength(1);
  });

  it("a claim older than the lease is finished: the object is deleted again, then the row", async () => {
    // A request claimed the row and stopped before deleting. Its object may still exist.
    const stale = new Date(Date.now() - service.CLAIM_LEASE_MS - 1_000);
    seedExpired("a", { purgedAt: stale, status: "PENDING" });

    const report = await service.releaseExpiredIntents(50);

    expect(report).toMatchObject({ released: 1, failed: 0 });
    expect(h.objects.has("user-owner/a.pdf")).toBe(false);
    expect(h.rows).toHaveLength(0);
  });

  it("a stale claim whose object cannot be deleted stays for the next run, and is reported", async () => {
    const stale = new Date(Date.now() - service.CLAIM_LEASE_MS - 1_000);
    seedExpired("a", { purgedAt: stale, status: "PENDING" });
    h.failDeletes = 1;

    const first = await service.releaseExpiredIntents(50);
    expect(first).toMatchObject({ released: 0, failed: 1 });
    expect(h.rows).toHaveLength(1);

    const second = await service.releaseExpiredIntents(50);
    expect(second).toMatchObject({ released: 1, failed: 0 });
    expect(h.rows).toHaveLength(0);
  });
});
