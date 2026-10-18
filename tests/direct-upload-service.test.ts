// Direct-to-private-storage uploads — service-layer tests.
//
// These exercise the half of the protocol that touches the database and the storage
// adapter, with both faked. The point is not "does Supabase sign URLs correctly" (it is
// not called here at all — see TESTING.md, "Where mocks stand in for real
// infrastructure"); the point is that our code asks the right questions, records only
// the right answers, and never marks a document usable without a measured object.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const MB = 1024 * 1024;
const OWNER = "user-owner";
const OTHER = "user-intruder";
const KEY = "user-owner/1700000000000-abc123-notes.pdf";
const PDF_HEADER = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0, 0, 0, 0, 0, 0, 0, 0]);
const GARBAGE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);

type EnvOverrides = Record<string, unknown>;
let envOverrides: EnvOverrides = {};

const defaults: EnvOverrides = {
  SESSION_SECRET: "test-secret-0123456789abcdef-32-chars-min!",
  STORAGE_BACKEND: "supabase",
  STORAGE_BUCKET: "documents",
  LOCAL_STORAGE_DIR: ".data/uploads",
  SUPABASE_URL: "https://test-project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  DIRECT_UPLOADS_ENABLED: true,
  UPLOAD_INTENT_TTL_SECONDS: 600,
  SIGNED_DOWNLOAD_URL_TTL_SECONDS: 60,
  STORAGE_PROVIDER_MAX_FILE_BYTES: 0,
  RATE_LIMIT_STORAGE: "memory",
  TRUSTED_PROXY_COUNT: 1,
};

/** A mock that keeps its `.mock` call log and still matches the service's call sites. */
type Fn = ReturnType<typeof vi.fn>;

/** Reveal vitest's mock API on a `vi.fn()` value that was typed as a plain function. */
function mock(fn: unknown): Fn {
  return fn as Fn;
}

/** Call log of a mock, mapped to the *first argument* of each call. */
function calls<T>(fn: unknown): T[] {
  return mock(fn).mock.calls.map((args: unknown[]) => args[0]) as unknown as T[];
}

function lastCall<T>(fn: unknown): T {
  const all = calls<T>(fn);
  return all[all.length - 1] as T;
}

interface FakeRow {
  id: string;
  uploaderId: string;
  storageKey: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string | null;
  status: string;
  intentExpiresAt: Date | null;
  intentTokenHash: string | null;
  [extra: string]: unknown;
}

function fakeDb() {
  const rows: FakeRow[] = [];
  const db = {
    /** Rows created by the service during a test. */
    rows,
    /** Unattached live intents counted for the quota. 0 keeps the happy path clear. */
    countInProgress: 0,
    order: { findFirst: vi.fn(async () => ({ id: "order-1" })) },
    uploadedFile: {
      count: vi.fn(async () => db.countInProgress),
      create: vi.fn(async (arg: { data: Record<string, unknown>; select?: unknown }) => {
        const row = { id: "file-1", ...arg.data } as unknown as FakeRow;
        rows.push(row);
        return { id: "file-1" };
      }),
      update: vi.fn(async (arg: { where: unknown; data: Record<string, unknown> }) => {
        Object.assign((rows[0] ?? {}) as object, arg.data);
        return { count: 1 };
      }),
      findFirst: vi.fn(async (_arg?: unknown) => null as FakeRow | null),
      findMany: vi.fn(async (_arg?: unknown) => [] as unknown[]),
      deleteMany: vi.fn(async (_arg?: unknown) => ({ count: 1 })),
    },
    $transaction: vi.fn(async (fn: (tx: { uploadedFile: { updateMany: typeof db.uploadedFile.update } }) => Promise<unknown>) =>
      // `$transaction` receives a transaction client; reusing `update` lets a test
      // assert on the guarded `updateMany` write through the same call log.
      fn({ uploadedFile: { updateMany: db.uploadedFile.update } })
    ),
  };
  return db;
}

let db: ReturnType<typeof fakeDb>;
let deleteFile: ReturnType<typeof vi.fn>;
let getStoredObjectInfo: ReturnType<typeof vi.fn>;
let readHeader: ReturnType<typeof vi.fn>;
let buildStorageKey: ReturnType<typeof vi.fn>;
let createSignedUploadTarget: ReturnType<typeof vi.fn>;
let createSignedDownloadUrl: ReturnType<typeof vi.fn>;
let audit: ReturnType<typeof vi.fn>;

type Service = typeof import("@/server/direct-upload/service");
let service: Service;
let policy: typeof import("@/server/direct-upload/policy");

/** A document row as the service reads it, with a live intent attached. */
function rowFor(over: Partial<FakeRow> = {}): FakeRow {
  return {
    id: "file-1",
    uploaderId: OWNER,
    storageKey: KEY,
    originalName: "notes.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4096,
    checksum: null,
    status: "PENDING",
    intentExpiresAt: new Date(Date.now() + 600_000),
    intentTokenHash: null,
    ...over,
  };
}

/** What the storage adapter reports for an object that really is `row`'s file. */
function storedInfo(row: { sizeBytes?: unknown }, over: Record<string, unknown> = {}) {
  return { sizeBytes: (row.sizeBytes as number) ?? 4096, mimeType: "application/pdf", ...over };
}

/** Mint a legitimate grant for `row`, exactly as the service does, and record its hash. */
function grantFor(row: ReturnType<typeof rowFor>) {
  const grant = policy.issueUploadIntentGrant({
    fileId: row.id,
    uploaderId: row.uploaderId as string,
    storageKey: row.storageKey as string,
    sizeBytes: row.sizeBytes as number,
    ttlSeconds: 600,
  });
  row.intentTokenHash = grant.tokenHash;
  return grant;
}

async function loadService() {
  envOverrides = { ...defaults, ...envOverrides };
  vi.resetModules();
  vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));
  vi.doMock("@/server/env", () => ({
    env: new Proxy(envOverrides, {
      get: (t, k: string) => (k in t ? t[k] : defaults[k]),
    }),
  }));
  vi.doMock("@/lib/constants", async () => {
    const real = await vi.importActual<typeof import("@/lib/constants")>("@/lib/constants");
    return { ...real, MAX_FILES_PER_ORDER: 10, MAX_FILE_SIZE: 50 * MB };
  });
  db = fakeDb();
  audit = vi.fn(async () => undefined);
  deleteFile = vi.fn(async () => undefined);
  getStoredObjectInfo = vi.fn(async () => ({ sizeBytes: 4096, mimeType: "application/pdf" }));
  readHeader = vi.fn(async () => PDF_HEADER);
  buildStorageKey = vi.fn(() => KEY);
  createSignedUploadTarget = vi.fn(async () => ({
    uploadUrl: "https://test-project.supabase.co/storage/v1/object/sign/documents/notes.pdf?token=xyz",
    path: KEY,
    expiresIn: 600,
  }));
  createSignedDownloadUrl = vi.fn(async () => ({ url: "https://storage.invalid/signed", expiresIn: 60 }));
  vi.doMock("@/lib/prisma", () => ({ prisma: db }));
  vi.doMock("@/server/audit", () => ({ audit }));
  vi.doMock("@/server/storage", () => ({
    buildStorageKey,
    deleteFile,
    getStoredObjectInfo,
    readHeader,
    StorageError: class StorageError extends Error {},
  }));
  vi.doMock("@/server/direct-upload/storage-bridge", () => ({
    createSignedUploadTarget,
    createSignedDownloadUrl,
  }));
  policy = await import("@/server/direct-upload/policy");
  service = await import("@/server/direct-upload/service");
  return { policy, service };
}

beforeEach(async () => {
  await loadService();
});

afterEach(() => {
  vi.useRealTimers();
  // Tests mutate `envOverrides` in place; reset it so one case cannot leave the
  // feature switched off for every case that follows.
  envOverrides = {};
});

const student = { id: OWNER, role: "STUDENT" } as const;

async function expectError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { status: number; code: string; message: string };
  }
  throw new Error("expected the call to throw");
}

describe("createUploadIntent", () => {
  async function intent(over: Record<string, unknown> = {}) {
    return service.createUploadIntent({
      actor: student,
      filename: "notes.pdf",
      declaredMime: "application/pdf",
      declaredSizeRaw: 4096,
      ...over,
    });
  }

  it("creates a PENDING row, mints a key server-side and returns a scoped target", async () => {
    const res = await intent();
    expect(res).toMatchObject({
      fileId: "file-1",
      method: "PUT",
      maxBytes: 50 * MB,
      headers: {},
      proxyUploadAvailable: false,
      fileSizeLimitNote: null,
    });
    expect(res.uploadUrl).toContain("storage/v1/object/sign");
    // The key the browser may write to is generated here, never accepted from there.
    expect(buildStorageKey).toHaveBeenCalledWith(OWNER, "notes.pdf");
    expect(createSignedUploadTarget).toHaveBeenCalledWith(KEY, { expiresInSec: 600 });
    const created = db.rows[0] as unknown as Record<string, unknown>;
    expect(created).toMatchObject({
      uploaderId: OWNER,
      storageKey: KEY,
      originalName: "notes.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
      status: "PENDING",
      analysisStatus: "PENDING",
      orderId: null,
    });
    // The row keeps a *digest* of the completion credential, never the credential.
    expect(created.intentTokenHash).not.toBe(res.token);
    expect(String(created.intentTokenHash)).toHaveLength(64);
    expect(new Date(String(created.intentExpiresAt)).getTime()).toBeGreaterThan(Date.now());
  });

  it("audits the intent without leaking the token, the key or the signed URL", async () => {
    const res = await intent();
    expect(audit).toHaveBeenCalled();
    const entry = calls<{ action: string; metadata: Record<string, unknown> }>(audit)[0];
    expect(entry.action).toBe("UPLOAD_INTENT_ISSUED");
    const dump = JSON.stringify(entry);
    expect(dump).not.toContain(res.token);
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain("token=xyz");
    expect(dump).not.toContain("service-role");
  });

  it("refuses a size above the application limit before touching storage", async () => {
    const err = await expectError(intent({ declaredSizeRaw: 101 * MB }));
    expect(err).toMatchObject({ status: 413, code: "TOO_LARGE" });
    expect(db.uploadedFile.create).not.toHaveBeenCalled();
    expect(createSignedUploadTarget).not.toHaveBeenCalled();
  });

  it("refuses a size above a lower provider cap and explains the knob", async () => {
    envOverrides.STORAGE_PROVIDER_MAX_FILE_BYTES = 40 * MB;
    await loadService();
    const err = await expectError(service.createUploadIntent({ actor: student, filename: "a.pdf", declaredMime: "", declaredSizeRaw: 45 * MB }));
    expect(err).toMatchObject({ status: 413, code: "PROVIDER_TOO_LARGE" });
    expect(err.message).toContain("STORAGE_PROVIDER_MAX_FILE_BYTES");
    // The capability advertises the lower number so the wizard can pre-flight it.
    const { describeUploadCapability } = await import("@/server/direct-upload/capability");
    expect(describeUploadCapability().providerMaxBytes).toBe(40 * MB);
  });

  it("refuses unsupported types and nonsense sizes", async () => {
    const bad = await expectError(intent({ filename: "report.exe", declaredSizeRaw: 1000 }));
    expect(bad.status).toBe(400);
    const silly = await expectError(intent({ declaredSizeRaw: "100MB" }));
    expect(silly).toMatchObject({ status: 400, code: "BAD_SIZE" });
    expect(db.uploadedFile.create).not.toHaveBeenCalled();
  });

  it("refuses to exceed the per-order file quota", async () => {
    db.countInProgress = 10;
    const err = await expectError(intent());
    expect(err).toMatchObject({ status: 409, code: "QUOTA" });
  });

  it("refuses an order the caller does not own", async () => {
    mock(db.order.findFirst).mockResolvedValueOnce(null);
    const err = await expectError(intent({ orderId: "order-other" }));
    expect(err).toMatchObject({ status: 404, code: "ORDER_NOT_FOUND" });
    expect(db.uploadedFile.create).not.toHaveBeenCalled();
  });

  it("reports a `local` backend as unsupported (501), not broken (500)", async () => {
    envOverrides.STORAGE_BACKEND = "local";
    await loadService();
    const err = await expectError(service.createUploadIntent({ actor: student, filename: "a.pdf", declaredMime: "", declaredSizeRaw: 10 }));
    expect(err).toMatchObject({ name: "DeploymentCapabilityError", status: 501, code: "BACKEND_UNSUPPORTED" });
    expect(err.message).toContain("POST /api/uploads");
  });

  it("refuses when an operator disables the feature, with the flag named", async () => {
    envOverrides.DIRECT_UPLOADS_ENABLED = false;
    await loadService();
    const err = await expectError(service.createUploadIntent({ actor: student, filename: "a.pdf", declaredMime: "", declaredSizeRaw: 10 }));
    expect(err).toMatchObject({ name: "DeploymentCapabilityError", code: "DISABLED" });
    expect(err.message).toContain("DIRECT_UPLOADS_ENABLED");
    expect(db.uploadedFile.create).not.toHaveBeenCalled();
  });

  it("refuses a half-configured Supabase backend instead of silently proxying", async () => {
    envOverrides.SUPABASE_SERVICE_ROLE_KEY = "";
    await loadService();
    const err = await expectError(service.createUploadIntent({ actor: student, filename: "a.pdf", declaredMime: "", declaredSizeRaw: 10 }));
    expect(err).toMatchObject({ name: "DeploymentCapabilityError", code: "SUPABASE_UNCONFIGURED" });
  });
});

describe("completeUploadIntent", () => {
  async function complete(row: FakeRow, token: unknown) {
    mock(db.uploadedFile.findFirst).mockResolvedValueOnce(row);
    // Default assumption: the object in the bucket is exactly the authorized file.
    // Individual tests override this to describe a discrepancy.
    getStoredObjectInfo.mockImplementation(async () => storedInfo(row));
    return service.completeUploadIntent({ actor: student, fileId: "file-1", token });
  }

  it("accepts a verified object and records the size it *measured*", async () => {
    const row = rowFor({ sizeBytes: 4096 });
    const grant = grantFor(row);
    mock(getStoredObjectInfo).mockResolvedValueOnce(storedInfo(row));
    const res = await complete(row, grant.token);
    expect(res).toMatchObject({ fileId: "file-1", status: "COMPLETED", sizeBytes: 4096, verified: true });
    // The size written to the row is the one read back from storage, not the number the
    // browser sent to /uploads/intent — an equality check on a *measured* value.
    const written = lastCall<{ data: Record<string, unknown> }>(db.uploadedFile.update).data;
    expect(written).toMatchObject({ status: "COMPLETED", sizeBytes: 4096, intentExpiresAt: null });
    expect(written.verifiedAt).toBeInstanceOf(Date);
    expect(String(written.checksum)).toHaveLength(64);
    // It read the object through the adapter, and deleted nothing.
    expect(getStoredObjectInfo).toHaveBeenCalledWith(KEY);
    expect(readHeader).toHaveBeenCalledWith(KEY, 16);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("requires ownership-scoped lookup", async () => {
    mock(db.uploadedFile.findFirst).mockResolvedValueOnce(null);
    const err = await expectError(service.completeUploadIntent({ actor: student, fileId: "foreign", token: "x" }));
    expect(err).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(lastCall<{ where: Record<string, unknown> }>(db.uploadedFile.findFirst).where).toMatchObject({
      id: "foreign",
      uploaderId: OWNER,
    });
    expect(getStoredObjectInfo).not.toHaveBeenCalled();
  });

  it("rejects a missing or non-string token", async () => {
    const row = rowFor();
    grantFor(row);
    // Every variant must be refused with a client error, never a 5xx.
    for (const token of ["", 42, null, { token: "x" }]) {
      const err = await expectError(complete(row, token));
      expect(err.status).toBeLessThan(500);
    }
  });

  it("rejects a token minted for a different document", async () => {
    const grant = grantFor(rowFor());
    // Same owner, same type, same size — but this token belongs to another row, whose
    // own hash is a different digest.
    const other: FakeRow = { ...rowFor({ id: "file-2" }), intentTokenHash: policy.tokenHash("some-other-intent-token") };
    const err = await expectError(complete(other, grant.token));
    expect(err).toMatchObject({ status: 403, code: "TOKEN_MISMATCH" });
    expect(getStoredObjectInfo).not.toHaveBeenCalled();
  });

  it("rejects a token rotated out of existence by a newer intent", async () => {
    const row = rowFor();
    const first = grantFor(row);
    const second = grantFor(row); // re-issue: overwrites the row's digest
    expect(first.token).not.toBe(second.token);
    const err = await expectError(complete(row, first.token));
    expect(err).toMatchObject({ status: 403, code: "TOKEN_MISMATCH" });
  });

  it("rejects a forged signature without reading the object", async () => {
    const row = rowFor();
    const grant = grantFor(row);
    const [v, payload] = grant.token.split(".");
    const forged = `${v}.${payload}.${"A".repeat(43)}`;
    const err = await expectError(complete(row, forged));
    expect(err).toMatchObject({ status: 400, code: "TOKEN_INVALID" });
    expect(getStoredObjectInfo).not.toHaveBeenCalled();
    expect(err.message).not.toContain(grant.token);
  });

  it("fails a widened size claim and deletes the object", async () => {
    // The row claims 4 096 bytes and its token agrees; the object in the bucket does not.
    const row = rowFor();
    const grant = grantFor(row);
    mock(getStoredObjectInfo).mockResolvedValueOnce({ sizeBytes: 9000, mimeType: "application/pdf" }); // != 4096
    const err = await expectError(complete(row, grant.token));
    expect(err).toMatchObject({ status: 422, code: "SIZE_MISMATCH" });
    expect(deleteFile).toHaveBeenCalledWith(KEY);
    const written = lastCall<{ data: Record<string, unknown> }>(db.uploadedFile.update).data;
    expect(written).toMatchObject({ status: "FAILED", analysisStatus: "FAILED" });
    expect(err.message).not.toContain(KEY);
  });

  it("rejects bytes that are not the claimed document type", async () => {
    const row = rowFor();
    const grant = grantFor(row);
    mock(readHeader).mockResolvedValueOnce(GARBAGE);
    const err = await expectError(complete(row, grant.token));
    expect(err).toMatchObject({ status: 422, code: "SIGNATURE_MISMATCH" });
    expect(deleteFile).toHaveBeenCalledWith(KEY);
  });

  it("reports a missing object as retryable (409) without deleting or failing anything", async () => {
    const row = rowFor();
    const grant = grantFor(row);
    mock(getStoredObjectInfo).mockResolvedValueOnce(null);
    const err = await expectError(complete(row, grant.token));
    expect(err).toMatchObject({ status: 409, code: "OBJECT_MISSING" });
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("keeps the row PENDING when storage is unreachable, so a retry can work", async () => {
    const row = rowFor();
    const grant = grantFor(row);
    mock(getStoredObjectInfo).mockRejectedValueOnce(new Error("ETIMEDOUT after 30000ms"));
    const err = await expectError(complete(row, grant.token));
    expect(err).toMatchObject({ status: 503, code: "STORAGE_UNAVAILABLE" });
    // No FAILED write: a provider blip must not punish the user's document.
    expect(db.uploadedFile.update).not.toHaveBeenCalled();
    // And the provider's message is never forwarded to the client.
    expect(err.message).not.toContain("ETIMEDOUT");
  });

  it("refuses a document whose window closed, even with a structurally valid token", async () => {
    const grant = grantFor(rowFor());
    const row: FakeRow = { ...rowFor(), intentTokenHash: grant.tokenHash, intentExpiresAt: new Date(Date.now() - 1000) };
    // The token itself is still inside its own expiry; the *row* is what expired.
    const err = await expectError(complete(row, grant.token));
    expect(err).toMatchObject({ status: 410, code: "EXPIRED" });
    expect(deleteFile).toHaveBeenCalledWith(KEY);
  });

  it("is idempotent for a completed document and never re-reads storage", async () => {
    const grant = grantFor(rowFor());
    const row: FakeRow = { ...rowFor({ status: "COMPLETED", checksum: "f".repeat(64) }), intentTokenHash: grant.tokenHash };
    const res = await complete(row, grant.token);
    expect(res).toMatchObject({ status: "COMPLETED", sizeBytes: 4096, verified: true });
    expect(db.uploadedFile.update).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("does not flip the row when the guarded write loses the race", async () => {
    const row = rowFor();
    const grant = grantFor(row);
    mock(db.uploadedFile.update).mockImplementationOnce(async () => ({ count: 0 }));
    const err = await expectError(complete(row, grant.token));
    expect(err).toMatchObject({ status: 409, code: "ALREADY_COMPLETED" });
  });

  it("audits a rejection with codes only", async () => {
    const row = rowFor();
    const grant = grantFor(row);
    mock(getStoredObjectInfo).mockResolvedValueOnce({ sizeBytes: 12345, mimeType: "application/pdf" });
    await expectError(complete(row, grant.token));
    const entry = lastCall<{ action: string; metadata: Record<string, unknown> }>(audit);
    expect(entry.action).toBe("UPLOAD_COMPLETION_REJECTED");
    expect(entry.metadata).toEqual({ code: "SIZE_MISMATCH", status: 422 });
    expect(JSON.stringify(entry)).not.toContain(grant.token);
  });
});

describe("abortUploadIntent", () => {
  it("deletes the object and the row while unverified", async () => {
    mock(db.uploadedFile.findFirst).mockResolvedValueOnce(rowFor());
    const res = await service.abortUploadIntent({ actor: student, fileId: "file-1" });
    expect(res).toEqual({ released: true });
    expect(deleteFile).toHaveBeenCalledWith(KEY);
    expect(db.uploadedFile.deleteMany).toHaveBeenCalledWith({
      where: { id: "file-1", uploaderId: OWNER, status: "PENDING" },
    });
  });

  it("refuses to release a verified document that may be attached to an order", async () => {
    mock(db.uploadedFile.findFirst).mockResolvedValueOnce(rowFor({ status: "COMPLETED" }));
    const err = await expectError(service.abortUploadIntent({ actor: student, fileId: "file-1" }));
    expect(err).toMatchObject({ status: 409, code: "ALREADY_COMPLETED" });
    expect(deleteFile).not.toHaveBeenCalled();
    expect(db.uploadedFile.deleteMany).not.toHaveBeenCalled();
  });

  it("answers 404 for another user's document", async () => {
    mock(db.uploadedFile.findFirst).mockResolvedValueOnce(null);
    const err = await expectError(service.abortUploadIntent({ actor: { id: OTHER, role: "STUDENT" }, fileId: "file-1" }));
    expect(err).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});

describe("releaseExpiredIntents", () => {
  it("reaps expired rows and their objects, one audit entry per run", async () => {
    mock(db.uploadedFile.findMany).mockResolvedValueOnce([
      { id: "a", storageKey: "user-a/a.pdf", uploaderId: "user-a" },
      { id: "b", storageKey: "user-a/b.pdf", uploaderId: "user-a" },
    ]);
    const report = await service.releaseExpiredIntents(50);
    expect(report).toEqual({ released: 2, attempted: 2, failed: 0 });
    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(calls<{ where: Record<string, unknown> }>(db.uploadedFile.findMany)[0].where).toMatchObject({
      status: "PENDING",
    });
  });

  it("is bounded and reports that it stopped early", async () => {
    mock(db.uploadedFile.findMany).mockResolvedValueOnce([
      { id: "a", storageKey: "k1", uploaderId: "u" },
      { id: "b", storageKey: "k2", uploaderId: "u" },
      { id: "c", storageKey: "k3", uploaderId: "u" },
    ]);
    const report = await service.releaseExpiredIntents(2);
    expect(report).toMatchObject({ released: 2, attempted: 2, failed: 0, cappedAt: 2 });
    expect(deleteFile).toHaveBeenCalledTimes(2);
  });

  it("clamps an abusive limit instead of deleting unbounded", async () => {
    mock(db.uploadedFile.findMany).mockResolvedValueOnce([]);
    await service.releaseExpiredIntents(100_000);
    expect(calls<{ take: number }>(db.uploadedFile.findMany)[0].take).toBe(501);
  });

  it("does not audit when there was nothing to do", async () => {
    mock(db.uploadedFile.findMany).mockResolvedValueOnce([]);
    expect(await service.releaseExpiredIntents()).toEqual({ released: 0, attempted: 0, failed: 0 });
    expect(audit).not.toHaveBeenCalled();
  });

  it("keeps the row when its object cannot be deleted, and reports it as failed", async () => {
    mock(db.uploadedFile.findMany).mockResolvedValueOnce([
      { id: "a", storageKey: "user-a/a.pdf", uploaderId: "user-a" },
      { id: "b", storageKey: "user-a/b.pdf", uploaderId: "user-a" },
    ]);
    mock(deleteFile).mockRejectedValueOnce(new Error("Storage delete failed (503)"));
    const report = await service.releaseExpiredIntents(50);
    expect(report).toEqual({ released: 1, attempted: 2, failed: 1 });
    // The failing row must not be deleted: its bytes would have no record left to retry from.
    const deletedIds = calls<{ where: { id: string } }>(db.uploadedFile.deleteMany).map((c) => c.where.id);
    expect(deletedIds).toEqual(["b"]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ failed: 1 }) }));
  });
});
