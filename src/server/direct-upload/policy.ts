// Direct-to-storage upload protocol — pure decision logic.
//
// This module deliberately imports neither Prisma nor the storage adapter: every
// function here is a deterministic decision over plain data, so the security
// properties can be unit-tested without a database or a cloud project. The database
// and storage side lives in `./service.ts`.
//
// Why this exists at all: a Vercel Function caps a request *and* response body at
// 4.5 MB, while the product requires 100 MB documents. The only architecture that
// satisfies both is "server authorizes, browser transfers, server verifies":
//
//   1. POST /api/uploads/intent    → server validates metadata, creates the PENDING
//      document row, mints the object key and a scoped single-use upload URL.
//   2. PUT  <signed storage URL>   → bytes go browser → storage. Never through us.
//   3. POST /api/uploads/complete  → server re-reads the object (size, signature)
//      and only then marks the document COMPLETED / attachable to an print order.
//   4. POST /api/uploads/abort     → release an intent and delete its orphan.
//
// The signed URL is bound to exactly one object path for a bounded time, and the
// completion token additionally binds the *document row*, the *owner* and the
// *claimed size*, so a token cannot be replayed against a different file or user.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ALLOWED_UPLOAD_TYPES, MAX_FILE_SIZE } from "@/lib/constants";
import { getExtension, hasDoubleExtension, sanitizeFilename, validateUpload } from "@/server/file-validation";
import { env } from "@/server/env";

export const INTENT_TOKEN_VERSION = "v1";
/** Absolute ceiling for an intent's lifetime regardless of operator configuration. */
export const MAX_INTENT_TTL_SECONDS = 3600;
/** How many leading bytes are read back to confirm the stored object's signature. */
export const SIGNATURE_PROBE_BYTES = 16;

/** A byte size the client declares. Rejected unless it is a plain, sane integer. */
export function normalizeDeclaredSize(input: unknown): number | null {
  if (typeof input === "string") {
    if (!/^\d{1,12}$/.test(input.trim())) return null;
    return Number(input.trim());
  }
  if (typeof input === "number") {
    return Number.isSafeInteger(input) ? input : null;
  }
  return null;
}

/** The limit that actually binds us: the app's 100 MB and any lower provider cap. */
export function effectiveMaxBytes(): number {
  const providerCap = env.STORAGE_PROVIDER_MAX_FILE_BYTES;
  return providerCap > 0 ? Math.min(MAX_FILE_SIZE, providerCap) : MAX_FILE_SIZE;
}

/** How long an intent stays completable, clamped to a hard ceiling. */
export function intentTtlSeconds(): number {
  return Math.max(60, Math.min(MAX_INTENT_TTL_SECONDS, env.UPLOAD_INTENT_TTL_SECONDS));
}

/** Random, unguessable and short enough to be stored as an opaque id. */
export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IntentClaim {
  v: string;
  fileId: string;
  uploaderId: string;
  storageKey: string;
  sizeBytes: number;
  /** Unix seconds after which the token is void. */
  exp: number;
  n: string;
}

export type IntentVerification =
  | { ok: true; claim: IntentClaim }
  | { ok: false; reason: string; status: number };

function hmacFor(payload: string): string {
  return createHmac("sha256", env.SESSION_SECRET)
    .update(`${INTENT_TOKEN_VERSION}:${payload}`)
    .digest("base64url");
}

/**
 * Sign a completion token. The secret is the existing `SESSION_SECRET` — reusing it
 * means there is no second secret to provision, and it is already required to be
 * long, random and environment-specific.
 */
export function issueIntentToken(claim: IntentClaim): string {
  const payload = Buffer.from(JSON.stringify(claim), "utf8").toString("base64url");
  return `${INTENT_TOKEN_VERSION}.${payload}.${hmacFor(payload)}`;
}

/**
 * Verify a completion token *structurally*: signature, version, shape and expiry.
 * Binding the claims to the database row is a separate step (`uploadTokenMatchesRow`)
 * so both halves stay independently testable.
 */
export function verifyIntentToken(token: string, nowMs = Date.now()): IntentVerification {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "missing token", status: 400 };
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== INTENT_TOKEN_VERSION) {
    return { ok: false, reason: "malformed token", status: 400 };
  }
  const payload = parts[1];
  const signature = parts[2];

  let expected: string;
  try {
    expected = hmacFor(payload);
  } catch {
    return { ok: false, reason: "configuration error", status: 500 };
  }
  // Compare digests, not strings: constant time and immune to length differences.
  const a = createHash("sha256").update(signature ?? "").digest();
  const b = createHash("sha256").update(expected).digest();
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad signature", status: 403 };
  }

  let claim: IntentClaim;
  try {
    claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as IntentClaim;
  } catch {
    return { ok: false, reason: "unreadable token", status: 400 };
  }
  if (
    typeof claim !== "object" ||
    claim === null ||
    claim.v !== INTENT_TOKEN_VERSION ||
    typeof claim.fileId !== "string" ||
    typeof claim.uploaderId !== "string" ||
    typeof claim.storageKey !== "string" ||
    typeof claim.sizeBytes !== "number" ||
    typeof claim.exp !== "number" ||
    typeof claim.n !== "string"
  ) {
    return { ok: false, reason: "malformed claims", status: 400 };
  }
  if (claim.exp * 1000 <= nowMs) {
    return { ok: false, reason: "expired", status: 410 };
  }
  return { ok: true, claim };
}

/**
 * The token is only valid for the row it was minted for, and only until the row's
 * recorded expiry. The row stores a *hash* of the token, so a leaked row cannot be
 * replayed and a re-issued intent invalidates the previous token immediately.
 */
export function uploadTokenMatchesRow(
  claim: IntentClaim,
  token: string,
  file: {
    id: string;
    uploaderId: string;
    storageKey: string | null;
    intentTokenHash: string | null;
  }
): boolean {
  if (file.id !== claim.fileId) return false;
  if (file.uploaderId !== claim.uploaderId) return false;
  if (!file.storageKey || file.storageKey !== claim.storageKey) return false;
  if (!file.intentTokenHash) return false;
  return file.intentTokenHash === tokenHash(token);
}

export interface UploadIntentDecisionInput {
  filename: string;
  declaredMime: string;
  /** `null` when the client sent something that is not a sane byte count. */
  sizeBytes: number | null;
  fileCountInProgress: number;
  maxFilesPerOrder: number;
}

export type UploadIntentDecision =
  | { ok: true; safeName: string; ext: string; mime: string }
  | { ok: false; status: number; error: string; code?: string };

/**
 * Everything the server can decide *before* any bytes exist. This mirrors the checks
 * the proxy route performs on real bytes, minus the magic-byte probe (there are no
 * bytes yet) — which is exactly why completion re-verifies the stored object.
 */
export function decideUploadIntent(input: UploadIntentDecisionInput): UploadIntentDecision {
  const { filename, declaredMime, sizeBytes, fileCountInProgress, maxFilesPerOrder } = input;

  if (typeof filename !== "string" || filename.trim().length === 0) {
    return { ok: false, status: 400, error: "A filename is required." };
  }
  if (hasDoubleExtension(filename)) {
    return { ok: false, status: 400, error: "Suspicious filename rejected." };
  }
  const safeName = sanitizeFilename(filename);
  const ext = getExtension(safeName);
  if (!ALLOWED_UPLOAD_TYPES.includes(ext as (typeof ALLOWED_UPLOAD_TYPES)[number])) {
    return {
      ok: false,
      status: 400,
      error: `Unsupported file type: .${ext || "unknown"}. Allowed: ${ALLOWED_UPLOAD_TYPES.join(", ")}.`,
    };
  }
  if (sizeBytes === null) {
    return { ok: false, status: 400, error: "sizeBytes must be a whole number of bytes.", code: "BAD_SIZE" };
  }
  if (sizeBytes <= 0) {
    return { ok: false, status: 400, error: "Empty file.", code: "EMPTY_FILE" };
  }
  const limit = effectiveMaxBytes();
  if (sizeBytes > MAX_FILE_SIZE) {
    return {
      ok: false,
      status: 413,
      error: `File exceeds the ${Math.floor(MAX_FILE_SIZE / (1024 * 1024))} MB limit.`,
      code: "TOO_LARGE",
    };
  }
  if (sizeBytes > limit) {
    return {
      ok: false,
      status: 413,
      error:
        `File exceeds the storage provider's limit of ${Math.floor(limit / (1024 * 1024))} MB. ` +
        `The application accepts up to ${Math.floor(MAX_FILE_SIZE / (1024 * 1024))} MB — raise the ` +
        `provider's file-size limit (the bucket's global limit, mirrored in ` +
        `STORAGE_PROVIDER_MAX_FILE_BYTES) to serve this file.`,
      code: "PROVIDER_TOO_LARGE",
    };
  }
  // Same declared-MIME rule as the proxy route: browsers legitimately send
  // application/octet-stream, so a mismatch is only rejected when a specific type
  // was declared. The synthetic header below satisfies the signature rule, which is
  // re-checked against real bytes at completion.
  const probe = validateUpload(safeName, declaredMime || "", sizeBytes, signatureFor(ext));
  if (!probe.ok) {
    return { ok: false, status: 400, error: probe.error ?? "Invalid file.", code: "TYPE_REJECTED" };
  }
  if (fileCountInProgress >= maxFilesPerOrder) {
    return {
      ok: false,
      status: 409,
      error: `You can attach up to ${maxFilesPerOrder} files per order.`,
      code: "QUOTA",
    };
  }
  return { ok: true, safeName, ext, mime: probe.mime };
}

/**
 * A synthetic header matching the extension's expected signature. Only the *type*
 * rules are evaluated at intent time; the *signature* of the real bytes is verified
 * at completion.
 */
function signatureFor(ext: string): Uint8Array {
  if (ext === "pdf") {
    return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0, 0, 0, 0, 0, 0, 0, 0]);
  }
  if (ext === "doc" || ext === "ppt") {
    return new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0, 0, 0, 0, 0]);
  }
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
}

/** The shape `decideCompletion` needs from the document row. */
export interface CompletionFileRow {
  id: string;
  uploaderId: string;
  storageKey: string | null;
  sizeBytes: number;
  mimeType: string;
  originalName: string;
  status: string;
  checksum: string | null;
  intentExpiresAt: Date | null;
  intentTokenHash: string | null;
}

export interface CompletionCheckInput {
  file: CompletionFileRow;
  claim: IntentClaim;
  /** Metadata reported by the storage backend, or `null` when there is no object. */
  info: { sizeBytes: number | null; mimeType: string | null } | null;
  /** First bytes read back from the stored object, or `null` when unreadable. */
  headerBytes: Uint8Array | null;
  actorId: string;
  nowMs?: number;
}

export type CompletionDecision =
  | { ok: true; verifiedSizeBytes: number; checksum: string; alreadyCompleted: boolean; mimeType: string }
  | { ok: false; status: number; error: string; code: string; deleteObject: boolean };

/**
 * The decisive check: does the object that actually exists match what was
 * authorized?
 *
 * Client-supplied metadata is never consulted — size comes from the storage backend
 * and the signature from the stored bytes. A row whose claims disagree with the
 * object is failed, not trusted.
 */
export function decideCompletion(input: CompletionCheckInput): CompletionDecision {
  const { file, claim, info, headerBytes, actorId } = input;
  const nowMs = input.nowMs ?? Date.now();

  // Same answer for "not yours" and "does not exist": no existence oracle.
  if (file.uploaderId !== actorId) {
    return { ok: false, status: 403, error: "Document not found.", code: "FORBIDDEN", deleteObject: false };
  }
  if (claim.fileId !== file.id || claim.uploaderId !== file.uploaderId) {
    return {
      ok: false,
      status: 403,
      error: "This upload authorization does not match the document.",
      code: "TOKEN_MISMATCH",
      deleteObject: false,
    };
  }
  if (!file.storageKey || claim.storageKey !== file.storageKey) {
    return {
      ok: false,
      status: 403,
      error: "This upload authorization does not match the document.",
      code: "KEY_MISMATCH",
      deleteObject: false,
    };
  }
  if (file.status === "FAILED") {
    // Refuse with the object left in place and the row left FAILED: re-opening a
    // rejected document with a still-valid token would be a second bite at the same
    // apple, and the completion path writes `COMPLETED` without re-checking.
    return {
      ok: false,
      status: 409,
      error: "This document was rejected on verification and can no longer be completed.",
      code: "ALREADY_FAILED",
      deleteObject: false,
    };
  }
  if (file.status === "COMPLETED") {
    // Idempotent retry: completing an already-verified document is not an error and
    // must not re-read the object or rewrite the row.
    return {
      ok: true,
      verifiedSizeBytes: file.sizeBytes,
      checksum: file.checksum ?? "",
      alreadyCompleted: true,
      mimeType: file.mimeType,
    };
  }
  if (file.intentExpiresAt && file.intentExpiresAt.getTime() <= nowMs) {
    return {
      ok: false,
      status: 410,
      error: "The upload window has expired. Please start the upload again.",
      code: "EXPIRED",
      deleteObject: true,
    };
  }
  if (claim.exp * 1000 <= nowMs) {
    return {
      ok: false,
      status: 410,
      error: "The upload window has expired. Please start the upload again.",
      code: "EXPIRED",
      deleteObject: true,
    };
  }
  if (info === null) {
    return {
      ok: false,
      status: 409,
      error: "The uploaded object could not be found. Please upload the file again.",
      code: "OBJECT_MISSING",
      deleteObject: false,
    };
  }
  const size = info.sizeBytes;
  if (size === null || !Number.isFinite(size) || size <= 0) {
    return {
      ok: false,
      status: 409,
      error: "The stored object could not be measured. Please try again.",
      code: "UNVERIFIED",
      deleteObject: false,
    };
  }
  if (size > MAX_FILE_SIZE) {
    return {
      ok: false,
      status: 413,
      error: `The stored object is larger than the ${Math.floor(MAX_FILE_SIZE / (1024 * 1024))} MB limit.`,
      code: "TOO_LARGE",
      deleteObject: true,
    };
  }
  if (size !== claim.sizeBytes) {
    return {
      ok: false,
      status: 422,
      error: "The uploaded file does not match the declared size. Please upload the file again.",
      code: "SIZE_MISMATCH",
      deleteObject: true,
    };
  }
  if (headerBytes === null || headerBytes.length === 0) {
    return {
      ok: false,
      status: 409,
      error: "The stored object could not be read. Please try again.",
      code: "UNVERIFIED",
      deleteObject: false,
    };
  }
  const signatureCheck = validateUpload(file.originalName, file.mimeType, size, headerBytes);
  if (!signatureCheck.ok) {
    return {
      ok: false,
      status: 422,
      error: `The stored object is not a valid ${getExtension(file.originalName).toUpperCase()} file. ${
        signatureCheck.error ?? ""
      }`.trim(),
      code: "SIGNATURE_MISMATCH",
      deleteObject: true,
    };
  }
  return {
    ok: true,
    verifiedSizeBytes: size,
    checksum: sha256Hex(headerBytes, size),
    alreadyCompleted: false,
    mimeType: file.mimeType || signatureCheck.mime,
  };
}

/**
 * Fingerprint recorded alongside the verified size. Deliberately a *verification
 * fingerprint*, not a content-integrity guarantee: computing it from the first bytes
 * plus the length avoids re-downloading 100 MB at completion time, while still
 * detecting a swapped or truncated object.
 */
function sha256Hex(headerBytes: Uint8Array, sizeBytes: number): string {
  return createHash("sha256")
    .update(headerBytes)
    .update(`|${sizeBytes}`)
    .digest("hex");
}

export interface UploadIntentGrantInput {
  fileId: string;
  uploaderId: string;
  storageKey: string;
  sizeBytes: number;
  /** Remaining seconds in which the grant may be completed (already clamped). */
  ttlSeconds: number;
  nowMs?: number;
}

export interface UploadIntentGrant {
  token: string;
  tokenHash: string;
  /** Absolute deadline as a JS Date, for storage in `intent_expires_at`. */
  expiresAt: Date;
  /** Unix seconds, as embedded in the token itself. */
  expiresAtEpochSec: number;
  nonce: string;
}

/**
 * Mint the completion credential for an intent.
 *
 * The credential is derived from data the server generated (row id, owner, key,
 * claimed size) and a fresh nonce, so nothing the client supplied can widen its
 * scope, and two intents for the same row always produce distinct tokens.
 */
export function issueUploadIntentGrant(input: UploadIntentGrantInput): UploadIntentGrant {
  const nowMs = input.nowMs ?? Date.now();
  const expiresAtEpochSec = Math.floor(nowMs / 1000) + input.ttlSeconds;
  const nonce = newNonce();
  const claim: IntentClaim = {
    v: INTENT_TOKEN_VERSION,
    fileId: input.fileId,
    uploaderId: input.uploaderId,
    storageKey: input.storageKey,
    sizeBytes: input.sizeBytes,
    exp: expiresAtEpochSec,
    n: nonce,
  };
  const token = issueIntentToken(claim);
  return {
    token,
    tokenHash: tokenHash(token),
    expiresAt: new Date(expiresAtEpochSec * 1000),
    expiresAtEpochSec,
    nonce,
  };
}

// ---------- Download authorization ----------

/**
 * The download rule, expressed once so it can be tested: the owner, or any admin
 * role — desk staff must be able to print what students upload. `isAdminRole` is
 * passed in rather than imported to keep this module free of Next.js/cookie
 * dependencies (it lives in `src/server/auth.ts`).
 */
export function canAccessFile(
  file: { uploaderId: string },
  actor: { id: string; role: string },
  isAdminRole: (role: string) => boolean
): boolean {
  return file.uploaderId === actor.id || isAdminRole(actor.role);
}

export type DownloadMode = "download" | "view";

/** Unknown or absent values fall back to the conservative `download` behaviour. */
export function normalizeDownloadMode(raw: string | null | undefined): DownloadMode {
  return raw === "view" ? "view" : "download";
}
