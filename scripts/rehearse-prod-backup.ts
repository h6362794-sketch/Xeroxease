/**
 * Cross-platform, Docker-Free Production Backup + Private Storage Archive + Isolated PG17 Rehearsal
 *
 * Single authoritative implementation used across:
 *   - `npm run backup:rehearse`      (Phase A: read-only Prod backup + SHA-256 check, then
 *                                     Phase B: isolated PostgreSQL 17 restore + migration rehearsal)
 *   - `npm run backup:prod`          (`--backup-only`  — Phase A only; zero rehearsal DB required)
 *   - `npm run backup:rehearse-only` (`--rehearse-only` — Phase B only against an existing verified
 *                                     backup folder; zero Production credentials needed in memory)
 *   - `bash scripts/rehearse-prod-backup.sh` (thin POSIX wrapper invoking this file)
 *
 * Hard safety controls:
 * 1. Strict separation of Production read-only operations (Phase A) from Rehearsal write
 *    operations (Phase B). Child processes in Phase B have `DIRECT_URL`, `DATABASE_URL`,
 *    `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, and `NEXT_PUBLIC_SUPABASE_URL` scrubbed
 *    from `process.env` before `pg_restore`, `prisma migrate deploy`, or `preflight:schema`.
 * 2. Zero Docker requirement when `REHEARSAL_DATABASE_URL` (local PG 17 or approved temporary
 *    isolated cloud PG 17) or `LOCAL_PG17_ADMIN_URL` is supplied. Verifies installed PostgreSQL
 *    client binaries (`psql`, `pg_dump`, `pg_restore`) and enforces major version >= 17.
 * 3. Multi-layer target isolation & disposability verification before ANY clean/drop/restore:
 *    - Rejects identical source/target URLs, production project ref (`vjwvvoczyuebtowbnuqf`
 *      plus any ref dynamically parsed from `DIRECT_URL`, `DATABASE_URL`, `SUPABASE_URL`),
 *      production hostnames, port `6543`, `?pgbouncer=true`, and libpq `?host=`/`?service=`.
 *    - Rejects any non-loopback host unless `REHEARSAL_ALLOW_REMOTE_HOST` matches the exact
 *      hostname AND TLS (`sslmode` != `disable`) is active.
 *    - Requires `REHEARSAL_CONFIRM_DISPOSABLE=YES_DISPOSABLE_TEST_DB` for `REHEARSAL_DATABASE_URL`.
 *    - Queries the live target server BEFORE writing to prove: (a) PostgreSQL 17.x server,
 *      (b) distinct `pg_control_system()` cluster/database identity from Production, and
 *      (c) schema `public` is empty OR stamped by `_xe_disposable_rehearsal.marker` (refusing
 *          to clean or drop any database containing pre-existing non-rehearsal tables).
 *    - Never runs `prisma migrate reset`.
 * 4. Secret & PII hygiene: never logs connection strings, passwords, keys, SQL parameters,
 *    customer rows, or document filenames; enforces `0700` directories and `0600` files
 *    strictly outside the Git repository working tree.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { backupSupabaseStorage } from "./backup-storage";
import { compareMigrations } from "../src/server/schema-readiness";

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");
const KNOWN_PROD_PROJECT_REFS = ["vjwvvoczyuebtowbnuqf"] as const;
export const DISPOSABLE_CONFIRMATION_TOKEN = "YES_DISPOSABLE_TEST_DB";

export const EXPECTED_PUBLIC_TABLES = [
  "_prisma_migrations",
  "audit_logs",
  "feedback",
  "notifications",
  "order_events",
  "orders",
  "password_reset_tokens",
  "payment_events",
  "pricing_config",
  "recovery_codes",
  "sessions",
  "settings",
  "uploaded_files",
  "users",
] as const;

export const REQUIRED_NEW_ORDER_COLUMNS = [
  "pricing_snapshot",
  "finishing_options",
  "payment_method",
  "accepted_at",
  "accepted_by",
  "rejected_at",
  "rejected_by",
  "rejection_reason",
  "delivered_at",
] as const;

export const REQUIRED_ORDER_STATUS_LABELS = [
  "ORDER_RECEIVED",
  "ACCEPTED",
  "PRINTING",
  "READY_FOR_PICKUP",
  "DELIVERED",
  "REJECTED",
  "COMPLETED",
  "PAYMENT_PENDING",
  "PAYMENT_UNDER_REVIEW",
  "READY_FOR_COLLECTION",
] as const;

export const REQUIRED_PAYMENT_METHOD_LABELS = ["CASH_ON_DELIVERY", "UPI"] as const;
export const REQUIRED_NOTIFICATION_TYPE_LABELS = ["ORDER_ACCEPTED", "ORDER_REJECTED"] as const;

export function redactSecrets(input: string, extraSecrets: readonly string[] = []): string {
  let out = input
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'`]+/gi, "postgresql://[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[REDACTED_SUPABASE_KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]");

  for (const secret of extraSecrets) {
    if (secret && secret.length >= 6) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  return out;
}

function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function extractSupabaseProjectRefs(urls: readonly (string | undefined)[]): Set<string> {
  const refs = new Set<string>(KNOWN_PROD_PROJECT_REFS.map((r) => r.toLowerCase()));
  for (const raw of urls) {
    if (!raw || !raw.trim()) continue;
    try {
      const u = new URL(raw.trim());
      const hostMatch =
        u.hostname.match(/^db\.([a-z0-9]{12,32})\.supabase\.co$/i) ??
        u.hostname.match(/^([a-z0-9]{12,32})\.supabase\.co$/i);
      if (hostMatch?.[1]) refs.add(hostMatch[1].toLowerCase());

      const decodedUser = decodeURIComponent(u.username || "");
      const userMatch = decodedUser.match(/^[^.]+\.([a-z0-9]{12,32})$/i);
      if (userMatch?.[1]) refs.add(userMatch[1].toLowerCase());
    } catch {
      // Ignore malformed candidate strings here; strict URL parsers reject them directly.
    }
  }
  return refs;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

function assertNoUnsafeQueryOverrides(parsed: URL, label: string): void {
  for (const forbiddenParam of ["host", "hostaddr", "service", "passfile"]) {
    if (parsed.searchParams.has(forbiddenParam)) {
      throw new Error(`SAFETY LOCK: ${label} must not override libpq "${forbiddenParam}" parameter.`);
    }
  }
}

export function validateProductionDirectUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error(
      "DIRECT_URL is not set. Set your Supabase Session Pooler URI on port 5432 before running backup/rehearsal."
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("DIRECT_URL is not a valid postgresql:// URI.");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("DIRECT_URL must start with postgresql:// or postgres://.");
  }
  assertNoUnsafeQueryOverrides(parsed, "DIRECT_URL");
  const effectivePort = parsed.port || "5432";
  if (effectivePort === "6543") {
    throw new Error(
      "DIRECT_URL uses port 6543 (Supabase Transaction Pooler). Use port 5432 instead (Supabase Dashboard -> Connect -> Session Pooler, e.g. aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require)."
    );
  }
  if (parsed.searchParams.get("pgbouncer")?.toLowerCase() === "true") {
    throw new Error(
      "DIRECT_URL has ?pgbouncer=true set. Remove pgbouncer=true on your port 5432 Session Pooler URL so pg_dump and prisma migrate deploy advisory locks work properly."
    );
  }
  return parsed;
}

export function assertLoopbackOnlyTarget(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid local database URL.");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("Rehearsal target URL must use postgresql:// or postgres://.");
  }
  assertNoUnsafeQueryOverrides(parsed, "Local rehearsal URL");
  if (!isLoopbackHost(parsed.hostname)) {
    throw new Error(
      `SAFETY LOCK: Refusing local admin write operation against non-loopback host "${parsed.hostname.toLowerCase()}". Local admin URLs must target 127.0.0.1 / localhost / ::1.`
    );
  }
  return parsed;
}

export interface ValidateRehearsalTargetInput {
  rehearsalDatabaseUrl: string;
  confirmDisposable?: string;
  allowRemoteHost?: string;
  forbiddenUrls?: readonly (string | undefined)[];
  forbiddenProjectRefs?: ReadonlySet<string>;
}

/**
 * Validates an explicitly supplied isolated PostgreSQL 17 rehearsal connection target
 * (either loopback local PG 17 OR an explicitly approved temporary cloud PG 17 instance).
 */
export function validateRehearsalTargetUrl(input: ValidateRehearsalTargetInput): URL {
  const raw = input.rehearsalDatabaseUrl.trim();
  if (!raw) {
    throw new Error("REHEARSAL_DATABASE_URL is empty.");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("REHEARSAL_DATABASE_URL is not a valid postgresql:// URI.");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("REHEARSAL_DATABASE_URL must start with postgresql:// or postgres://.");
  }
  assertNoUnsafeQueryOverrides(parsed, "REHEARSAL_DATABASE_URL");

  const effectivePort = parsed.port || "5432";
  if (effectivePort === "6543") {
    throw new Error(
      "REHEARSAL_DATABASE_URL uses port 6543 (Transaction Pooler). Use direct/session port 5432 for pg_restore and prisma migrate deploy."
    );
  }
  if (parsed.searchParams.get("pgbouncer")?.toLowerCase() === "true") {
    throw new Error(
      "REHEARSAL_DATABASE_URL must not enable ?pgbouncer=true during pg_restore / prisma migrate deploy."
    );
  }

  const dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, "")).trim();
  if (!dbName) {
    throw new Error("REHEARSAL_DATABASE_URL must specify a target database name in its path.");
  }

  // Require explicit operator confirmation before cleaning/restoring ANY supplied target DB.
  if ((input.confirmDisposable ?? "").trim() !== DISPOSABLE_CONFIRMATION_TOKEN) {
    throw new Error(
      `SAFETY LOCK: Refusing to clean or restore REHEARSAL_DATABASE_URL without explicit confirmation. Set REHEARSAL_CONFIRM_DISPOSABLE=${DISPOSABLE_CONFIRMATION_TOKEN} ONLY after confirming the target database contains zero needed data.`
    );
  }

  // Block production project refs anywhere in host, user, database path, or query string.
  const forbiddenRefs = new Set<string>(KNOWN_PROD_PROJECT_REFS.map((r) => r.toLowerCase()));
  if (input.forbiddenProjectRefs) {
    for (const ref of input.forbiddenProjectRefs) forbiddenRefs.add(ref.toLowerCase());
  }
  for (const ref of extractSupabaseProjectRefs(input.forbiddenUrls ?? [])) {
    forbiddenRefs.add(ref);
  }

  const targetHost = parsed.hostname.toLowerCase();
  const targetUser = decodeURIComponent(parsed.username || "").toLowerCase();
  const inspectableIdentity = `${targetHost}/${targetUser}/${dbName.toLowerCase()}`;
  for (const ref of forbiddenRefs) {
    if (ref && inspectableIdentity.includes(ref)) {
      throw new Error(
        `SAFETY LOCK: REHEARSAL_DATABASE_URL references forbidden production project "${ref}". Never pass a production database connection as REHEARSAL_DATABASE_URL.`
      );
    }
  }

  // Reject obvious production naming on target DB/host labels.
  if (/(?:^|[_.-])(prod|production|live)(?:$|[_.-])/i.test(`${targetHost}/${dbName}`)) {
    throw new Error(
      "SAFETY LOCK: REHEARSAL_DATABASE_URL host or database name appears to label a production/live environment. Use an isolated disposable test database."
    );
  }

  // Compare against all known forbidden/production URLs.
  for (const rawForbidden of input.forbiddenUrls ?? []) {
    if (!rawForbidden || !rawForbidden.trim()) continue;
    if (rawForbidden.trim() === raw) {
      throw new Error("SAFETY LOCK: REHEARSAL_DATABASE_URL must never equal DIRECT_URL or DATABASE_URL.");
    }
    try {
      const f = new URL(rawForbidden.trim());
      const fHost = f.hostname.toLowerCase();
      const fPort = f.port || "5432";
      const fUser = decodeURIComponent(f.username || "").toLowerCase();
      const fDb = decodeURIComponent(f.pathname.replace(/^\/+/, "")).toLowerCase();

      if (targetHost === fHost) {
        const isSharedSupabasePooler = /\.pooler\.supabase\.com$/i.test(targetHost);
        // On a regional Supabase pooler host, tenant identity is encoded as `postgres.<ref>`.
        // Any matching tenant user OR any non-pooler host match is strictly rejected.
        if (!isSharedSupabasePooler || targetUser === fUser || !targetUser.includes(".")) {
          if (!isLoopbackHost(targetHost) || (fPort === effectivePort && fDb === dbName.toLowerCase())) {
            throw new Error(
              "SAFETY LOCK: REHEARSAL_DATABASE_URL points to the same target host/database as a production connection."
            );
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("SAFETY LOCK:")) {
        throw err;
      }
    }
  }

  // Non-loopback cloud targets require explicit hostname approval + encrypted transport.
  if (!isLoopbackHost(targetHost)) {
    const approvedHost = (input.allowRemoteHost ?? "").trim().toLowerCase();
    if (!approvedHost || approvedHost !== targetHost) {
      throw new Error(
        `SAFETY LOCK: Remote rehearsal host "${targetHost}" is not approved. For a temporary isolated cloud PostgreSQL 17 instance, set REHEARSAL_ALLOW_REMOTE_HOST=${targetHost} after verifying it is an empty disposable non-production instance.`
      );
    }
    const sslmode = (parsed.searchParams.get("sslmode") ?? "").trim().toLowerCase();
    if (sslmode === "disable" || sslmode === "allow") {
      throw new Error(
        "SAFETY LOCK: Remote cloud REHEARSAL_DATABASE_URL must use encrypted TLS (e.g. ?sslmode=require), never sslmode=disable."
      );
    }
  }

  return parsed;
}

export function assertOutsideRepository(targetDir: string, repoRoot = DEFAULT_REPO_ROOT): string {
  const resolvedRepo = path.resolve(repoRoot);
  const resolvedTarget = path.resolve(targetDir);
  const rel = path.relative(resolvedRepo, resolvedTarget);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new Error(
      "BACKUP_ROOT must be outside the Git repository working tree so backups and customer documents can never be staged."
    );
  }
  return resolvedTarget;
}

function checkTcpReachable(host: string, port: number, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export interface PgToolPaths {
  psql: string;
  pgDump: string;
  pgRestore: string;
  major: number;
  versionLine: string;
  binDir: string;
}

function parseToolMajor(stdout: string): number | null {
  const match = stdout.match(/(\d+)(?:\.\d+)?/);
  return match ? Number(match[1]) : null;
}

export interface DiscoverPgToolsOptions {
  minMajor?: number;
  pgBinDir?: string;
  envPath?: string;
  includeSystemFallbackDirs?: boolean;
}

/**
 * Discovers installed PostgreSQL client tools (`psql`, `pg_dump`, `pg_restore`) and verifies
 * their versions (`>= minMajor`, default PostgreSQL 17). Fails safely with clear installation
 * guidance when any required binary is missing or too old.
 */
export function resolveRequiredPgTools(opts: DiscoverPgToolsOptions = {}): PgToolPaths {
  const minMajor = opts.minMajor ?? 17;
  const exe = process.platform === "win32" ? ".exe" : "";
  const explicitDir = (opts.pgBinDir ?? process.env.PG_BIN_DIR ?? "").trim();
  const spawnEnv: NodeJS.ProcessEnv =
    opts.envPath !== undefined ? { ...process.env, PATH: opts.envPath, Path: opts.envPath } : process.env;

  const candidateDirs: string[] = [];
  if (explicitDir) {
    candidateDirs.push(explicitDir);
  } else {
    candidateDirs.push("");
    if (opts.includeSystemFallbackDirs !== false) {
      if (process.platform === "win32") {
        candidateDirs.push(
          "C:\\Program Files\\PostgreSQL\\17\\bin",
          "C:\\Program Files\\PostgreSQL\\18\\bin",
          path.join(os.homedir(), "scoop", "apps", "postgresql", "current", "bin")
        );
      } else {
        candidateDirs.push(
          "/usr/lib/postgresql/17/bin",
          "/usr/lib/postgresql/18/bin",
          "/opt/homebrew/opt/postgresql@17/bin",
          "/usr/local/opt/postgresql@17/bin",
          "/Library/PostgreSQL/17/bin"
        );
      }
    }
  }

  let highestTooOldVersion: string | null = null;
  const missingDetails: string[] = [];

  for (const dir of candidateDirs) {
    const psql = dir ? path.join(dir, `psql${exe}`) : `psql${exe}`;
    const pgDump = dir ? path.join(dir, `pg_dump${exe}`) : `pg_dump${exe}`;
    const pgRestore = dir ? path.join(dir, `pg_restore${exe}`) : `pg_restore${exe}`;

    const probes = [
      ["psql", spawnSync(psql, ["--version"], { encoding: "utf8", env: spawnEnv })],
      ["pg_dump", spawnSync(pgDump, ["--version"], { encoding: "utf8", env: spawnEnv })],
      ["pg_restore", spawnSync(pgRestore, ["--version"], { encoding: "utf8", env: spawnEnv })],
    ] as const;

    const failed = probes.filter(([, p]) => p.status !== 0);
    if (failed.length > 0) {
      if (explicitDir) {
        throw new Error(
          `Missing required PostgreSQL client tool(s) in PG_BIN_DIR (${failed.map(([n]) => n).join(", ")}). Ensure psql, pg_dump, and pg_restore from PostgreSQL ${minMajor}+ are present.`
        );
      }
      missingDetails.push(failed.map(([n]) => n).join(", "));
      continue;
    }

    const majors = probes.map(([, p]) => parseToolMajor(p.stdout ?? ""));
    if (majors.some((m) => m === null || m < minMajor)) {
      highestTooOldVersion = (probes[1][1].stdout ?? "").trim() || `below ${minMajor}`;
      if (explicitDir) {
        throw new Error(
          `PostgreSQL client tools in PG_BIN_DIR are version "${highestTooOldVersion}", which is older than required PostgreSQL ${minMajor}. Install PostgreSQL ${minMajor} client tools.`
        );
      }
      continue;
    }

    return {
      psql,
      pgDump,
      pgRestore,
      major: majors[1] ?? minMajor,
      versionLine: (probes[1][1].stdout ?? "").trim(),
      binDir: dir,
    };
  }

  if (highestTooOldVersion) {
    throw new Error(
      `Installed PostgreSQL client tools (${highestTooOldVersion}) are older than required PostgreSQL ${minMajor}. Install PostgreSQL ${minMajor} (Windows PowerShell: winget install --id PostgreSQL.PostgreSQL.17 -e) or set PG_BIN_DIR to your PostgreSQL ${minMajor} bin folder.`
    );
  }

  throw new Error(
    `Missing required PostgreSQL ${minMajor}+ client tools (${missingDetails[0] || "psql, pg_dump, pg_restore"}). Install PostgreSQL 17 without Docker (Windows PowerShell: winget install --id PostgreSQL.PostgreSQL.17 -e) or use the cloud-hosted Codespace option in DATABASE.md.`
  );
}

function runSafe(
  cmd: string,
  args: string[],
  opts: {
    input?: Buffer;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    secrets: readonly string[];
  }
): Buffer {
  try {
    return execFileSync(cmd, args, {
      input: opts.input,
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const rawDetail = String(e.stderr || e.stdout || e.message || `${cmd} failed`);
    throw new Error(redactSecrets(rawDetail.trim(), opts.secrets));
  }
}

function readDbClusterFingerprintHash(
  psqlBin: string,
  dsn: string,
  env: NodeJS.ProcessEnv,
  secrets: readonly string[]
): { dbOidAndNameHash: string; systemIdHash: string | null } {
  const baseId = runSafe(
    psqlBin,
    [
      dsn,
      "-X",
      "-q",
      "-t",
      "-A",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "SELECT current_database() || ':' || (SELECT oid::text FROM pg_database WHERE datname = current_database());",
    ],
    { env, secrets }
  )
    .toString("utf8")
    .trim();

  let systemIdHash: string | null = null;
  try {
    const sysId = runSafe(
      psqlBin,
      [dsn, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", "SELECT system_identifier::text FROM pg_control_system();"],
      { env, secrets }
    )
      .toString("utf8")
      .trim();
    if (sysId) {
      systemIdHash = sha256Hex(`pg_sysid:${sysId}`);
    }
  } catch {
    // Managed roles without pg_control_system() access still enforce URL/ref/dbOid/empty-table locks.
  }

  return {
    dbOidAndNameHash: sha256Hex(`pg_db:${baseId}`),
    systemIdHash,
  };
}

export function verifyBackupDirectoryIntegrity(
  backupDir: string,
  pgRestoreBin: string,
  env: NodeJS.ProcessEnv,
  secrets: readonly string[]
): { dumpFile: string; dumpBytes: number; dumpSha256: string; tocEntries: number } {
  const dbSumsPath = path.join(backupDir, "SHA256SUMS");
  const storageDir = path.join(backupDir, "storage");
  const storageSumsPath = path.join(storageDir, "SHA256SUMS");

  if (!existsSync(dbSumsPath)) {
    throw new Error("Missing SHA256SUMS in backup directory.");
  }
  if (!existsSync(storageSumsPath)) {
    throw new Error("Missing storage/SHA256SUMS in backup directory.");
  }

  let verifiedDumpFile = "";
  let verifiedDumpSha = "";

  for (const [baseDir, sumsFile] of [
    [backupDir, dbSumsPath],
    [storageDir, storageSumsPath],
  ] as const) {
    const rawSums = readFileSync(sumsFile, "utf8").trim();
    if (!rawSums) continue;
    for (const line of rawSums.split(/\r?\n/)) {
      const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/);
      if (!match) {
        throw new Error(`Malformed SHA256SUMS entry in ${path.basename(baseDir)}.`);
      }
      const [, expectedHex, relPath] = match;
      const targetFile = path.resolve(baseDir, ...relPath.split("/"));
      const relCheck = path.relative(baseDir, targetFile);
      if (relCheck.startsWith("..") || path.isAbsolute(relCheck) || !existsSync(targetFile)) {
        throw new Error("Backup artifact referenced by SHA256SUMS is missing or outside backup folder.");
      }
      const actualHex = sha256Hex(readFileSync(targetFile));
      if (actualHex !== expectedHex) {
        throw new Error("SHA-256 checksum mismatch detected on backup artifact.");
      }
      if (baseDir === backupDir && relPath.endsWith(".dump")) {
        verifiedDumpFile = targetFile;
        verifiedDumpSha = actualHex;
      }
    }
  }

  if (!verifiedDumpFile) {
    throw new Error("No verified .dump file entry found in SHA256SUMS.");
  }

  const dumpBuf = readFileSync(verifiedDumpFile);
  if (dumpBuf.byteLength === 0) {
    throw new Error("Verified dump file is empty (0 bytes).");
  }

  const tocRaw = runSafe(pgRestoreBin, ["--list"], {
    input: dumpBuf,
    env,
    secrets,
  }).toString("utf8");
  writeFileSync(path.join(backupDir, "toc.txt"), tocRaw, { mode: 0o600 });

  const tocEntries = tocRaw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith(";")).length;
  if (tocEntries === 0) {
    throw new Error("pg_restore --list returned 0 catalog entries.");
  }
  for (const requiredTable of EXPECTED_PUBLIC_TABLES) {
    if (!new RegExp(`TABLE public ${requiredTable}\\b`).test(tocRaw)) {
      throw new Error(`Dump table-of-contents is missing required table public.${requiredTable}.`);
    }
  }

  return {
    dumpFile: verifiedDumpFile,
    dumpBytes: dumpBuf.byteLength,
    dumpSha256: verifiedDumpSha,
    tocEntries,
  };
}

const ROW_COUNTS_SQL = `SELECT json_build_object(
  'users', (SELECT count(*) FROM public.users),
  'sessions', (SELECT count(*) FROM public.sessions),
  'password_reset_tokens', (SELECT count(*) FROM public.password_reset_tokens),
  'recovery_codes', (SELECT count(*) FROM public.recovery_codes),
  'pricing_config', (SELECT count(*) FROM public.pricing_config),
  'orders', (SELECT count(*) FROM public.orders),
  'uploaded_files', (SELECT count(*) FROM public.uploaded_files),
  'order_events', (SELECT count(*) FROM public.order_events),
  'payment_events', (SELECT count(*) FROM public.payment_events),
  'feedback', (SELECT count(*) FROM public.feedback),
  'notifications', (SELECT count(*) FROM public.notifications),
  'audit_logs', (SELECT count(*) FROM public.audit_logs),
  'settings', (SELECT count(*) FROM public.settings)
)::text;`;

const LEGACY_ORDERS_CANONICAL_SQL = `SELECT coalesce(
  json_agg(
    json_build_object(
      'id', o.id,
      'order_number', o.order_number,
      'status', o.status::text,
      'payment_status', o.payment_status::text,
      'has_payment_ref', (o.payment_ref IS NOT NULL),
      'copies', o.copies,
      'total_pages', o.total_pages,
      'billable_pages', o.billable_pages,
      'price_per_page', o.price_per_page::text,
      'finishing_fee', o.finishing_fee::text,
      'total_amount', o.total_amount::text
    )
    ORDER BY o.id
  ),
  '[]'::json
)::text FROM public.orders o;`;

const ORDER_STATUS_COUNTS_SQL = `SELECT coalesce(
  json_object_agg(status_txt, cnt ORDER BY status_txt),
  '{}'::json
)::text
FROM (
  SELECT status::text AS status_txt, count(*)::int AS cnt
  FROM public.orders
  GROUP BY status::text
) s;`;

const PRICING_CANONICAL_SQL = `SELECT coalesce(
  json_agg(
    json_build_object(
      'id', p.id,
      'key', p.key,
      'unit_price', p.unit_price::text,
      'category', p.category
    )
    ORDER BY p.key
  ),
  '[]'::json
)::text FROM public.pricing_config p;`;

export interface BackupManifest {
  createdAt: string;
  pgClientVersion: string;
  dumpFileName: string;
  dumpBytes: number;
  dumpSha256: string;
  tocEntries: number;
  storage: {
    bucket: string;
    objectCount: number;
    totalBytes: number;
  };
  sourceFinishedMigrations: number;
  sourceRowCounts: Record<string, number>;
  sourceOrdersTotalAmount: string;
  sourcePricingTotalAmount: string;
  sourceLegacyOrdersDigest: string;
  sourcePricingDigest: string;
  sourceClusterSystemIdHash: string | null;
  sourceDbOidAndNameHash: string;
  sourceProjectRefs: string[];
}

export interface RehearsalRunOptions {
  directUrl?: string;
  supabaseUrl?: string;
  serviceRoleKey?: string;
  storageBucket?: string;
  backupRoot?: string;
  rehearsalDatabaseUrl?: string;
  confirmDisposable?: string;
  allowRemoteHost?: string;
  localPg17AdminUrl?: string;
  pgBinDir?: string;
  minClientMajor?: number;
  envPath?: string;
  includeSystemFallbackDirs?: boolean;
  repoRoot?: string;
  allowInsecureLocalhostStorage?: boolean;
  rehearsalMigrateCmd?: string[];
  skipOfflinePrismaEnginePreflight?: boolean;
}

export interface RehearsalReport {
  verifiedAt: string;
  dockerUsed: false;
  pgClientVersion: string;
  rehearsalTargetServerVersionNum: number;
  rehearsalTargetIsLoopback: boolean;
  dumpBytes: number;
  dumpSha256: string;
  tocEntries: number;
  storage: {
    bucket: string;
    objectCount: number;
    totalBytes: number;
  };
  rehearsalRowCountsBefore: Record<string, number>;
  rehearsalRowCountsAfter: Record<string, number>;
  orderStatusCountsBefore: Record<string, number>;
  orderStatusCountsAfter: Record<string, number>;
  legacyOrdersDigestBefore: string;
  legacyOrdersDigestAfter: string;
  ordersTotalAmountBefore: string;
  ordersTotalAmountAfter: string;
  pricingConfigTotalBefore: string;
  pricingConfigTotalAfter: string;
  pricingConfigDigestBefore: string;
  pricingConfigDigestAfter: string;
  rehearsalEnumVerify: {
    orderStatus: string[];
    paymentMethod: string[];
    notificationType: string[];
  };
  rehearsalSchemaVerify: string;
  sourceFinishedMigrationsUnchanged: number | null;
  productionModified: false;
}

function buildToolEnv(baseEnv: NodeJS.ProcessEnv, binDir: string): NodeJS.ProcessEnv {
  if (!binDir) return { ...baseEnv };
  const currentPath = baseEnv.PATH ?? baseEnv.Path ?? "";
  const combined = currentPath ? `${binDir}${path.delimiter}${currentPath}` : binDir;
  return {
    ...baseEnv,
    PATH: combined,
    Path: combined,
  };
}

/**
 * PHASE A — Strictly read-only Production database `pg_dump` + private Storage backup +
 * TOC & SHA-256 verification. Never touches or connects to any rehearsal database.
 */
export async function runProductionBackupPhase(
  options: RehearsalRunOptions = {}
): Promise<{ backupDir: string; manifestPath: string; manifest: BackupManifest }> {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const directUrl = (options.directUrl ?? process.env.DIRECT_URL ?? "").trim();
  const supabaseUrl = (
    options.supabaseUrl ??
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    ""
  ).trim();
  const serviceRoleKey = (
    options.serviceRoleKey ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    ""
  ).trim();
  const storageBucket = (options.storageBucket ?? process.env.STORAGE_BUCKET ?? "documents").trim();

  const secrets = [directUrl, serviceRoleKey, process.env.DATABASE_URL ?? ""].filter(Boolean);
  const log = (msg: string) => console.log(`[backup] ${redactSecrets(msg, secrets)}`);

  const tools = resolveRequiredPgTools({
    minMajor: options.minClientMajor ?? Number(process.env.REHEARSAL_MIN_PG_CLIENT_MAJOR || "17"),
    pgBinDir: options.pgBinDir,
    envPath: options.envPath,
    includeSystemFallbackDirs: options.includeSystemFallbackDirs,
  });
  const toolEnv = buildToolEnv(process.env, tools.binDir);

  const parsedSource = validateProductionDirectUrl(directUrl);
  if (!supabaseUrl) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) in environment.");
  }
  if (!serviceRoleKey) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY in environment.");
  }

  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace(/\d{3}Z$/, "Z");
  const defaultBackupRoot = path.join(os.homedir(), "xeroxease-backups", stamp);
  const backupDir = assertOutsideRepository(
    options.backupRoot ?? process.env.BACKUP_ROOT ?? defaultBackupRoot,
    repoRoot
  );

  const sourcePort = Number(parsedSource.port || "5432");
  try {
    await checkTcpReachable(parsedSource.hostname, sourcePort);
  } catch (err) {
    const isDirectSupabaseHost = /^db\.[a-z0-9]+\.supabase\.co$/i.test(parsedSource.hostname);
    const hint = isDirectSupabaseHost
      ? " Note: db.<project-ref>.supabase.co is IPv6-only on Supabase Free tier. Use Supabase Dashboard -> Connect -> Session Pooler on port 5432 (aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require)."
      : "";
    throw new Error(
      redactSecrets(
        `Cannot reach PostgreSQL host in DIRECT_URL on port ${sourcePort} (${(err as Error).message}).${hint}`,
        secrets
      )
    );
  }

  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(backupDir, 0o700);
  } catch {
    // Windows NTFS user profile ACLs enforce single-user isolation natively.
  }

  const dumpFileName = `xeroxease-prod-public-${stamp}.dump`;
  const dumpFile = path.join(backupDir, dumpFileName);
  const storageDir = path.join(backupDir, "storage");
  const dbSumsFile = path.join(backupDir, "SHA256SUMS");
  const manifestPath = path.join(backupDir, "backup-manifest.json");

  const psqlSourceReadOnly = (sql: string): string =>
    runSafe(
      tools.psql,
      [
        directUrl,
        "-X",
        "-q",
        "-t",
        "-A",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `SET default_transaction_read_only = on; ${sql}`,
      ],
      { env: toolEnv, secrets }
    )
      .toString("utf8")
      .trim();

  const fingerprint = readDbClusterFingerprintHash(tools.psql, directUrl, toolEnv, secrets);
  const srcMigrationsBefore = Number(
    psqlSourceReadOnly(
      "SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;"
    )
  );
  const sourceRowCounts = JSON.parse(psqlSourceReadOnly(ROW_COUNTS_SQL)) as Record<string, number>;
  const sourceOrdersTotalAmount = psqlSourceReadOnly(
    "SELECT coalesce(sum(total_amount), 0)::text FROM public.orders;"
  );
  const sourcePricingTotalAmount = psqlSourceReadOnly(
    "SELECT coalesce(sum(unit_price), 0)::text FROM public.pricing_config;"
  );
  const sourceLegacyOrdersDigest = sha256Hex(psqlSourceReadOnly(LEGACY_ORDERS_CANONICAL_SQL));
  const sourcePricingDigest = sha256Hex(psqlSourceReadOnly(PRICING_CANONICAL_SQL));

  log(
    `Phase A (1/4): Exporting custom-format PostgreSQL dump of schema "public" using ${tools.versionLine} (finished migrations=${srcMigrationsBefore})...`
  );
  const dumpBytesBuf = runSafe(
    tools.pgDump,
    ["--dbname", directUrl, "--schema=public", "-Fc", "--no-owner", "--no-privileges"],
    { env: toolEnv, secrets }
  );
  if (dumpBytesBuf.byteLength === 0) {
    throw new Error("pg_dump produced an empty 0-byte archive.");
  }
  writeFileSync(dumpFile, dumpBytesBuf, { mode: 0o600 });

  log("Phase A (2/4): Archiving private Supabase Storage bucket into restricted directory...");
  const storageSummary = await backupSupabaseStorage({
    outDir: storageDir,
    supabaseUrl,
    serviceRoleKey,
    bucket: storageBucket,
    repoRoot,
    allowInsecureLocalhost: options.allowInsecureLocalhostStorage,
  });
  log(
    `Storage archive verified: bucket=${storageSummary.bucket} objects=${storageSummary.objectCount} totalBytes=${storageSummary.totalBytes}`
  );

  log("Phase A (3/4): Computing SHA-256 digests and verifying pg_restore --list catalog...");
  const dumpSha256 = sha256Hex(readFileSync(dumpFile));
  writeFileSync(dbSumsFile, `${dumpSha256}  ${dumpFileName}\n`, { mode: 0o600 });

  const verified = verifyBackupDirectoryIntegrity(backupDir, tools.pgRestore, toolEnv, secrets);

  log("Phase A (4/4): Confirming zero writes occurred on Production database...");
  const srcMigrationsAfter = Number(
    psqlSourceReadOnly(
      "SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;"
    )
  );
  if (srcMigrationsBefore !== srcMigrationsAfter) {
    throw new Error(
      `Unexpected change in source _prisma_migrations count during backup (${srcMigrationsBefore} -> ${srcMigrationsAfter}).`
    );
  }

  const sourceRefs = Array.from(
    extractSupabaseProjectRefs([directUrl, process.env.DATABASE_URL, supabaseUrl])
  );

  const manifest: BackupManifest = {
    createdAt: new Date().toISOString(),
    pgClientVersion: tools.versionLine,
    dumpFileName,
    dumpBytes: verified.dumpBytes,
    dumpSha256: verified.dumpSha256,
    tocEntries: verified.tocEntries,
    storage: {
      bucket: storageSummary.bucket,
      objectCount: storageSummary.objectCount,
      totalBytes: storageSummary.totalBytes,
    },
    sourceFinishedMigrations: srcMigrationsAfter,
    sourceRowCounts,
    sourceOrdersTotalAmount,
    sourcePricingTotalAmount,
    sourceLegacyOrdersDigest,
    sourcePricingDigest,
    sourceClusterSystemIdHash: fingerprint.systemIdHash,
    sourceDbOidAndNameHash: fingerprint.dbOidAndNameHash,
    sourceProjectRefs: sourceRefs,
  };

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  log(
    `Backup verified & saved: ${backupDir} (dumpBytes=${manifest.dumpBytes}, sha256=${manifest.dumpSha256})`
  );

  return { backupDir, manifestPath, manifest };
}

/**
 * PHASE B — Docker-free isolated PostgreSQL 17 restore + Prisma migration rehearsal +
 * full data/enum/schema convergence verification. Scrubs all Production credentials from
 * child processes so nothing in Phase B can ever connect to Production.
 */
export async function runIsolatedRehearsalPhase(
  options: RehearsalRunOptions & { backupDir?: string } = {}
): Promise<{ backupDir: string; reportPath: string; report: RehearsalReport }> {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const rawBackupDir = (
    options.backupDir ??
    options.backupRoot ??
    process.env.BACKUP_DIR ??
    process.env.BACKUP_ROOT ??
    ""
  ).trim();
  if (!rawBackupDir) {
    throw new Error(
      "Missing backup directory for isolated rehearsal. Provide BACKUP_DIR (or run `npm run backup:rehearse` to perform both backup and rehearsal)."
    );
  }
  const backupDir = assertOutsideRepository(rawBackupDir, repoRoot);

  const rehearsalExplicitRaw = (
    options.rehearsalDatabaseUrl ??
    process.env.REHEARSAL_DATABASE_URL ??
    ""
  ).trim();
  const localAdminRaw = (
    options.localPg17AdminUrl ??
    process.env.LOCAL_PG17_ADMIN_URL ??
    ""
  ).trim();

  const secrets = [
    rehearsalExplicitRaw,
    localAdminRaw,
    options.directUrl ?? process.env.DIRECT_URL ?? "",
    options.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    process.env.DATABASE_URL ?? "",
  ].filter(Boolean);
  const log = (msg: string) => console.log(`[rehearse] ${redactSecrets(msg, secrets)}`);

  const tools = resolveRequiredPgTools({
    minMajor: options.minClientMajor ?? Number(process.env.REHEARSAL_MIN_PG_CLIENT_MAJOR || "17"),
    pgBinDir: options.pgBinDir,
    envPath: options.envPath,
    includeSystemFallbackDirs: options.includeSystemFallbackDirs,
  });

  // Build a scrubbed child environment that NEVER contains Production credentials.
  const scrubbedBaseEnv: NodeJS.ProcessEnv = { ...process.env };
  delete scrubbedBaseEnv.DIRECT_URL;
  delete scrubbedBaseEnv.DATABASE_URL;
  delete scrubbedBaseEnv.SUPABASE_SERVICE_ROLE_KEY;
  delete scrubbedBaseEnv.SUPABASE_URL;
  delete scrubbedBaseEnv.NEXT_PUBLIC_SUPABASE_URL;
  const toolEnv = buildToolEnv(scrubbedBaseEnv, tools.binDir);

  // Re-verify backup SHA-256 digests and TOC before touching any target DB.
  const verifiedBackup = verifyBackupDirectoryIntegrity(backupDir, tools.pgRestore, toolEnv, secrets);
  const manifestPath = path.join(backupDir, "backup-manifest.json");
  const manifest: BackupManifest | null = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest)
    : null;

  const forbiddenRefs = new Set<string>(KNOWN_PROD_PROJECT_REFS.map((r) => r.toLowerCase()));
  for (const r of manifest?.sourceProjectRefs ?? []) forbiddenRefs.add(r.toLowerCase());

  if (!rehearsalExplicitRaw && !localAdminRaw) {
    throw new Error(
      "No isolated PostgreSQL 17 target supplied (Docker is not required). Set REHEARSAL_DATABASE_URL (with REHEARSAL_CONFIRM_DISPOSABLE=YES_DISPOSABLE_TEST_DB) pointing to an isolated local or temporary cloud PostgreSQL 17 test database, or set LOCAL_PG17_ADMIN_URL for local PostgreSQL 17."
    );
  }

  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace(/\d{3}Z$/, "Z");
  let localAdminUrlObj: URL | null = null;
  let localTempDbToDrop = "";
  let rehearsalUrlObj: URL;

  if (rehearsalExplicitRaw) {
    rehearsalUrlObj = validateRehearsalTargetUrl({
      rehearsalDatabaseUrl: rehearsalExplicitRaw,
      confirmDisposable: options.confirmDisposable ?? process.env.REHEARSAL_CONFIRM_DISPOSABLE,
      allowRemoteHost: options.allowRemoteHost ?? process.env.REHEARSAL_ALLOW_REMOTE_HOST,
      forbiddenUrls: [
        options.directUrl ?? process.env.DIRECT_URL,
        process.env.DATABASE_URL,
        options.supabaseUrl ?? process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
      ],
      forbiddenProjectRefs: forbiddenRefs,
    });
  } else {
    localAdminUrlObj = assertLoopbackOnlyTarget(localAdminRaw);
    const tempDbName = `xe_rehearsal_${stamp.toLowerCase()}_${process.pid}`;
    log(`Creating disposable loopback PostgreSQL 17 database (${tempDbName})...`);
    runSafe(
      tools.psql,
      [
        localAdminUrlObj.toString(),
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `CREATE DATABASE "${tempDbName}";`,
      ],
      { env: toolEnv, secrets }
    );
    localTempDbToDrop = tempDbName;
    const candidate = new URL(localAdminUrlObj.toString());
    candidate.pathname = `/${tempDbName}`;
    rehearsalUrlObj = validateRehearsalTargetUrl({
      rehearsalDatabaseUrl: candidate.toString(),
      confirmDisposable: DISPOSABLE_CONFIRMATION_TOKEN,
      forbiddenUrls: [
        options.directUrl ?? process.env.DIRECT_URL,
        process.env.DATABASE_URL,
      ],
      forbiddenProjectRefs: forbiddenRefs,
    });
  }

  const rehearsalUrl = rehearsalUrlObj.toString();

  try {
    const psqlRehearsal = (sql: string): string =>
      runSafe(tools.psql, [rehearsalUrl, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql], {
        env: toolEnv,
        secrets,
      })
        .toString("utf8")
        .trim();

    // --- Independent live server verification BEFORE any drop / clean / restore ---
    const serverVersionNum = Number(
      psqlRehearsal("SELECT current_setting('server_version_num')::int;")
    );
    if (!Number.isFinite(serverVersionNum) || serverVersionNum < 170000 || serverVersionNum >= 180000) {
      throw new Error(
        `Rehearsal database server must be PostgreSQL 17.x (got server_version_num=${serverVersionNum}). Provide a PostgreSQL 17 test database.`
      );
    }

    const targetFingerprint = readDbClusterFingerprintHash(tools.psql, rehearsalUrl, toolEnv, secrets);
    if (manifest) {
      if (
        !isLoopbackHost(rehearsalUrlObj.hostname) &&
        manifest.sourceClusterSystemIdHash &&
        targetFingerprint.systemIdHash &&
        manifest.sourceClusterSystemIdHash === targetFingerprint.systemIdHash
      ) {
        throw new Error(
          "SAFETY LOCK: Rehearsal connection resolved to the exact same PostgreSQL cluster system_identifier as Production. Aborting before any write."
        );
      }
      if (
        manifest.sourceClusterSystemIdHash &&
        targetFingerprint.systemIdHash &&
        manifest.sourceClusterSystemIdHash === targetFingerprint.systemIdHash &&
        manifest.sourceDbOidAndNameHash === targetFingerprint.dbOidAndNameHash
      ) {
        throw new Error(
          "SAFETY LOCK: Rehearsal connection resolved to the exact same PostgreSQL database OID as the source database. Aborting before any write."
        );
      }
    }

    // Refuse to clean/overwrite any database that already has tables in `public` unless
    // it carries our explicit `_xe_disposable_rehearsal.marker` stamp from a prior empty init.
    const existingPublicTables = Number(
      psqlRehearsal(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';"
      )
    );
    const hasDisposableMarker =
      psqlRehearsal(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = '_xe_disposable_rehearsal' AND table_name = 'marker')::text;"
      ) === "true";

    if (existingPublicTables > 0 && !hasDisposableMarker) {
      throw new Error(
        `SAFETY LOCK: Target rehearsal database already contains ${existingPublicTables} table(s) in schema "public" and was NOT initialized as a disposable XeroxEase test database. Use a fresh empty PostgreSQL 17 database.`
      );
    }

    // Stamp dedicated `_xe_disposable_rehearsal.marker` schema on the verified empty test DB.
    psqlRehearsal(
      "CREATE SCHEMA IF NOT EXISTS _xe_disposable_rehearsal; CREATE TABLE IF NOT EXISTS _xe_disposable_rehearsal.marker (created_at timestamptz NOT NULL DEFAULT now());"
    );

    // --- Restore verified dump into isolated PostgreSQL 17 database ------------
    log(
      `Phase B (1/3): Restoring verified archive into isolated PostgreSQL 17 database (${serverVersionNum})...`
    );
    const dumpBuf = readFileSync(verifiedBackup.dumpFile);
    runSafe(
      tools.pgRestore,
      [
        "--dbname",
        rehearsalUrl,
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
      ],
      { input: dumpBuf, env: toolEnv, secrets }
    );

    const countsBeforeRaw = psqlRehearsal(ROW_COUNTS_SQL);
    const orderStatusCountsBeforeRaw = psqlRehearsal(ORDER_STATUS_COUNTS_SQL);
    const legacyOrdersDigestBefore = sha256Hex(psqlRehearsal(LEGACY_ORDERS_CANONICAL_SQL));
    const totalAmountBefore = psqlRehearsal(
      "SELECT coalesce(sum(total_amount), 0)::text FROM public.orders;"
    );
    const pricingTotalBefore = psqlRehearsal(
      "SELECT coalesce(sum(unit_price), 0)::text FROM public.pricing_config;"
    );
    const pricingDigestBefore = sha256Hex(psqlRehearsal(PRICING_CANONICAL_SQL));

    const countsBeforeObj = JSON.parse(countsBeforeRaw) as Record<string, number>;
    const orderStatusCountsBeforeObj = JSON.parse(orderStatusCountsBeforeRaw) as Record<
      string,
      number
    >;

    if (manifest) {
      if (JSON.stringify(manifest.sourceRowCounts) !== JSON.stringify(countsBeforeObj)) {
        throw new Error("Restored row counts do not match source backup manifest.");
      }
      if (manifest.sourceLegacyOrdersDigest !== legacyOrdersDigestBefore) {
        throw new Error("Restored orders digest does not match source backup manifest.");
      }
      if (manifest.sourcePricingDigest !== pricingDigestBefore) {
        throw new Error("Restored pricing_config digest does not match source backup manifest.");
      }
    }

    // --- Apply pending Prisma migrations ONLY against isolated rehearsal DB ----
    log("Phase B (2/3): Applying pending Prisma migrations strictly against isolated PG17 test DB...");
    const migrateEnv: NodeJS.ProcessEnv = {
      ...toolEnv,
      DATABASE_URL: rehearsalUrl,
      DIRECT_URL: rehearsalUrl,
    };
    const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
    const migrateCmd =
      options.rehearsalMigrateCmd ??
      (process.env.REHEARSAL_MIGRATE_CMD
        ? ["bash", "-c", process.env.REHEARSAL_MIGRATE_CMD]
        : [npxBin, "prisma", "migrate", "deploy"]);
    runSafe(migrateCmd[0], migrateCmd.slice(1), {
      cwd: repoRoot,
      env: migrateEnv,
      secrets,
    });

    // --- Verify row counts, legacy orders, pricing totals, enums & convergence -
    log(
      "Phase B (3/3): Verifying legacy orders, row counts, pricing totals, enum labels, and schema convergence..."
    );
    const countsAfterRaw = psqlRehearsal(ROW_COUNTS_SQL);
    const orderStatusCountsAfterRaw = psqlRehearsal(ORDER_STATUS_COUNTS_SQL);
    const legacyOrdersDigestAfter = sha256Hex(psqlRehearsal(LEGACY_ORDERS_CANONICAL_SQL));
    const totalAmountAfter = psqlRehearsal(
      "SELECT coalesce(sum(total_amount), 0)::text FROM public.orders;"
    );
    const pricingTotalAfter = psqlRehearsal(
      "SELECT coalesce(sum(unit_price), 0)::text FROM public.pricing_config;"
    );
    const pricingDigestAfter = sha256Hex(psqlRehearsal(PRICING_CANONICAL_SQL));

    const countsAfterObj = JSON.parse(countsAfterRaw) as Record<string, number>;
    const orderStatusCountsAfterObj = JSON.parse(orderStatusCountsAfterRaw) as Record<
      string,
      number
    >;

    if (JSON.stringify(countsBeforeObj) !== JSON.stringify(countsAfterObj)) {
      throw new Error(
        `Row count preservation failed across migration rehearsal (before=${countsBeforeRaw}, after=${countsAfterRaw}).`
      );
    }
    if (
      legacyOrdersDigestBefore !== legacyOrdersDigestAfter ||
      JSON.stringify(orderStatusCountsBeforeObj) !== JSON.stringify(orderStatusCountsAfterObj)
    ) {
      throw new Error(
        "Legacy order preservation failed across migration rehearsal (historical order fields or status distribution changed)."
      );
    }
    if (totalAmountBefore !== totalAmountAfter) {
      throw new Error(
        `Order amount total changed across migration rehearsal (${totalAmountBefore} -> ${totalAmountAfter}).`
      );
    }
    if (pricingTotalBefore !== pricingTotalAfter || pricingDigestBefore !== pricingDigestAfter) {
      throw new Error(
        `Pricing config totals changed across migration rehearsal (${pricingTotalBefore} -> ${pricingTotalAfter}).`
      );
    }

    // Verify all enum labels across OrderStatus, PaymentMethod, and NotificationType.
    const enumJsonRaw = psqlRehearsal(`SELECT json_build_object(
      'orderStatus', (SELECT coalesce(json_agg(e.enumlabel ORDER BY e.enumsortorder), '[]'::json)
                      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'OrderStatus'),
      'paymentMethod', (SELECT coalesce(json_agg(e.enumlabel ORDER BY e.enumsortorder), '[]'::json)
                        FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'PaymentMethod'),
      'notificationType', (SELECT coalesce(json_agg(e.enumlabel ORDER BY e.enumsortorder), '[]'::json)
                           FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'NotificationType')
    )::text;`);
    const enumVerify = JSON.parse(enumJsonRaw) as {
      orderStatus: string[];
      paymentMethod: string[];
      notificationType: string[];
    };
    for (const label of REQUIRED_ORDER_STATUS_LABELS) {
      if (!enumVerify.orderStatus.includes(label)) {
        throw new Error(`Missing required OrderStatus enum value "${label}" after migration.`);
      }
    }
    for (const label of REQUIRED_PAYMENT_METHOD_LABELS) {
      if (!enumVerify.paymentMethod.includes(label)) {
        throw new Error(`Missing required PaymentMethod enum value "${label}" after migration.`);
      }
    }
    for (const label of REQUIRED_NOTIFICATION_TYPE_LABELS) {
      if (!enumVerify.notificationType.includes(label)) {
        throw new Error(`Missing required NotificationType enum value "${label}" after migration.`);
      }
    }

    // Verify all 9 added columns, default 'ORDER_RECEIVED', composite index, and 5 finished migrations.
    const orderColsRaw = psqlRehearsal(
      "SELECT coalesce(json_agg(column_name ORDER BY ordinal_position), '[]'::json)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders';"
    );
    const orderCols = JSON.parse(orderColsRaw) as string[];
    for (const col of REQUIRED_NEW_ORDER_COLUMNS) {
      if (!orderCols.includes(col)) {
        throw new Error(`Missing expected public.orders column "${col}" after migration.`);
      }
    }

    const indexExists =
      psqlRehearsal(
        "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'orders' AND indexname = 'orders_payment_method_payment_status_idx')::text;"
      ) === "true";
    if (!indexExists) {
      throw new Error("Missing expected index orders_payment_method_payment_status_idx after migration.");
    }

    const statusDefault = psqlRehearsal(
      "SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'status';"
    );
    if (!statusDefault.includes("ORDER_RECEIVED")) {
      throw new Error(`Expected public.orders.status default to be ORDER_RECEIVED, got "${statusDefault}".`);
    }

    const schemaVerify = psqlRehearsal(`SELECT
      (SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) || ':' ||
      (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='orders') || ':' ||
      ('DELIVERED'::"OrderStatus")::text || ':' ||
      ('UPI'::"PaymentMethod")::text;`);
    if (schemaVerify !== "5:40:DELIVERED:UPI") {
      throw new Error(
        `Post-migration schema verification failed on rehearsal DB (got "${schemaVerify}", expected "5:40:DELIVERED:UPI").`
      );
    }

    const unfinishedOrRolledBack = Number(
      psqlRehearsal(
        "SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;"
      )
    );
    if (unfinishedOrRolledBack !== 0) {
      throw new Error(`Detected ${unfinishedOrRolledBack} unfinished or rolled-back migration rows.`);
    }

    const appliedRowsJson = psqlRehearsal(
      "SELECT coalesce(json_agg(migration_name ORDER BY started_at), '[]'::json)::text FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;"
    );
    const committed = readdirSync(path.join(repoRoot, "prisma", "migrations"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    const readiness = compareMigrations(committed, JSON.parse(appliedRowsJson) as string[]);
    if (!readiness.ok) {
      throw new Error(`compareMigrations failed on rehearsal DB: ${JSON.stringify(readiness)}`);
    }

    const skipEnginePreflight =
      options.skipOfflinePrismaEnginePreflight === true ||
      process.env.SKIP_OFFLINE_PRISMA_ENGINE_PREFLIGHT === "1";
    if (!skipEnginePreflight) {
      const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
      runSafe(npmBin, ["run", "preflight:schema"], {
        cwd: repoRoot,
        env: migrateEnv,
        secrets,
      });
    }

    const reportPath = path.join(backupDir, "rehearsal-report.json");
    const report: RehearsalReport = {
      verifiedAt: new Date().toISOString(),
      dockerUsed: false,
      pgClientVersion: tools.versionLine,
      rehearsalTargetServerVersionNum: serverVersionNum,
      rehearsalTargetIsLoopback: isLoopbackHost(rehearsalUrlObj.hostname),
      dumpBytes: verifiedBackup.dumpBytes,
      dumpSha256: verifiedBackup.dumpSha256,
      tocEntries: verifiedBackup.tocEntries,
      storage: manifest?.storage ?? {
        bucket: "documents",
        objectCount: 0,
        totalBytes: 0,
      },
      rehearsalRowCountsBefore: JSON.parse(countsBeforeRaw) as Record<string, number>,
      rehearsalRowCountsAfter: JSON.parse(countsAfterRaw) as Record<string, number>,
      orderStatusCountsBefore: JSON.parse(orderStatusCountsBeforeRaw) as Record<string, number>,
      orderStatusCountsAfter: JSON.parse(orderStatusCountsAfterRaw) as Record<string, number>,
      legacyOrdersDigestBefore,
      legacyOrdersDigestAfter,
      ordersTotalAmountBefore: totalAmountBefore,
      ordersTotalAmountAfter: totalAmountAfter,
      pricingConfigTotalBefore: pricingTotalBefore,
      pricingConfigTotalAfter: pricingTotalAfter,
      pricingConfigDigestBefore: pricingDigestBefore,
      pricingConfigDigestAfter: pricingDigestAfter,
      rehearsalEnumVerify: enumVerify,
      rehearsalSchemaVerify: schemaVerify,
      sourceFinishedMigrationsUnchanged: manifest?.sourceFinishedMigrations ?? null,
      productionModified: false,
    };

    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return { backupDir, reportPath, report };
  } finally {
    if (localTempDbToDrop && localAdminUrlObj && /^xe_rehearsal_[a-z0-9]+_\d+$/.test(localTempDbToDrop)) {
      spawnSync(
        tools.psql,
        [
          localAdminUrlObj.toString(),
          "-X",
          "-q",
          "-c",
          `DROP DATABASE IF EXISTS "${localTempDbToDrop}" WITH (FORCE);`,
        ],
        { env: toolEnv, stdio: "ignore" }
      );
    }
  }
}

/**
 * Full Docker-free two-phase orchestration:
 *   1. Read-only Production `pg_dump` + private Storage backup + SHA-256 & TOC check.
 *   2. Isolated PostgreSQL 17 restore + migration rehearsal (with scrubbed child env).
 *   3. Final read-only check confirming Production `_prisma_migrations` is untouched.
 */
export async function runProdBackupRehearsal(
  options: RehearsalRunOptions = {}
): Promise<{ backupDir: string; reportPath: string; report: RehearsalReport }> {
  const backupResult = await runProductionBackupPhase(options);
  const rehearsalResult = await runIsolatedRehearsalPhase({
    ...options,
    backupDir: backupResult.backupDir,
  });

  // Final read-only verification that Production `_prisma_migrations` remained untouched.
  const directUrl = (options.directUrl ?? process.env.DIRECT_URL ?? "").trim();
  const secrets = [directUrl, options.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""].filter(
    Boolean
  );
  const tools = resolveRequiredPgTools({
    minMajor: options.minClientMajor ?? Number(process.env.REHEARSAL_MIN_PG_CLIENT_MAJOR || "17"),
    pgBinDir: options.pgBinDir,
    envPath: options.envPath,
    includeSystemFallbackDirs: options.includeSystemFallbackDirs,
  });
  const toolEnv = buildToolEnv(process.env, tools.binDir);
  const srcAfterRehearsal = Number(
    runSafe(
      tools.psql,
      [
        directUrl,
        "-X",
        "-q",
        "-t",
        "-A",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "SET default_transaction_read_only = on; SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;",
      ],
      { env: toolEnv, secrets }
    )
      .toString("utf8")
      .trim()
  );
  if (srcAfterRehearsal !== backupResult.manifest.sourceFinishedMigrations) {
    throw new Error(
      `Unexpected change in source _prisma_migrations count (${backupResult.manifest.sourceFinishedMigrations} -> ${srcAfterRehearsal}).`
    );
  }

  rehearsalResult.report.sourceFinishedMigrationsUnchanged = srcAfterRehearsal;
  writeFileSync(rehearsalResult.reportPath, `${JSON.stringify(rehearsalResult.report, null, 2)}\n`, {
    mode: 0o600,
  });

  const log = (msg: string) => console.log(`[rehearse] ${redactSecrets(msg, secrets)}`);
  log("======================================================================");
  log("REHEARSAL PASSED (DOCKER-FREE) — Production database was NOT modified.");
  log(`  Backup folder     : ${rehearsalResult.backupDir}`);
  log(`  Dump size (bytes) : ${rehearsalResult.report.dumpBytes}`);
  log(`  Dump SHA-256      : ${rehearsalResult.report.dumpSha256}`);
  log(`  Storage archive   : ${JSON.stringify(rehearsalResult.report.storage)}`);
  log(
    `  Orders sum kept   : ${rehearsalResult.report.ordersTotalAmountBefore} -> ${rehearsalResult.report.ordersTotalAmountAfter}`
  );
  log(
    `  Pricing sum kept  : ${rehearsalResult.report.pricingConfigTotalBefore} -> ${rehearsalResult.report.pricingConfigTotalAfter}`
  );
  log(`  Schema verified   : ${rehearsalResult.report.rehearsalSchemaVerify}`);
  log(`  Report file       : ${rehearsalResult.reportPath}`);
  log("======================================================================");

  return rehearsalResult;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const backupOnly = argv.includes("--backup-only");
  const rehearseOnly = argv.includes("--rehearse-only");

  if (backupOnly && rehearseOnly) {
    console.error("[rehearse] FAILED: Cannot specify both --backup-only and --rehearse-only.");
    process.exit(1);
  }

  try {
    if (backupOnly) {
      await runProductionBackupPhase();
      return;
    }
    if (rehearseOnly) {
      const res = await runIsolatedRehearsalPhase();
      console.log(`[rehearse] REHEARSAL PASSED (isolated phase): ${res.reportPath}`);
      return;
    }
    await runProdBackupRehearsal();
  } catch (err) {
    const safeMsg = err instanceof Error ? err.message : "Rehearsal failed.";
    console.error(
      `[rehearse] FAILED: ${redactSecrets(safeMsg, [
        process.env.DIRECT_URL ?? "",
        process.env.DATABASE_URL ?? "",
        process.env.REHEARSAL_DATABASE_URL ?? "",
        process.env.LOCAL_PG17_ADMIN_URL ?? "",
        process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      ])}`
    );
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
