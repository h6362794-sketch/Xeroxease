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

function resolveBaseDir(): string {
  const dir = env.LOCAL_STORAGE_DIR;
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
 * the entire file (up to 100 MB) just to inspect a 16-byte signature.
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
