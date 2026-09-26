// Private storage abstraction. Documents are NEVER publicly accessible.
// BACKENDS: "local" (private directory) | "supabase" (Supabase Storage)

import { createReadStream, existsSync } from "fs";
import { mkdir, writeFile, unlink, stat } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import { env } from "./env";

const BUCKET = "documents";

// ---------- Supabase Storage helpers ----------

async function getSupabaseClient() {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase Storage is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  return { url, key };
}

async function supabaseUpload(storageKey: string, data: Buffer): Promise<void> {
  const { url, key } = await getSupabaseClient();
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodeURIComponent(storageKey)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/octet-stream",
      "x-upsert": "true",
    },
    body: new Uint8Array(data),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase upload failed (${res.status}): ${body}`);
  }
}

async function supabaseDownload(storageKey: string): Promise<Buffer> {
  const { url, key } = await getSupabaseClient();
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodeURIComponent(storageKey)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Supabase download failed (${res.status})`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function supabaseDelete(storageKey: string): Promise<void> {
  const { url, key } = await getSupabaseClient();
  await fetch(`${url}/storage/v1/object/${BUCKET}/${encodeURIComponent(storageKey)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${key}` },
  });
}

async function supabaseExists(storageKey: string): Promise<boolean> {
  const { url, key } = await getSupabaseClient();
  // Use list to check — head requests aren't well-supported for all backends.
  const dir = storageKey.split("/").slice(0, -1).join("/");
  const file = storageKey.split("/").pop()!;
  const res = await fetch(`${url}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefix: dir ? dir + "/" : "", search: file, limit: 1 }),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { name?: string }[];
  return data.some((e) => e.name === file);
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
  // Defense against path traversal
  if (!full.startsWith(path.resolve(base) + path.sep) && full !== path.resolve(base)) {
    throw new Error("Invalid storage key");
  }
  return full;
}

// ---------- Public API ----------

/** Random unguessable storage key: userId-scoped, no user-controlled path parts. */
export function buildStorageKey(userId: string, originalName: string): string {
  const safe = originalName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
  return path.posix.join(userId, `${Date.now()}-${randomBytes(12).toString("hex")}-${safe}`);
}

export async function saveBuffer(storageKey: string, data: Buffer): Promise<void> {
  if (env.STORAGE_BACKEND === "supabase") {
    await supabaseUpload(storageKey, data);
    return;
  }
  const full = localPath(storageKey);
  const dir = path.dirname(full);
  await mkdir(dir, { recursive: true });
  await writeFile(full, data);
}

export function storagePath(storageKey: string): string {
  // For local backend, return the real filesystem path (used by doc-analysis, file serving).
  // For supabase backend, callers should use readBuffer() instead.
  return localPath(storageKey);
}

export async function readBuffer(storageKey: string): Promise<Buffer> {
  if (env.STORAGE_BACKEND === "supabase") {
    return supabaseDownload(storageKey);
  }
  const { readFileSync } = await import("fs");
  return readFileSync(localPath(storageKey));
}

export async function fileExists(storageKey: string): Promise<boolean> {
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

export function openStream(storageKey: string) {
  return createReadStream(localPath(storageKey));
}

export async function deleteFile(storageKey: string): Promise<void> {
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

export async function readHeader(storageKey: string, bytes = 16): Promise<Buffer> {
  if (env.STORAGE_BACKEND === "supabase") {
    const buf = await supabaseDownload(storageKey);
    return buf.subarray(0, bytes);
  }
  const { open } = await import("fs/promises");
  const fh = await open(localPath(storageKey), "r");
  try {
    const buf = Buffer.alloc(bytes);
    await fh.read(buf, 0, bytes, 0);
    return buf;
  } finally {
    await fh.close();
  }
}
