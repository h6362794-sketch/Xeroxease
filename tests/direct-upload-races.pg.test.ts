// PostgreSQL-backed race tests for direct-upload intents, completion, abort and expiry.
//
// WHY THIS FILE EXISTS
//
// `tests/direct-upload-races.test.ts` decides races with an in-memory store that honours
// `where` clauses. That proves the ORDERING logic in service.ts. It cannot prove that
// PostgreSQL serialises the conditional writes the service relies on. This file runs the
// real service and the real Prisma client against a real PostgreSQL 16 database, with
// independent connection pools, and checks the invariants after each race.
//
// WHAT IS REAL: the Prisma client, the database, every `updateMany`/`deleteMany` predicate,
// the transactions and the row locks. WHAT IS STUBBED: object storage (an in-memory map of
// keys to sizes, with a small delay on delete to widen the race window), the audit writer,
// and the environment object. No Supabase or other provider is contacted.
//
// WHERE IT RUNS: only in CI's `migrations` job, against the PostgreSQL 16 service container
// that CI creates for that job and throws away. That job sets PG_INTEGRATION_TESTS=1 and
// DATABASE_URL. Locally it is skipped unless both are set. The file never runs against a
// staging or production database: nothing in this repository sets DATABASE_URL for those.
//
// SKIP vs FAIL: when PG_INTEGRATION_TESTS=1 is set but DATABASE_URL is missing, the file
// THROWS at load time. A missing database in the job that asked for one must fail the job,
// not produce a green skip.
//
// SAFETY: every row is created under a uniquely suffixed owner and removed in afterEach /
// afterAll. Nothing pre-existing is read or changed.
//
// Mocked-only claims that this file does NOT make: it does not test storage, the signed
// upload URL, the browser, or the Supabase provider.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const FLAG = process.env.PG_INTEGRATION_TESTS === "1";
if (FLAG && DATABASE_URL.length === 0) {
  throw new Error(
    "PG_INTEGRATION_TESTS=1 but DATABASE_URL is unset: refusing to report the PostgreSQL race tests as skipped."
  );
}
const ENABLED = FLAG && DATABASE_URL.length > 0;

const PDF_HEADER = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0, 0, 0, 0, 0, 0, 0, 0]);
const SIZE = 4096;

// Shared, hoisted state for the storage stub (vi.mock factories are hoisted above top-level consts).
const store = vi.hoisted(() => ({
  objects: new Map<string, number>(),
  deletes: [] as string[],
}));

vi.mock("@/server/env", () => ({
  env: {
    SESSION_SECRET: "pg-race-secret-0123456789abcdef-32-chars-min!",
    STORAGE_BACKEND: "supabase",
    STORAGE_BUCKET: "documents",
    LOCAL_STORAGE_DIR: ".data/uploads",
    SUPABASE_URL: "https://pg-race.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "pg-race-not-a-real-key",
    DIRECT_UPLOADS_ENABLED: true,
    UPLOAD_INTENT_TTL_SECONDS: 600,
    SIGNED_DOWNLOAD_URL_TTL_SECONDS: 60,
    STORAGE_PROVIDER_MAX_FILE_BYTES: 0,
    RATE_LIMIT_STORAGE: "memory",
    TRUSTED_PROXY_COUNT: 1,
  },
}));

vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => undefined) }));

vi.mock("@/server/direct-upload/storage-bridge", () => ({
  createSignedUploadTarget: vi.fn(async (key: string) => ({
    url: `https://pg-race.invalid/upload/${encodeURIComponent(key)}`,
    headers: {},
  })),
}));

vi.mock("@/server/storage", () => ({
  buildStorageKey: (uploaderId: string, name: string) =>
    `${uploaderId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${name}`,
  deleteFile: async (key: string) => {
    store.deletes.push(key);
    // Widen the window between a claim and the object delete, so the race is real.
    await new Promise((r) => setTimeout(r, 15));
    store.objects.delete(key);
  },
  getStoredObjectInfo: async (key: string) => {
    const size = store.objects.get(key);
    return size === undefined ? null : { sizeBytes: size, mimeType: "application/pdf" };
  },
  readHeader: async () => PDF_HEADER,
  StorageError: class StorageError extends Error {},
}));

const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const EMAIL = `upload-race-${SUFFIX}@xeroxease.test`;

type Svc = typeof import("@/server/direct-upload/service");
type Lifecycle = typeof import("@/server/document-lifecycle");

describe.skipIf(!ENABLED)("direct-upload races (real PostgreSQL)", () => {
  let db: any; // assertion + setup client (independent pool from the service's singleton)
  let svc: Svc;
  let lifecycle: Lifecycle;
  let userId: string;
  let actor: { id: string; role: "STUDENT" };
  let seq = 0;

  /** Resolve to an outcome; rethrow anything that is not a service refusal (a DB fault must fail the test). */
  async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
    try {
      return { ok: true, value: await p };
    } catch (err) {
      if (err instanceof svc.UploadServiceError) return { ok: false, code: err.code };
      throw err;
    }
  }

  async function newIntent(opts: { expired?: boolean } = {}) {
    const intent = await svc.createUploadIntent({
      actor,
      filename: `race-${++seq}.pdf`,
      declaredMime: "application/pdf",
      declaredSizeRaw: SIZE,
    });
    const row = await db.uploadedFile.findUniqueOrThrow({ where: { id: intent.fileId } });
    store.objects.set(row.storageKey, SIZE); // the browser "uploaded" the bytes
    if (opts.expired) {
      await db.uploadedFile.update({
        where: { id: row.id },
        data: { intentExpiresAt: new Date(Date.now() - 60_000) },
      });
    }
    return { fileId: row.id as string, token: intent.token as string, key: row.storageKey as string };
  }

  async function rowById(id: string) {
    return db.uploadedFile.findUnique({ where: { id } });
  }

  function deletesFor(key: string) {
    return store.deletes.filter((k) => k === key).length;
  }

  /** The invariant every race must keep: a COMPLETED row always has its object. */
  async function assertNoCompletedWithoutObject(fileId: string, key: string) {
    const row = await rowById(fileId);
    if (row && row.status === "COMPLETED") {
      expect(store.objects.has(key), "COMPLETED row points at a deleted object").toBe(true);
    }
  }

  beforeAll(async () => {
    const { PrismaClient } = await import("@prisma/client");
    db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    svc = await import("@/server/direct-upload/service");
    lifecycle = await import("@/server/document-lifecycle");

    const user = await db.user.create({
      data: {
        email: EMAIL,
        emailNorm: EMAIL.toLowerCase(),
        passwordHash: `pg-race-${SUFFIX}`,
        name: "Upload Race Probe",
        isActive: true,
      },
      select: { id: true },
    });
    userId = user.id;
    actor = { id: userId, role: "STUDENT" };
  });

  afterEach(async () => {
    // Rows and objects are per test; the quota counts unattached documents, so clear them.
    await db.uploadedFile.deleteMany({ where: { uploaderId: userId } });
    await db.order.deleteMany({ where: { userId } });
    store.objects.clear();
    store.deletes.length = 0;
  });

  afterAll(async () => {
    try {
      if (userId) {
        await db.uploadedFile.deleteMany({ where: { uploaderId: userId } });
        await db.order.deleteMany({ where: { userId } });
        await db.user.delete({ where: { id: userId } });
      }
    } finally {
      await db?.$disconnect();
    }
  });

  async function newOrder(suffix: string) {
    return db.order.create({
      data: {
        orderNumber: `XE-PG-${SUFFIX}-${suffix}`,
        userId,
        paperSize: "A4",
        colorMode: "BW",
        totalPages: 1,
        billablePages: 1,
        pricePerPage: "1.00",
        finishingFee: "0.00",
        totalAmount: "1.00",
      },
      select: { id: true },
    });
  }

  // --- intent with a legacy order link ------------------------------------------------

  it("refuses to complete a PENDING row that carries an order, and leaves the object alone", async () => {
    const order = await newOrder("legacy");
    const { fileId, token, key } = await newIntent();
    // Simulate a row written by the removed intent-with-order path.
    await db.uploadedFile.update({ where: { id: fileId }, data: { orderId: order.id } });

    const out = await settle(svc.completeUploadIntent({ actor, fileId, token }));
    expect(out).toEqual({ ok: false, code: "INTENT_NO_LONGER_VALID" });

    const row = await rowById(fileId);
    expect(row.status).toBe("PENDING");
    expect(row.orderId).toBe(order.id);
    expect(store.objects.has(key)).toBe(true);
    expect(deletesFor(key)).toBe(0);
  });

  // --- concurrent completion ----------------------------------------------------------

  it("two concurrent completions of one intent leave exactly one COMPLETED row, with its object", async () => {
    const { fileId, token, key } = await newIntent();

    const results = await Promise.all([
      settle(svc.completeUploadIntent({ actor, fileId, token })),
      settle(svc.completeUploadIntent({ actor, fileId, token })),
    ]);

    // Each call either wins the guarded write or reports the completed row idempotently.
    for (const r of results) {
      if (!r.ok) expect(r.code).toBe("ALREADY_COMPLETED");
    }
    expect(results.some((r) => r.ok)).toBe(true);

    const row = await rowById(fileId);
    expect(row.status).toBe("COMPLETED");
    expect(row.verifiedAt).not.toBeNull();
    expect(row.purgedAt).toBeNull();
    expect(store.objects.has(key)).toBe(true);
    expect(deletesFor(key)).toBe(0);
  });

  // --- abort vs completion ------------------------------------------------------------

  it("abort and completion race on one intent: exactly one wins, and no COMPLETED row loses its object", async () => {
    for (let round = 0; round < 6; round++) {
      const { fileId, token, key } = await newIntent();
      // Stagger the second call by 0–2 ms so the interleavings differ across rounds.
      const later = <T,>(ms: number, fn: () => Promise<T>) =>
        new Promise<void>((r) => setTimeout(r, ms)).then(fn);

      const [abort, complete] = await Promise.all([
        settle(svc.abortUploadIntent({ actor, fileId })),
        settle(later(round % 3, () => svc.completeUploadIntent({ actor, fileId, token }))),
      ]);

      const wins = [abort, complete].filter((r) => r.ok).length;
      expect(wins, `round ${round}: abort=${JSON.stringify(abort)} complete=${JSON.stringify(complete)}`).toBe(1);

      await assertNoCompletedWithoutObject(fileId, key);
      const row = await rowById(fileId);
      if (abort.ok) {
        expect(row).toBeNull();
        expect(store.objects.has(key)).toBe(false);
      } else {
        expect(row?.status).toBe("COMPLETED");
        expect(store.objects.has(key)).toBe(true);
      }
      expect(deletesFor(key)).toBeLessThanOrEqual(1);
      await db.uploadedFile.deleteMany({ where: { uploaderId: userId } });
      store.objects.clear();
      store.deletes.length = 0;
    }
  });

  // --- concurrent aborts --------------------------------------------------------------

  it("two concurrent aborts delete the object once and remove the row once", async () => {
    const { fileId, key } = await newIntent();

    const results = await Promise.all([
      settle(svc.abortUploadIntent({ actor, fileId })),
      settle(svc.abortUploadIntent({ actor, fileId })),
    ]);

    expect(results.filter((r) => r.ok).length).toBe(1);
    for (const r of results) {
      if (!r.ok) expect(["ALREADY_PROCESSED", "NOT_FOUND"]).toContain(r.code);
    }
    expect(deletesFor(key)).toBe(1);
    expect(store.objects.has(key)).toBe(false);
    expect(await rowById(fileId)).toBeNull();
  });

  // --- expiry -------------------------------------------------------------------------

  it("completion and the expiry sweep race on an expired intent: never COMPLETED, object deleted at most once", async () => {
    for (let round = 0; round < 4; round++) {
      const { fileId, token, key } = await newIntent({ expired: true });

      const [complete] = await Promise.all([
        settle(svc.completeUploadIntent({ actor, fileId, token })),
        svc.releaseExpiredIntents(50),
      ]);

      expect(complete.ok).toBe(false); // an expired intent is never completed
      const row = await rowById(fileId);
      expect(row?.status === "COMPLETED", `round ${round}`).toBe(false);
      expect(store.objects.has(key)).toBe(false);
      expect(deletesFor(key)).toBeLessThanOrEqual(1);
      await db.uploadedFile.deleteMany({ where: { uploaderId: userId } });
      store.objects.clear();
      store.deletes.length = 0;
    }
  });

  it("two concurrent expiry sweeps remove each expired row and object exactly once", async () => {
    const keys: string[] = [];
    for (let i = 0; i < 4; i++) keys.push((await newIntent({ expired: true })).key);

    const [a, b] = await Promise.all([svc.releaseExpiredIntents(50), svc.releaseExpiredIntents(50)]);

    expect(a.released + b.released).toBe(4);
    for (const key of keys) {
      expect(deletesFor(key), key).toBe(1);
      expect(store.objects.has(key)).toBe(false);
    }
    const left = await db.uploadedFile.count({ where: { uploaderId: userId } });
    expect(left).toBe(0);
  });

  it("a claim left behind by a stopped request is finished by the sweep, once the lease has passed", async () => {
    const { fileId, key } = await newIntent({ expired: true });
    // The request claimed the row (purgedAt set) and then stopped before deleting anything.
    await db.uploadedFile.update({
      where: { id: fileId },
      data: { purgedAt: new Date(Date.now() - svc.CLAIM_LEASE_MS - 60_000) },
    });

    await svc.releaseExpiredIntents(50);

    expect(deletesFor(key)).toBe(1);
    expect(store.objects.has(key)).toBe(false);
    expect(await rowById(fileId)).toBeNull();
  });

  // --- owner purge vs order link -------------------------------------------------------

  it("owner purge and order attachment race on one verified document: exactly one wins", async () => {
    const order = await newOrder("link");
    const { fileId, key } = await newIntent();
    await db.uploadedFile.update({ where: { id: fileId }, data: { status: "COMPLETED", verifiedAt: new Date() } });
    const doc = await rowById(fileId);

    // The link predicate is the one orders.ts uses inside createOrder's transaction.
    const [purge, link] = await Promise.all([
      lifecycle.purgeUnattachedUpload(fileId, userId),
      db.uploadedFile.updateMany({
        where: {
          id: fileId,
          uploaderId: userId,
          orderId: null,
          status: "COMPLETED",
          purgedAt: null,
          analysisStatus: doc.analysisStatus,
          pageCount: doc.pageCount,
        },
        data: { orderId: order.id },
      }),
    ]);

    const linked = link.count === 1;
    const after = await rowById(fileId);
    if (linked) {
      expect(purge).toBe("not_found");
      expect(after.orderId).toBe(order.id);
      expect(after.purgedAt).toBeNull();
      expect(store.objects.has(key)).toBe(true);
    } else {
      expect(purge).toBe("purged");
      expect(after).toBeNull();
      expect(store.objects.has(key)).toBe(false);
    }
  });
});
