// Private storage abstraction. Documents are NEVER publicly accessible.
// BACKENDS: "local" (private directory) | "supabase" (Supabase Storage)

import { mkdir, writeFile, unlink, stat, open } from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { env } from "./env";

/**
 * Single private bucket used for every server-managed object (uploaded documents
 * and the admin-managed payment QR).
 *
 * Earlier documentation listed three buckets (`student-documents`, `payment-qr`,
 * `invoices`) while the code used `documents`; that mismatch meant a deployment
 * following SETUP.md would 404 on every upload. The bucket is now configurable via
 * STORAGE_BUCKET and defaults to the value the code has always used, so existing
 * deployments keep working. Renaming is an explicit operator action (see DATABASE.md).
 */
function bucket(): string {
  return env.STORAGE_BUCKET;
}

function objectUrl(storageKey: string): string {
  return `${env.SUPABASE_URL}/storage/v1/object/${bucket()}/${storageKey
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export class StorageError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

// ---------- Supabase Storage helpers ----------

async function getSupabaseClient() {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new StorageError(
      "Supabase Storage is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or use STORAGE_BACKEND=local for development.",
      500
    );
  }
  return { url, key };
}

const STORAGE_TIMEOUT_MS = 60_000;

async function supabaseUpload(storageKey: string, data: Buffer): Promise<void> {
  const { key } = await getSupabaseClient();
  const res = await fetch(objectUrl(storageKey), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/octet-stream",
      "x-upsert": "true",
    },
    body: new Uint8Array(data),
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    // The upstream body can echo parts of the request; keep it short and never log
    // the Authorization header.
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new StorageError(`Storage upload failed (${res.status}): ${body}`);
  }
}

async function supabaseDownload(storageKey: string, range?: { start: number; end: number }): Promise<Buffer> {
  const { key } = await getSupabaseClient();
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (range) headers.Range = `bytes=${range.start}-${range.end}`;
  const res = await fetch(objectUrl(storageKey), {
    headers,
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });
  if (!res.ok) throw new StorageError(`Storage download failed (${res.status})`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function supabaseDelete(storageKey: string): Promise<void> {
  const { key } = await getSupabaseClient();
  const res = await fetch(objectUrl(storageKey), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 404) {
    throw new StorageError(`Storage delete failed (${res.status})`);
  }
}

async function supabaseExists(storageKey: string): Promise<boolean> {
  const { url, key } = await getSupabaseClient();
  const idx = storageKey.lastIndexOf("/");
  const dir = idx >= 0 ? storageKey.slice(0, idx) : "";
  const file = idx >= 0 ? storageKey.slice(idx + 1) : storageKey;

  const res = await fetch(`${url}/storage/v1/object/list/${bucket()}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: dir ? dir + "/" : "", search: file, limit: 10 }),
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { name?: string }[];
  // `search` is a substring match, so require an exact name match.
  return Array.isArray(data) && data.some((e) => e.name === file);
}

// ---------- Local Storage helpers ----------

function resolveBaseDir(): string {  const dir = env.LOCAL_STORAGE_DIR;
  // Absolute path support; relative paths anchored to project root (process.cwd()).
  return path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
}

function localPath(storageKey: string): string {
  const base = resolveBaseDir();
  const full = path.resolve(base, storageKey);
  const resolvedBase = path.resolve(base);
  // Defense against path traversal
  if (full !== resolvedBase && !full.startsWith(resolvedBase + path.sep)) {
    throw new StorageError("Invalid storage key", 400);
  }
  return full;
}

// ---------- Backend selection ----------

function assertBackend(): void {
  if (env.STORAGE_BACKEND === "supabase" || env.STORAGE_BACKEND === "local") return;
  throw new StorageError(
    `Unknown STORAGE_BACKEND "${env.STORAGE_BACKEND}". Use "local" or "supabase".`,
    500
  );
}

/**
 * Local disk is only safe where the filesystem survives between requests. On
 * ephemeral/serverless hosting the documents would silently disappear while the
 * database rows (and the student's order) remained. Fail loudly unless the operator
 * has explicitly accepted that trade-off.
 */
function assertDurableBackend(): void {
  if (env.STORAGE_BACKEND !== "local") return;
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.ALLOW_EPHEMERAL_LOCAL_STORAGE === "true") {
    console.warn(
      "[storage] STORAGE_BACKEND=local in production with ALLOW_EPHEMERAL_LOCAL_STORAGE=true. Uploaded documents may be lost on redeploy."
    );
    return;
  }
  throw new StorageError(
    "Refusing to store uploaded documents on ephemeral local disk in production. Configure Supabase Storage (STORAGE_BACKEND=supabase) or set ALLOW_EPHEMERAL_LOCAL_STORAGE=true to accept possible data loss.",
    500
  );
}

// ---------- Direct-to-storage uploads (server-authorized, browser-executed) ----------
//
// These are the only operations that make a >4.5 MB upload possible on a function host:
// the bytes never pass through this application. The server asks Storage for a
// single-path, time-limited upload authorization, hands the browser that URL, and
// verifies the stored object independently afterwards. The service-role key is used
// exclusively for these server-side calls and is never returned to a client.

/** Base URL of the Storage API for this project (`.../storage/v1`). */
function storageApiBase(): string {
  return `${env.SUPABASE_URL}/storage/v1`;
}

/** Percent-encode every path segment of a storage key (keys are server-generated). */
function encodedPath(storageKey: string): string {
  return storageKey.split("/").map(encodeURIComponent).join("/");
}

/**
 * Everything the direct-upload protocol needs from a storage backend. A backend that
 * cannot answer these (i.e. `local`) must fail with status 501 so the caller reports an
 * unsupported deployment shape instead of silently degrading to a proxied upload.
 */
function requireSignedUploadSupport(operation: string): void {
  if (env.STORAGE_BACKEND === "supabase") return;
  throw new StorageError(
    `${operation} requires STORAGE_BACKEND=supabase: the local backend cannot issue a ` +
      `browser-usable, scoped storage credential. Uploads keep working through ` +
      `POST /api/uploads (proxy mode) in development.`,
    501
  );
}

export interface SignedUploadTarget {
  /** Absolute URL the browser PUTs the raw bytes to. Already carries the token. */
  uploadUrl: string;
  /** Server-generated object path. Returned for logging/verification only. */
  path: string;
  /** Provider-side expiry of `uploadUrl` (seconds from now), if it reported one. */
  expiresIn: number;
}

/**
 * Ask Storage for a signed upload URL for exactly `storageKey`.
 *
 * Supabase issues this endpoint with `x-upsert: false` semantics by default, so an
 * object that already exists at the key is rejected rather than silently replaced.
 * The returned URL embeds the one-purpose token; the caller must forward it to the
 * authenticated owner and must never log it.
 */
export async function createSignedUploadTarget(
  storageKey: string,
  opts: { expiresInSec: number }
): Promise<SignedUploadTarget> {
  requireSignedUploadSupport("Direct upload");
  const { key } = await getSupabaseClient();
  const res = await fetch(`${storageApiBase()}/object/upload/sign/${bucket()}/${encodedPath(storageKey)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: opts.expiresInSec }),
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new StorageError(`Could not create an upload authorization (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { signedUrl?: string; url?: string; token?: string };
  // The API returns either a full `signedUrl` or a relative `url` with the token in
  // its query string; both describe the same PUT target.
  const raw = data.signedUrl ?? data.url;
  if (!raw) throw new StorageError("Upload authorization response contained no URL");
  // Supabase returns `url` relative to `/storage/v1` (the sign endpoint prefix is
  // stripped from the response), so resolve relative URLs against storageApiBase()
  // — the same base used to call the sign endpoint — not the bare project URL.
  const uploadUrl = raw.startsWith("http")
    ? raw
    : `${storageApiBase()}${raw.startsWith("/") ? "" : "/"}${raw}`;
  return { uploadUrl, path: storageKey, expiresIn: opts.expiresInSec };
}

/**
 * Metadata Storage reports for a stored object. Used to verify an upload against
 * something other than the client's own claim. `null` means "no such object" — the
 * caller treats that as a failed verification, never as a permission detail.
 */
export interface StoredObjectInfo {
  sizeBytes: number | null;
  mimeType: string | null;
}

export async function getStoredObjectInfo(storageKey: string): Promise<StoredObjectInfo | null> {
  if (env.STORAGE_BACKEND === "supabase") {
    const { key } = await getSupabaseClient();
    const res = await fetch(`${storageApiBase()}/object/info/${bucket()}/${encodedPath(storageKey)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new StorageError(`Storage metadata lookup failed (${res.status})`);
    const data = (await res.json()) as {
      size?: number | string;
      metadata?: { size?: number | string; mimeType?: string };
    };
    const sizeRaw = data.metadata?.size ?? data.size;
    const size = sizeRaw === undefined || sizeRaw === null ? null : Number(sizeRaw);
    return {
      sizeBytes: size !== null && Number.isFinite(size) ? size : null,
      mimeType: data.metadata?.mimeType ?? null,
    };
  }
  // Local backend: the filesystem is the source of truth.
  try {
    const st = await stat(localPath(storageKey));
    if (!st.isFile()) return null;
    return { sizeBytes: st.size, mimeType: null };
  } catch {
    return null;
  }
}

export interface SignedDownloadTarget {
  url: string;
  expiresIn: number;
}

/**
 * Short-lived, object-specific read URL for a private object.
 *
 * `download` is a display name only — the caller must have resolved it from a
 * database row, never from user-controlled input at request time.
 */
export async function createSignedDownloadUrl(
  storageKey: string,
  opts: { expiresInSec: number; download?: string }
): Promise<SignedDownloadTarget> {
  requireSignedUploadSupport("Signed download URL");
  const { key } = await getSupabaseClient();
  const res = await fetch(`${storageApiBase()}/object/sign/${bucket()}/${encodedPath(storageKey)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      expiresIn: opts.expiresInSec,
      ...(opts.download ? { download: opts.download } : {}),
    }),
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new StorageError(`Could not create a download authorization (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { signedUrl?: string; signedURL?: string };
  const raw = data.signedUrl ?? data.signedURL;
  if (!raw) throw new StorageError("Download authorization response contained no URL");
  const url = raw.startsWith("http") ? raw : `${env.SUPABASE_URL}${raw.startsWith("/") ? "" : "/"}${raw}`;
  return { url, expiresIn: opts.expiresInSec };
}

/**
 * Startup/deploy-time configuration probe for the direct upload protocol. Throws a
 * single, actionable `StorageError` (status 500) instead of letting a misconfigured
 * deployment half-work: the whole point of the protocol is that bytes bypass the app,
 * which is only true against a browser-reachable private bucket.
 */
export function assertDirectUploadBackend(): void {
  if (env.STORAGE_BACKEND !== "supabase") {
    throw new StorageError(
      "Direct uploads require STORAGE_BACKEND=supabase. Use POST /api/uploads (proxy mode) for local development.",
      500
    );
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new StorageError(
      "Direct uploads are enabled but NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured.",
      500
    );
  }
  if (!/^https:\/\//i.test(env.SUPABASE_URL)) {
    throw new StorageError("NEXT_PUBLIC_SUPABASE_URL must be an https:// URL.", 500);
  }
}

// ---------- Public API ----------

/**
 * Random unguessable storage key: userId-scoped, no user-controlled path parts.
 * The original filename contributes only a sanitised, length-capped suffix for
 * operator readability — never a directory component.
 */
export function buildStorageKey(userId: string, originalName: string): string {
  const safe = sanitizeKeySegment(originalName).slice(-60);
  const owner = sanitizeKeySegment(userId).slice(0, 64) || "unknown";
  return path.posix.join(owner, `${Date.now()}-${randomBytes(12).toString("hex")}-${safe || "file"}`);
}

/**
 * Strip anything that could change the meaning of a storage key: path separators,
 * parent-directory segments, control characters and leading dots (hidden files).
 */
export function sanitizeKeySegment(input: string): string {
  return (
    input
      .split(/[\\/]/)
      .pop()!
      .replace(/[\x00-\x1f\x7f]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[^a-zA-Z0-9._ -]/g, "_")
      .replace(/^\.+/, "")
      .replace(/\.{2,}/g, ".")
      .trim() || "file"
  );
}

export async function saveBuffer(storageKey: string, data: Buffer): Promise<void> {
  assertBackend();
  assertDurableBackend();
  if (env.STORAGE_BACKEND === "supabase") {
    await supabaseUpload(storageKey, data);
    return;
  }
  const full = localPath(storageKey);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, data);
}

export function storagePath(storageKey: string): string {
  // For local backend, return the real filesystem path (used by doc-analysis, file serving).
  // For supabase backend, callers should use readBuffer() instead.
  return localPath(storageKey);
}

export async function readBuffer(storageKey: string): Promise<Buffer> {
  assertBackend();
  if (env.STORAGE_BACKEND === "supabase") {
    return supabaseDownload(storageKey);
  }
  const { readFile } = await import("fs/promises");
  return readFile(localPath(storageKey));
}

export async function fileExists(storageKey: string): Promise<boolean> {
  assertBackend();
  if (env.STORAGE_BACKEND === "supabase") {
    return supabaseExists(storageKey);
  }
  try {
    await stat(localPath(storageKey));
    return true;
  } catch {
    return false;
  }
}

export type StorageStream = NodeJS.ReadableStream | ReadableStream<Uint8Array>;

/**
 * Stream an object without buffering it whole. Works for both backends — the
 * previous local-only implementation meant the payment QR route broke outright as
 * soon as STORAGE_BACKEND=supabase was enabled.
 */
export async function openStream(storageKey: string): Promise<StorageStream> {
  assertBackend();
  if (env.STORAGE_BACKEND === "supabase") {
    const { key } = await getSupabaseClient();
    const res = await fetch(objectUrl(storageKey), {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) throw new StorageError(`Storage download failed (${res.status})`);
    return res.body as ReadableStream<Uint8Array>;
  }
  return createReadStream(localPath(storageKey));
}

export async function deleteFile(storageKey: string): Promise<void> {
  assertBackend();
  if (env.STORAGE_BACKEND === "supabase") {
    await supabaseDelete(storageKey);
    return;
  }
  try {
    await unlink(localPath(storageKey));
  } catch {
    // best-effort
  }
}

/**
 * Read only the first `bytes` of an object. Previously the Supabase path downloaded
 * the entire file (up to 50 MB) just to inspect a 16-byte signature.
 */
export async function readHeader(storageKey: string, bytes = 16): Promise<Buffer> {
  assertBackend();
  if (env.STORAGE_BACKEND === "supabase") {
    const buf = await supabaseDownload(storageKey, { start: 0, end: Math.max(0, bytes - 1) });
    return buf.subarray(0, bytes);
  }
  const fh = await open(localPath(storageKey), "r");
  try {
    const buf = Buffer.alloc(bytes);
    await fh.read(buf, 0, bytes, 0);
    return buf;
  } finally {
    await fh.close();
  }
}
