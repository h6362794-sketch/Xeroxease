/**
 * Private Supabase Storage backup archiver (`npm run backup:storage -- <out-dir>`).
 *
 * Security & privacy invariants:
 * - Reads `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
 *   strictly from environment variables (never CLI flags, never logged).
 * - Refuses target directories inside the repository working tree so customer files
 *   can never be staged or committed by accident.
 * - Rejects path-traversal segments (`..`, backslashes, control chars, root escape).
 * - Creates directories with mode `0700` and files (`objects/...`,
 *   `storage-manifest.json`, `SHA256SUMS`) with mode `0600`.
 * - Verifies downloaded byte lengths against Storage metadata and emits only
 *   aggregate counts/bytes to stdout (never filenames, keys, user IDs, or tokens).
 */

import { createHash } from "crypto";
import { chmod, mkdir, writeFile } from "fs/promises";
import path from "path";

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");
const PAGE_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 60_000;

interface StorageListEntry {
  name: string;
  id?: string | null;
  updated_at?: string | null;
  metadata?: {
    size?: number | string | null;
    mimetype?: string | null;
    mimeType?: string | null;
  } | null;
}

export interface ManifestEntry {
  key: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string | null;
  updatedAt: string | null;
}

export interface StorageBackupResult {
  bucket: string;
  outDir: string;
  objectCount: number;
  totalBytes: number;
  manifestPath: string;
  checksumsPath: string;
}

export interface StorageBackupOptions {
  outDir: string;
  supabaseUrl?: string;
  serviceRoleKey?: string;
  bucket?: string;
  repoRoot?: string;
  allowInsecureLocalhost?: boolean;
}

function isInsideOrEqual(candidatePath: string, parentPath: string): boolean {
  const rel = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function resolveSafeObjectPath(objectsRoot: string, objectKey: string): string {
  if (!objectKey || /[\x00-\x1f\x7f\\]/.test(objectKey)) {
    throw new Error("Storage returned an invalid object key containing control or backslash characters.");
  }
  const segments = objectKey.split("/");
  if (segments.some((seg) => !seg || seg === "." || seg === "..")) {
    throw new Error("Storage returned an unsafe relative object path segment.");
  }
  const resolvedRoot = path.resolve(objectsRoot);
  const fullTarget = path.resolve(resolvedRoot, ...segments);
  if (!fullTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error("Storage object path escaped target backup directory.");
  }
  return fullTarget;
}

function encodeStorageKey(objectKey: string): string {
  return objectKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function listPrefixPage(
  baseUrl: string,
  bucket: string,
  serviceRoleKey: string,
  prefix: string,
  offset: number
): Promise<StorageListEntry[]> {
  const res = await fetch(`${baseUrl}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prefix,
      limit: PAGE_LIMIT,
      offset,
      sortBy: { column: "name", order: "asc" },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Storage list request failed with HTTP ${res.status}.`);
  }
  const parsed: unknown = await res.json();
  if (!Array.isArray(parsed)) {
    throw new Error("Storage list response was not a JSON array.");
  }
  return parsed as StorageListEntry[];
}

async function collectEntriesRecursive(
  baseUrl: string,
  bucket: string,
  serviceRoleKey: string,
  prefix: string,
  out: Array<{ key: string; expectedSize: number | null; mimeType: string | null; updatedAt: string | null }>
): Promise<void> {
  let offset = 0;
  for (;;) {
    const page = await listPrefixPage(baseUrl, bucket, serviceRoleKey, prefix, offset);
    for (const item of page) {
      if (!item || typeof item.name !== "string" || item.name.length === 0) continue;
      if (item.id === null || item.id === undefined) {
        await collectEntriesRecursive(baseUrl, bucket, serviceRoleKey, `${prefix}${item.name}/`, out);
        continue;
      }
      const rawSize = item.metadata?.size;
      const numericSize =
        rawSize === undefined || rawSize === null || rawSize === "" ? null : Number(rawSize);
      if (item.name === ".emptyFolderPlaceholder" && (numericSize === 0 || numericSize === null)) {
        continue;
      }
      out.push({
        key: `${prefix}${item.name}`,
        expectedSize: numericSize !== null && Number.isFinite(numericSize) ? numericSize : null,
        mimeType: item.metadata?.mimetype ?? item.metadata?.mimeType ?? null,
        updatedAt: item.updated_at ?? null,
      });
    }
    if (page.length < PAGE_LIMIT) break;
    offset += page.length;
  }
}

export async function backupSupabaseStorage(options: StorageBackupOptions): Promise<StorageBackupResult> {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  if (!options.outDir || !options.outDir.trim()) {
    throw new Error("Missing output directory. Pass a private path outside the git repository.");
  }
  const outDir = path.resolve(options.outDir);
  if (isInsideOrEqual(outDir, repoRoot)) {
    throw new Error(
      "Refusing to write Storage backup inside the git repository. Choose a private directory outside the repo (for example $HOME/xeroxease-backups/<timestamp>/storage)."
    );
  }

  const rawUrl = (
    options.supabaseUrl ??
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    ""
  )
    .trim()
    .replace(/\/+$/, "");
  const serviceRoleKey = (
    options.serviceRoleKey ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    ""
  ).trim();
  const bucket = (options.bucket ?? process.env.STORAGE_BUCKET ?? "documents").trim() || "documents";

  if (!rawUrl || !serviceRoleKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY in environment."
    );
  }

  const allowLocalHttp =
    options.allowInsecureLocalhost === true || process.env.ALLOW_INSECURE_TEST_STORAGE_URL === "1";
  const isHttps = /^https:\/\//i.test(rawUrl);
  const isLocalHttp = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(rawUrl);
  if (!isHttps && !(allowLocalHttp && isLocalHttp)) {
    throw new Error("Supabase URL must use https://.");
  }

  const objectsRoot = path.join(outDir, "objects");
  await mkdir(objectsRoot, { recursive: true, mode: 0o700 });
  await chmod(outDir, 0o700).catch(() => {});
  await chmod(objectsRoot, 0o700).catch(() => {});

  const discovered: Array<{
    key: string;
    expectedSize: number | null;
    mimeType: string | null;
    updatedAt: string | null;
  }> = [];
  await collectEntriesRecursive(rawUrl, bucket, serviceRoleKey, "", discovered);

  // Pre-validate every object path before writing any bytes to disk.
  for (const item of discovered) {
    resolveSafeObjectPath(objectsRoot, item.key);
  }

  const manifestEntries: ManifestEntry[] = [];
  let totalBytes = 0;

  for (const item of discovered) {
    const targetFile = resolveSafeObjectPath(objectsRoot, item.key);
    const res = await fetch(
      `${rawUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStorageKey(item.key)}`,
      {
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (!res.ok) {
      throw new Error(`Storage object download failed with HTTP ${res.status}.`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (item.expectedSize !== null && bytes.byteLength !== item.expectedSize) {
      throw new Error(
        `Storage object byte-count mismatch (expected ${item.expectedSize} bytes, received ${bytes.byteLength} bytes).`
      );
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await mkdir(path.dirname(targetFile), { recursive: true, mode: 0o700 });
    await writeFile(targetFile, bytes, { mode: 0o600 });
    await chmod(targetFile, 0o600).catch(() => {});

    totalBytes += bytes.byteLength;
    manifestEntries.push({
      key: item.key,
      sizeBytes: bytes.byteLength,
      sha256,
      mimeType: item.mimeType,
      updatedAt: item.updatedAt,
    });
  }

  const manifestPath = path.join(outDir, "storage-manifest.json");
  const checksumsPath = path.join(outDir, "SHA256SUMS");

  const manifestBody = JSON.stringify(
    {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      bucket,
      objectCount: manifestEntries.length,
      totalBytes,
      objects: manifestEntries,
    },
    null,
    2
  );
  const checksumLines = manifestEntries
    .map((entry) => `${entry.sha256}  objects/${entry.key}`)
    .join("\n");

  await writeFile(manifestPath, `${manifestBody}\n`, { mode: 0o600 });
  await writeFile(checksumsPath, checksumLines ? `${checksumLines}\n` : "", { mode: 0o600 });
  await chmod(manifestPath, 0o600).catch(() => {});
  await chmod(checksumsPath, 0o600).catch(() => {});

  return {
    bucket,
    outDir,
    objectCount: manifestEntries.length,
    totalBytes,
    manifestPath,
    checksumsPath,
  };
}

async function main(): Promise<void> {
  const outDir = process.argv[2] ?? "";
  try {
    const summary = await backupSupabaseStorage({ outDir });
    console.log(
      `[backup:storage] bucket=${summary.bucket} objects=${summary.objectCount} totalBytes=${summary.totalBytes} status=verified`
    );
  } catch (err) {
    const safeMessage = err instanceof Error ? err.message : "Storage backup failed.";
    console.error(`[backup:storage] FAILED: ${safeMessage}`);
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
