// Direct-to-private-storage uploads — decision-layer tests.
//
// These cover the rules that make it safe for document bytes to bypass the
// application entirely: nothing may be trusted from the client, and nothing may be
// marked usable unless the *stored object* agrees with what was authorized.
//
// `src/server/env.ts` is stubbed so limits are deterministic without a `.env`; the
// policy module itself runs for real. See TESTING.md, "Where mocks stand in for real
// infrastructure" — these tests do NOT prove Supabase behaves as documented.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MAX_FILE_SIZE } from "@/lib/constants";

const MB = 1024 * 1024;

type EnvOverrides = {
  SESSION_SECRET?: string;
  STORAGE_BACKEND?: string;
  DIRECT_UPLOADS_ENABLED?: boolean;
  UPLOAD_INTENT_TTL_SECONDS?: number;
  SIGNED_DOWNLOAD_URL_TTL_SECONDS?: number;
  STORAGE_PROVIDER_MAX_FILE_BYTES?: number;
};

let envOverrides: EnvOverrides = {};

vi.mock("@/server/env", () => ({
  env: {
    get SESSION_SECRET() {
      return envOverrides.SESSION_SECRET ?? "test-secret-0123456789abcdef-32-chars-min!";
    },
    get STORAGE_BACKEND() {
      return envOverrides.STORAGE_BACKEND ?? "supabase";
    },
    get STORAGE_BUCKET() {
      return "documents";
    },
    get LOCAL_STORAGE_DIR() {
      return ".data/uploads";
    },
    get SUPABASE_URL() {
      return "https://test-project.supabase.co";
    },
    get SUPABASE_SERVICE_ROLE_KEY() {
      return "test-service-role-key";
    },
    get DIRECT_UPLOADS_ENABLED() {
      return envOverrides.DIRECT_UPLOADS_ENABLED ?? true;
    },
    get UPLOAD_INTENT_TTL_SECONDS() {
      return envOverrides.UPLOAD_INTENT_TTL_SECONDS ?? 600;
    },
    get SIGNED_DOWNLOAD_URL_TTL_SECONDS() {
      return envOverrides.SIGNED_DOWNLOAD_URL_TTL_SECONDS ?? 60;
    },
    get STORAGE_PROVIDER_MAX_FILE_BYTES() {
      return envOverrides.STORAGE_PROVIDER_MAX_FILE_BYTES ?? 0;
    },
    get RATE_LIMIT_STORAGE() {
      return "memory";
    },
    get TRUSTED_PROXY_COUNT() {
      return 1;
    },
  },
}));

type Policy = typeof import("@/server/direct-upload/policy");
type IntentClaim = import("@/server/direct-upload/policy").IntentClaim;
let policy: Policy;

beforeEach(async () => {
  vi.resetModules();
  policy = await import("@/server/direct-upload/policy");
});

afterEach(() => {
  envOverrides = {};
});

const MB_BYTES = MB;

// ---------------------------------------------------------------------------
// Declared size parsing
// ---------------------------------------------------------------------------

describe("declared size parsing", () => {
  it("accepts plain integers and digit strings", () => {
    expect(policy.normalizeDeclaredSize(1234)).toBe(1234);
    expect(policy.normalizeDeclaredSize("1234")).toBe(1234);
    expect(policy.normalizeDeclaredSize(" 1234 ")).toBe(1234);
    expect(policy.normalizeDeclaredSize(0)).toBe(0);
  });

  it("rejects anything that is not a plain byte count", () => {
    expect(policy.normalizeDeclaredSize("1.5e7")).toBeNull();
    expect(policy.normalizeDeclaredSize("-1")).toBeNull();
    expect(policy.normalizeDeclaredSize(NaN)).toBeNull();
    expect(policy.normalizeDeclaredSize(1.5)).toBeNull();
    expect(policy.normalizeDeclaredSize(Number.MAX_SAFE_INTEGER * 2)).toBeNull();
    expect(policy.normalizeDeclaredSize("100MB")).toBeNull();
    expect(policy.normalizeDeclaredSize(undefined)).toBeNull();
    expect(policy.normalizeDeclaredSize(null)).toBeNull();
    expect(policy.normalizeDeclaredSize({ size: 10 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Intent-time metadata validation
// ---------------------------------------------------------------------------

describe("upload intent validation", () => {
  const base = {
    declaredMime: "application/pdf",
    sizeBytes: 5 * MB_BYTES,
    fileCountInProgress: 0,
    maxFilesPerOrder: 10,
  };

  it("accepts a well-formed PDF request at the 50 MiB boundary (inclusive)", () => {
    const d = policy.decideUploadIntent({ ...base, filename: "notes.pdf", sizeBytes: MAX_FILE_SIZE });
    expect(d.ok).toBe(true);
  });

  it("rejects 50 MiB + 1 byte and says which limit it hit", () => {
    const d = policy.decideUploadIntent({ ...base, filename: "notes.pdf", sizeBytes: MAX_FILE_SIZE + 1 });
    expect(d).toMatchObject({ ok: false, status: 413, code: "TOO_LARGE" });
    expect((d as { error: string }).error).toContain("50 MB");
  });

  it("keeps the application limit at exactly 50 MiB", () => {
    envOverrides.STORAGE_PROVIDER_MAX_FILE_BYTES = 0;
    expect(policy.effectiveMaxBytes()).toBe(50 * MB);
  });

  it("prefers a LOWER provider cap and explains how to raise it", () => {
    // A provider with a 40 MB per-file cap is stricter than the app's 50 MiB limit.
    envOverrides.STORAGE_PROVIDER_MAX_FILE_BYTES = 40 * MB;
    expect(policy.effectiveMaxBytes()).toBe(40 * MB);
    const d = policy.decideUploadIntent({ ...base, filename: "big.pdf", sizeBytes: 45 * MB });
    expect(d).toMatchObject({ ok: false, status: 413, code: "PROVIDER_TOO_LARGE" });
    expect((d as { error: string }).error).toMatch(/STORAGE_PROVIDER_MAX_FILE_BYTES|global file size/);
    // …while a file inside the provider cap is still fine.
    expect(policy.decideUploadIntent({ ...base, filename: "ok.pdf", sizeBytes: 39 * MB }).ok).toBe(true);
  });

  it("never lets a provider cap raise the application limit", () => {
    envOverrides.STORAGE_PROVIDER_MAX_FILE_BYTES = 500 * MB;
    expect(policy.effectiveMaxBytes()).toBe(MAX_FILE_SIZE);
  });

  it("rejects empty and malformed sizes", () => {
    expect(policy.decideUploadIntent({ ...base, filename: "a.pdf", sizeBytes: 0 })).toMatchObject({
      ok: false,
      code: "EMPTY_FILE",
    });
    expect(policy.decideUploadIntent({ ...base, filename: "a.pdf", sizeBytes: null })).toMatchObject({
      ok: false,
      code: "BAD_SIZE",
    });
    expect(policy.decideUploadIntent({ ...base, filename: "   ", sizeBytes: 10 })).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("rejects unsupported extensions", () => {
    for (const name of ["evil.exe", "script.sh", "page.html", "archive.zip", "noext"]) {
      expect(policy.decideUploadIntent({ ...base, filename: name, declaredMime: "application/pdf" })).toMatchObject({
        ok: false,
      });
    }
  });

  it("rejects double extensions before any other consideration", () => {
    expect(policy.decideUploadIntent({ ...base, filename: "invoice.pdf.exe" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("Suspicious filename"),
    });
  });

  it("rejects a declared MIME that contradicts the extension, but allows octet-stream", () => {
    expect(
      policy.decideUploadIntent({ ...base, filename: "notes.pdf", declaredMime: "image/png" })
    ).toMatchObject({ ok: false, code: "TYPE_REJECTED" });
    expect(
      policy.decideUploadIntent({ ...base, filename: "notes.pdf", declaredMime: "application/octet-stream" }).ok
    ).toBe(true);
    expect(policy.decideUploadIntent({ ...base, filename: "notes.pdf", declaredMime: "" }).ok).toBe(true);
  });

  it("accepts every supported document type", () => {
    for (const [name, mime] of [
      ["a.pdf", "application/pdf"],
      ["a.doc", "application/msword"],
      ["a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["a.ppt", "application/vnd.ms-powerpoint"],
      ["a.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ]) {
      expect(policy.decideUploadIntent({ ...base, filename: name, declaredMime: mime }).ok).toBe(true);
    }
  });

  it("enforces the per-order file quota", () => {
    expect(
      policy.decideUploadIntent({ ...base, filename: "a.pdf", fileCountInProgress: 10, maxFilesPerOrder: 10 })
    ).toMatchObject({ ok: false, status: 409, code: "QUOTA" });
  });

  it("strips paths from the stored display name", () => {
    const d = policy.decideUploadIntent({ ...base, filename: "../../etc/passwd.pdf" });
    expect(d.ok).toBe(true);
    expect((d as { safeName: string }).safeName).toBe("passwd.pdf");
  });
});

// ---------------------------------------------------------------------------
// Completion token
// ---------------------------------------------------------------------------

const CLAIM = {
  fileId: "11111111-1111-4111-8111-111111111111",
  uploaderId: "user-a",
  storageKey: "user-a/1700000000000-abcdef-notes.pdf",
  sizeBytes: 5 * MB,
};

/** Decode a grant the way the route does after `verifyIntentToken`. */
function claimsOf(grant: { token: string }): IntentClaim {
  const v = policy.verifyIntentToken(grant.token);
  if (!v.ok) throw new Error(`test fixture produced an invalid token: ${v.reason}`);
  return v.claim;
}

function mint(ttlSeconds = 600, sizeBytes = CLAIM.sizeBytes) {
  return policy.issueUploadIntentGrant({
    ...CLAIM,
    sizeBytes,
    ttlSeconds,
    nowMs: Date.now(),
  });
}

describe("completion token", () => {
  it("produces an unguessable token whose hash is what the row stores", () => {
    const a = mint();
    const b = mint();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
    expect(a.token).toMatch(/^v1\./);
    expect(a.token.length).toBeGreaterThan(60);
    // The plaintext token must be recoverable nowhere from the stored digest.
    expect(a.tokenHash).toHaveLength(64);
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.token).not.toContain(a.tokenHash);
  });

  it("accepts its own token and binds every claim", () => {
    const grant = mint();
    const v = policy.verifyIntentToken(grant.token);
    if (!v.ok) throw new Error(`fixture token rejected: ${v.reason}`);
    expect(v.claim).toMatchObject({
      fileId: CLAIM.fileId,
      uploaderId: CLAIM.uploaderId,
      storageKey: CLAIM.storageKey,
      sizeBytes: CLAIM.sizeBytes,
    });
    expect(v.claim.exp * 1000).toBeGreaterThan(Date.now());
  });

  it("invalidates every outstanding token when SESSION_SECRET is rotated", () => {
    const secretA = "test-secret-0123456789abcdef-32-chars-min!";
    const secretB = "a-completely-different-secret-0123456789abcdef";
    envOverrides.SESSION_SECRET = secretA;
    const grant = mint();
    expect(policy.verifyIntentToken(grant.token).ok).toBe(true);
    // Rotating the signing key must void intents minted under the old one. That is the
    // documented consequence of rotation, and it is the only defence against a
    // captured-and-replayed token once the secret is changed.
    envOverrides.SESSION_SECRET = secretB;
    expect(policy.verifyIntentToken(grant.token)).toMatchObject({
      ok: false,
      reason: "bad signature",
      status: 403,
    });
    // A token minted under B is equally useless back under A.
    const foreignToken = policy.issueIntentToken({
      v: "v1",
      fileId: CLAIM.fileId,
      uploaderId: CLAIM.uploaderId,
      storageKey: CLAIM.storageKey,
      sizeBytes: CLAIM.sizeBytes,
      exp: Math.floor(Date.now() / 1000) + 600,
      n: policy.newNonce(),
    });
    envOverrides.SESSION_SECRET = secretA;
    expect(foreignToken).not.toBe(grant.token);
    expect(policy.verifyIntentToken(foreignToken)).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects tampering with any payload byte, including a widened size claim", () => {
    const grant = mint();
    const [version, payload, signature] = grant.token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    decoded.sizeBytes = MAX_FILE_SIZE * 10;
    const forged = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
    // Keep the original signature: the payload no longer matches it.
    expect(policy.verifyIntentToken(`${version}.${forged}.${signature}`)).toMatchObject({
      ok: false,
      status: 403,
    });
    // Re-signing the widened claim requires the HMAC key, which is server-only — the
    // same path an attacker without the secret would take.
    envOverrides.SESSION_SECRET = "another-secret-used-to-try-a-forged-signature-0123";
    const reSigned = policy.issueIntentToken({ ...decoded, v: version });
    envOverrides.SESSION_SECRET = "test-secret-0123456789abcdef-32-chars-min!";
    expect(reSigned).not.toBe(grant.token);
    expect(policy.verifyIntentToken(reSigned)).toMatchObject({ ok: false, status: 403 });
    // The untouched token still works, so the rejections above are about the payload.
    expect(policy.verifyIntentToken(grant.token).ok).toBe(true);
  });

  it("rejects malformed tokens instead of throwing", () => {
    for (const bad of ["", "garbage", "v1.only-two", "v2.aa.bb", "v1.!!!.###"]) {
      expect(policy.verifyIntentToken(bad).ok).toBe(false);
    }
  });

  it("rejects an expired token (410) and honours the configured TTL", () => {
    const grant = policy.issueUploadIntentGrant({ ...CLAIM, sizeBytes: CLAIM.sizeBytes, ttlSeconds: 60, nowMs: Date.now() - 61_000 });
    expect(policy.verifyIntentToken(grant.token)).toMatchObject({ ok: false, status: 410 });
    // Clamp: a huge configured TTL is never honoured beyond the ceiling.
    envOverrides.UPLOAD_INTENT_TTL_SECONDS = 100_000;
    expect(policy.intentTtlSeconds()).toBe(policy.MAX_INTENT_TTL_SECONDS);
    envOverrides.UPLOAD_INTENT_TTL_SECONDS = 1;
    expect(policy.intentTtlSeconds()).toBe(60);
  });

  it("is only valid for the row it was minted for", () => {
    const grant = mint();
    const verified = policy.verifyIntentToken(grant.token);
    if (!verified.ok) throw new Error(`fixture token rejected: ${verified.reason}`);
    const claim = verified.claim;
    const row = {
      id: CLAIM.fileId,
      uploaderId: CLAIM.uploaderId,
      storageKey: CLAIM.storageKey,
      intentTokenHash: grant.tokenHash,
    };
    expect(policy.uploadTokenMatchesRow(claim, grant.token, row)).toBe(true);
    // Another document, even owned by the same user.
    expect(policy.uploadTokenMatchesRow(claim, grant.token, { ...row, id: "other-id" })).toBe(false);
    // Another user's document that somehow carries the same key.
    expect(policy.uploadTokenMatchesRow(claim, grant.token, { ...row, uploaderId: "user-b" })).toBe(false);
    // Object moved to an unexpected key.
    expect(policy.uploadTokenMatchesRow(claim, grant.token, { ...row, storageKey: "user-a/elsewhere.pdf" })).toBe(false);
    // Token rotated by a newer intent for the same row.
    expect(policy.uploadTokenMatchesRow(claim, grant.token, { ...row, intentTokenHash: "0".repeat(64) })).toBe(false);
    // No recorded hash at all (already completed, or issued before this feature).
    expect(policy.uploadTokenMatchesRow(claim, grant.token, { ...row, intentTokenHash: null })).toBe(false);
    // A validly-signed token for row A must not complete row B.
    const claimB = { ...claim, fileId: "22222222-2222-4222-8222-222222222222" };
    expect(policy.uploadTokenMatchesRow(claimB, grant.token, row)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Completion verification
// ---------------------------------------------------------------------------

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0, 0, 0, 0, 0, 0, 0, 0]);
const NOT_A_PDF = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);

function fileRow(over: Record<string, unknown> = {}) {
  const grant = mint();
  return {
    grant,
    claim: claimsOf(grant),
    file: {
      id: CLAIM.fileId,
      uploaderId: CLAIM.uploaderId,
      storageKey: CLAIM.storageKey,
      originalName: "notes.pdf",
      mimeType: "application/pdf",
      sizeBytes: CLAIM.sizeBytes,
      checksum: null,
      status: "PENDING",
      intentExpiresAt: grant.expiresAt,
      intentTokenHash: grant.tokenHash,
      ...over,
    },
  };
}

function decide(input: Parameters<Policy["decideCompletion"]>[0]) {
  return policy.decideCompletion(input);
}

describe("completion verification (what the object actually is)", () => {
  it("accepts a matching object and returns the *measured* size", () => {
    const { claim, file } = fileRow();
    const d = decide({
      file,
      claim,
      info: { sizeBytes: CLAIM.sizeBytes, mimeType: "text/plain;charset=UTF-8" },
      headerBytes: PDF_MAGIC,
      actorId: CLAIM.uploaderId,
    });
    expect(d).toMatchObject({ ok: true, verifiedSizeBytes: CLAIM.sizeBytes });
    expect((d as { checksum: string }).checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records a size from storage, never the client's claim", () => {
    const { claim, file } = fileRow();
    // Storage reports 4 MB where the client claimed 5 MB: that is a mismatch, not a
    // rounding note.
    const d = decide({
      file,
      claim,
      info: { sizeBytes: 4 * MB, mimeType: null },
      headerBytes: PDF_MAGIC,
      actorId: CLAIM.uploaderId,
    });
    expect(d).toMatchObject({ ok: false, status: 422, code: "SIZE_MISMATCH", deleteObject: true });
  });

  it("fails a missing object without deleting anything it cannot see", () => {
    const { claim, file } = fileRow();
    const d = decide({ file, claim, info: null, headerBytes: null, actorId: CLAIM.uploaderId });
    expect(d).toMatchObject({ ok: false, status: 409, code: "OBJECT_MISSING", deleteObject: false });
  });

  it("rejects an object larger than the application limit even if the claim matched", () => {
    const grant = policy.issueUploadIntentGrant({
      ...CLAIM,
      sizeBytes: MAX_FILE_SIZE + 1,
      ttlSeconds: 600,
    });
    const { file } = fileRow({ sizeBytes: MAX_FILE_SIZE + 1, intentTokenHash: grant.tokenHash });
    const d = decide({
      file,
      claim: claimsOf(grant),
      info: { sizeBytes: MAX_FILE_SIZE + 1, mimeType: null },
      headerBytes: PDF_MAGIC,
      actorId: CLAIM.uploaderId,
    });
    expect(d).toMatchObject({ ok: false, status: 413, code: "TOO_LARGE", deleteObject: true });
  });

  it("accepts a verified object at exactly the 50 MiB limit", () => {
    const grant = policy.issueUploadIntentGrant({ ...CLAIM, sizeBytes: MAX_FILE_SIZE, ttlSeconds: 600 });
    const { file } = fileRow({ sizeBytes: MAX_FILE_SIZE, intentTokenHash: grant.tokenHash });
    const d = decide({
      file,
      claim: claimsOf(grant),
      info: { sizeBytes: MAX_FILE_SIZE, mimeType: null },
      headerBytes: PDF_MAGIC,
      actorId: CLAIM.uploaderId,
    });
    expect(d.ok).toBe(true);
  });

  it("rejects bytes that are not a real PDF despite the extension", () => {
    const { claim, file } = fileRow();
    const d = decide({
      file,
      claim,
      info: { sizeBytes: CLAIM.sizeBytes, mimeType: null },
      headerBytes: NOT_A_PDF,
      actorId: CLAIM.uploaderId,
    });
    expect(d).toMatchObject({ ok: false, status: 422, code: "SIGNATURE_MISMATCH", deleteObject: true });
  });

  it("rejects a row whose storage key is not the authorized one", () => {
    // A row re-pointed at a different object must not be completable with the old
    // grant, even though the token itself is still validly signed.
    const other = fileRow();
    const d1 = decide({
      file: { ...other.file, storageKey: "user-a/other.pdf" },
      claim: other.claim,
      info: { sizeBytes: CLAIM.sizeBytes, mimeType: null },
      headerBytes: PDF_MAGIC,
      actorId: CLAIM.uploaderId,
    });
    expect(d1).toMatchObject({ ok: false, code: "KEY_MISMATCH" });
  });

  it("gives another user's document the same answer as a missing one", () => {
    const other = fileRow();
    const d2 = decide({
      file: { ...other.file, uploaderId: "user-b" },
      claim: other.claim,
      info: { sizeBytes: CLAIM.sizeBytes, mimeType: null },
      headerBytes: PDF_MAGIC,
      actorId: CLAIM.uploaderId,
    });
    // Indistinguishable from "no such document": no existence oracle.
    expect(d2).toMatchObject({ ok: false, status: 403, error: "Document not found." });
  });

  it("is idempotent once COMPLETED and re-reads nothing", () => {
    const { claim, file } = fileRow({ status: "COMPLETED", checksum: "f".repeat(64) });
    const d = decide({ file, claim, info: null, headerBytes: null, actorId: CLAIM.uploaderId });
    expect(d).toMatchObject({ ok: true, alreadyCompleted: true, verifiedSizeBytes: CLAIM.sizeBytes });
  });

  it("refuses to re-open a document that failed verification", () => {
    const { claim, file } = fileRow({ status: "FAILED" });
    const d = decide({
      file,
      claim,
      info: { sizeBytes: CLAIM.sizeBytes, mimeType: null },
      headerBytes: PDF_MAGIC,
      actorId: CLAIM.uploaderId,
    });
    expect(d).toMatchObject({ ok: false, code: "ALREADY_FAILED", deleteObject: false });
  });

  it("refuses an expired window even when the object is perfectly fine", () => {
    const { claim, file } = fileRow({ intentExpiresAt: new Date(Date.now() - 1000) });
    const d = decide({
      file,
      claim,
      info: { sizeBytes: CLAIM.sizeBytes, mimeType: null },
      headerBytes: PDF_MAGIC,
      actorId: CLAIM.uploaderId,
    });
    expect(d).toMatchObject({ ok: false, status: 410, code: "EXPIRED", deleteObject: true });
  });

  it("reports an unreadable object as unverified rather than guessing", () => {
    const { claim, file } = fileRow();
    const d = decide({ file, claim, info: { sizeBytes: null, mimeType: null }, headerBytes: null, actorId: CLAIM.uploaderId });
    expect(d).toMatchObject({ ok: false, status: 409, code: "UNVERIFIED" });
  });

});

// ---------------------------------------------------------------------------
// Download authorization + cache discipline
// ---------------------------------------------------------------------------

describe("download policy", () => {
  let dl: typeof import("@/server/direct-upload/download");
  beforeEach(async () => {
    dl = await import("@/server/direct-upload/download");
  });

  const isAdminRole = (role: string) => role === "ADMIN" || role === "SUPER_ADMIN";
  const subject = {
    id: "f1",
    uploaderId: "user-a",
    originalName: "a.pdf",
    storageKey: "user-a/a.pdf",
    mimeType: "application/pdf",
    status: "COMPLETED",
  };

  it("allows the owner and admin roles, and nobody else", () => {
    expect(dl.authorizeDownload(subject, { id: "user-a", role: "STUDENT" }, isAdminRole).allowed).toBe(true);
    expect(dl.authorizeDownload(subject, { id: "admin", role: "ADMIN" }, isAdminRole).allowed).toBe(true);
    expect(dl.authorizeDownload(subject, { id: "boss", role: "SUPER_ADMIN" }, isAdminRole).allowed).toBe(true);
    expect(dl.authorizeDownload(subject, { id: "user-b", role: "STUDENT" }, isAdminRole).allowed).toBe(false);
  });

  it("answers 'not yours' and 'does not exist' identically", () => {
    expect(dl.authorizeDownload(null, { id: "user-a", role: "STUDENT" }, isAdminRole)).toEqual({ allowed: false });
    expect(dl.authorizeDownload(subject, { id: "user-b", role: "STUDENT" }, isAdminRole)).toEqual({ allowed: false });
  });

  it("marks the redirect as uncacheable and unindexable", () => {
    const headers = dl.downloadRedirectHeaders();
    expect(headers["Cache-Control"]).toContain("no-store");
    expect(headers["Cache-Control"]).toContain("private");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["X-Robots-Tag"]).toContain("noindex");
    // A Vary header would let an intermediary cache one credential per variant.
    expect(headers.Vary).toBeUndefined();
  });

  it("defaults to attachment and honours an explicit view request", () => {
    expect(dl.dispositionFor(policy.normalizeDownloadMode(null))).toBe(true);
    expect(dl.dispositionFor(policy.normalizeDownloadMode("bogus"))).toBe(true);
    expect(dl.dispositionFor(policy.normalizeDownloadMode("view"))).toBe(false);
  });

  it("signs only for the supabase backend and keeps the TTL short", () => {
    expect(dl.shouldSignDownload()).toBe(true);
    expect(dl.signedDownloadTtlSeconds()).toBe(60);
    envOverrides.STORAGE_BACKEND = "local";
    expect(dl.shouldSignDownload()).toBe(false);
  });
});
