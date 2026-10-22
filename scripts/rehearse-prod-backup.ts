/**
 * Cross-platform Production Backup + Private Storage Archive + Isolated PG17 Rehearsal
 * (`npm run backup:rehearse`).
 *
 * Works natively on Windows PowerShell / CMD, WSL2, macOS, and Linux without requiring
 * cross-OS shell bridges.
 *
 * Hard safety guarantees:
 * 1. Read-only on Production (`DIRECT_URL`): executes ONLY `SELECT` pre/post checks and
 *    `pg_dump --schema=public -Fc --no-owner --no-privileges`, plus read-only Storage
 *    object downloads via `backupSupabaseStorage(...)`.
 *     scoping `--schema=public` captures all 14 XeroxEase tables (`_prisma_migrations` +
 *    all 13 application tables), enums, constraints, defaults, and indexes while avoiding
 *    Supabase-internal schemas/extensions (`vault`/`supabase_vault`, `auth`, `graphql`)
 *    that fail `pg_restore --exit-on-error` on standard PostgreSQL 17 targets.
 * 2. Loopback hard-lock on writes: `assertLoopbackOnlyTarget(...)` guarantees `CREATE DATABASE`,
 *    `pg_restore`, `prisma migrate deploy`, and `DROP DATABASE` execute ONLY against
 *    `127.0.0.1` / `localhost` / `::1`.
 * 3. Zero secret / PII exposure: never prints connection URIs, passwords, tokens, customer
 *    rows, or object filenames; scrubs secrets from every thrown diagnostic; enforces `0700`
 *    directories and `0600` files outside the Git repository working tree.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { backupSupabaseStorage } from "./backup-storage";
import { compareMigrations } from "../src/server/schema-readiness";

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");

const EXPECTED_PUBLIC_TABLES = [
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

export function validateProductionDirectUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error(
      "DIRECT_URL is not set. Set your Supabase Session Pooler URI on port 5432 before running npm run backup:rehearse."
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
    throw new Error("Invalid rehearsal database URL.");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("Rehearsal target URL must use postgresql:// or postgres://.");
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") {
    throw new Error(
      `SAFETY LOCK: Refusing write operation against non-loopback host "${host}". Rehearsal writes are restricted to 127.0.0.1 / localhost / ::1.`
    );
  }
  if (parsed.searchParams.has("host") || parsed.searchParams.has("service")) {
    throw new Error("SAFETY LOCK: Rehearsal target URL must not override libpq host/service parameters.");
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

interface PgToolPaths {
  psql: string;
  pgDump: string;
  pgRestore: string;
  major: number;
}

function parseToolMajor(stdout: string): number | null {
  const match = stdout.match(/(\d+)(?:\.\d+)?/);
  return match ? Number(match[1]) : null;
}

function discoverLocalPgTools(minMajor: number): PgToolPaths | null {
  const exe = process.platform === "win32" ? ".exe" : "";
  const candidateDirs = [
    "",
    ...(process.platform === "win32"
      ? [
          "C:\\Program Files\\PostgreSQL\\17\\bin",
          "C:\\Program Files\\PostgreSQL\\18\\bin",
        ]
      : [
          "/usr/lib/postgresql/17/bin",
          "/usr/lib/postgresql/18/bin",
          "/opt/homebrew/opt/postgresql@17/bin",
          "/usr/local/opt/postgresql@17/bin",
          "/Library/PostgreSQL/17/bin",
        ]),
  ];

  for (const dir of candidateDirs) {
    const pgDump = dir ? path.join(dir, `pg_dump${exe}`) : `pg_dump${exe}`;
    const pgRestore = dir ? path.join(dir, `pg_restore${exe}`) : `pg_restore${exe}`;
    const psql = dir ? path.join(dir, `psql${exe}`) : `psql${exe}`;

    const dumpProbe = spawnSync(pgDump, ["--version"], { encoding: "utf8" });
    const restoreProbe = spawnSync(pgRestore, ["--version"], { encoding: "utf8" });
    const psqlProbe = spawnSync(psql, ["--version"], { encoding: "utf8" });
    if (dumpProbe.status !== 0 || restoreProbe.status !== 0 || psqlProbe.status !== 0) {
      continue;
    }
    const major = parseToolMajor(dumpProbe.stdout ?? "");
    if (major !== null && major >= minMajor) {
      return { psql, pgDump, pgRestore, major };
    }
  }
  return null;
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

export interface RehearsalRunOptions {
  directUrl?: string;
  supabaseUrl?: string;
  serviceRoleKey?: string;
  storageBucket?: string;
  backupRoot?: string;
  localPg17AdminUrl?: string;
  repoRoot?: string;
  allowInsecureLocalhostStorage?: boolean;
  rehearsalMigrateCmd?: string[];
  skipOfflinePrismaEnginePreflight?: boolean;
}

export interface RehearsalReport {
  verifiedAt: string;
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
  ordersTotalAmountBefore: string;
  ordersTotalAmountAfter: string;
  rehearsalSchemaVerify: string;
  sourceFinishedMigrationsUnchanged: number;
  productionModified: false;
}

export async function runProdBackupRehearsal(
  options: RehearsalRunOptions = {}
): Promise<{ backupDir: string; reportPath: string; report: RehearsalReport }> {
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

  const secrets = [directUrl, serviceRoleKey].filter(Boolean);
  const log = (msg: string) => console.log(`[rehearse] ${redactSecrets(msg, secrets)}`);

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

  // Fast network reachability check with explicit IPv6-only Supabase direct-host guidance.
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
    // Windows ACLs handle user profile isolation natively
  }

  const dumpFile = path.join(backupDir, `xeroxease-prod-public-${stamp}.dump`);
  const tocFile = path.join(backupDir, "toc.txt");
  const storageDir = path.join(backupDir, "storage");
  const dbSumsFile = path.join(backupDir, "SHA256SUMS");
  const reportFile = path.join(backupDir, "rehearsal-report.json");

  const localAdminRaw = (options.localPg17AdminUrl ?? process.env.LOCAL_PG17_ADMIN_URL ?? "").trim();
  const rehearsalDbName = `xe_rehearsal_${stamp.toLowerCase()}_${process.pid}`;

  let dockerContainer = "";
  let localTempDbToDrop = "";
  let localAdminUrlObj: URL | null = null;

  try {
    // Detect whether local tools exist AND satisfy the source PostgreSQL major version.
    let localTools = discoverLocalPgTools(16);
    let sourceMajor = 17;
    if (localTools) {
      const verOut = runSafe(
        localTools.psql,
        [directUrl, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", "SELECT current_setting('server_version_num')::int / 10000;"],
        { secrets }
      )
        .toString("utf8")
        .trim();
      sourceMajor = Number(verOut) || 17;
      if (localTools.major < sourceMajor) {
        localTools = null;
      }
    }

    let rehearsalUrl = "";
    const useNativeLocal = Boolean(localTools && localAdminRaw);

    if (useNativeLocal && localTools) {
      localAdminUrlObj = assertLoopbackOnlyTarget(localAdminRaw);
      log(`Creating isolated local PostgreSQL rehearsal database (${rehearsalDbName})...`);
      runSafe(
        localTools.psql,
        [localAdminUrlObj.toString(), "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${rehearsalDbName}";`],
        { secrets }
      );
      localTempDbToDrop = rehearsalDbName;
      const targetUrl = new URL(localAdminUrlObj.toString());
      targetUrl.pathname = `/${rehearsalDbName}`;
      rehearsalUrl = assertLoopbackOnlyTarget(targetUrl.toString()).toString();
    } else {
      const dockerCheck = spawnSync("docker", ["info"], { encoding: "utf8" });
      if (dockerCheck.status !== 0) {
        throw new Error(
          `PostgreSQL >= ${sourceMajor} client/local server not configured and Docker is not running. Start Docker Desktop (recommended on Windows/macOS/Linux) or install PostgreSQL ${sourceMajor} and set LOCAL_PG17_ADMIN_URL.`
        );
      }
      const localPass = randomBytes(24).toString("hex");
      secrets.push(localPass);
      dockerContainer = `xe-pg17-rehearsal-${stamp.toLowerCase()}-${process.pid}`;
      log("Starting disposable loopback-only PostgreSQL 17 container (127.0.0.1)...");
      runSafe(
        "docker",
        [
          "run",
          "-d",
          "--name",
          dockerContainer,
          "-e",
          "POSTGRES_USER=postgres",
          "-e",
          `POSTGRES_PASSWORD=${localPass}`,
          "-e",
          "POSTGRES_DB=postgres",
          "-p",
          "127.0.0.1::5432",
          "postgres:17-alpine",
        ],
        { secrets }
      );

      const portOut = runSafe("docker", ["port", dockerContainer, "5432/tcp"], { secrets })
        .toString("utf8")
        .trim()
        .split(/\r?\n/)[0];
      const hostPort = portOut.split(":").pop()?.trim() ?? "";
      if (!/^\d+$/.test(hostPort)) {
        throw new Error("Could not resolve host port for local PostgreSQL 17 rehearsal container.");
      }

      let ready = false;
      for (let i = 0; i < 40; i++) {
        const probe = spawnSync("docker", ["exec", dockerContainer, "pg_isready", "-U", "postgres", "-d", "postgres"]);
        if (probe.status === 0) {
          ready = true;
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }
      if (!ready) {
        throw new Error("Disposable PostgreSQL 17 container did not become ready within 20s.");
      }

      runSafe(
        "docker",
        [
          "exec",
          dockerContainer,
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-X",
          "-q",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          `CREATE DATABASE "${rehearsalDbName}";`,
        ],
        { secrets }
      );
      rehearsalUrl = assertLoopbackOnlyTarget(
        `postgresql://postgres:${localPass}@127.0.0.1:${hostPort}/${rehearsalDbName}?sslmode=disable`
      ).toString();
    }

    const psqlSource = (sql: string): string => {
      if (useNativeLocal && localTools) {
        return runSafe(
          localTools.psql,
          [directUrl, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql],
          { secrets }
        )
          .toString("utf8")
          .trim();
      }
      return runSafe(
        "docker",
        [
          "exec",
          "-e",
          `SRC_DSN=${directUrl}`,
          dockerContainer,
          "sh",
          "-c",
          'psql "$SRC_DSN" -X -q -t -A -v ON_ERROR_STOP=1 -c "$1"',
          "_",
          sql,
        ],
        { secrets }
      )
        .toString("utf8")
        .trim();
    };

    const psqlRehearsal = (sql: string): string => {
      assertLoopbackOnlyTarget(rehearsalUrl);
      if (useNativeLocal && localTools) {
        return runSafe(
          localTools.psql,
          [rehearsalUrl, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql],
          { secrets }
        )
          .toString("utf8")
          .trim();
      }
      return runSafe(
        "docker",
        [
          "exec",
          dockerContainer,
          "psql",
          "-U",
          "postgres",
          "-d",
          rehearsalDbName,
          "-X",
          "-q",
          "-t",
          "-A",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          sql,
        ],
        { secrets }
      )
        .toString("utf8")
        .trim();
    };

    // --- Step 1: Read-only precheck + custom-format public schema dump -------
    const srcMigrationsBefore = Number(
      psqlSource("SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;")
    );
    log(`Step 1/7: Exporting custom-format PostgreSQL dump of schema "public" (source finished migrations=${srcMigrationsBefore})...`);

    let dumpBytesBuf: Buffer;
    if (useNativeLocal && localTools) {
      dumpBytesBuf = runSafe(
        localTools.pgDump,
        ["--dbname", directUrl, "--schema=public", "-Fc", "--no-owner", "--no-privileges"],
        { secrets }
      );
    } else {
      dumpBytesBuf = runSafe(
        "docker",
        [
          "exec",
          "-e",
          `SRC_DSN=${directUrl}`,
          dockerContainer,
          "sh",
          "-c",
          'pg_dump --dbname="$SRC_DSN" --schema=public -Fc --no-owner --no-privileges',
        ],
        { secrets }
      );
    }
    if (dumpBytesBuf.byteLength === 0) {
      throw new Error("pg_dump produced an empty 0-byte archive.");
    }
    writeFileSync(dumpFile, dumpBytesBuf, { mode: 0o600 });

    // --- Step 2: Verify pg_restore --list & all 14 XeroxEase tables ----------
    log("Step 2/7: Verifying dump archive table of contents (pg_restore --list)...");
    const tocRaw = (
      useNativeLocal && localTools
        ? runSafe(localTools.pgRestore, ["--list", dumpFile], { secrets })
        : runSafe("docker", ["exec", "-i", dockerContainer, "pg_restore", "--list"], {
            input: dumpBytesBuf,
            secrets,
          })
    ).toString("utf8");
    writeFileSync(tocFile, tocRaw, { mode: 0o600 });

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

    // --- Step 3: Archive private Supabase Storage bucket ---------------------
    log("Step 3/7: Archiving private Storage bucket into restricted directory...");
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

    // --- Step 4: Write & re-verify SHA-256 checksums across all artifacts ----
    log("Step 4/7: Computing and verifying SHA-256 checksums...");
    const dumpSha256 = createHash("sha256").update(readFileSync(dumpFile)).digest("hex");
    writeFileSync(dbSumsFile, `${dumpSha256}  ${path.basename(dumpFile)}\n`, { mode: 0o600 });

    for (const [baseDir, sumsName] of [
      [backupDir, "SHA256SUMS"],
      [storageDir, "SHA256SUMS"],
    ] as const) {
      const sumsPath = path.join(baseDir, sumsName);
      if (!existsSync(sumsPath)) throw new Error(`Missing checksum file in backup bundle (${sumsName}).`);
      const content = readFileSync(sumsPath, "utf8").trim();
      if (!content) continue;
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/);
        if (!match) throw new Error("Malformed SHA256SUMS line.");
        const [, expectedHex, relTarget] = match;
        const actualHex = createHash("sha256")
          .update(readFileSync(path.join(baseDir, ...relTarget.split("/"))))
          .digest("hex");
        if (actualHex !== expectedHex) {
          throw new Error("SHA-256 verification failed on backup artifact.");
        }
      }
    }

    // --- Step 5: Restore into isolated loopback PG17 database ----------------
    log("Step 5/7: Restoring archive into isolated local PostgreSQL 17 database...");
    assertLoopbackOnlyTarget(rehearsalUrl);
    if (useNativeLocal && localTools) {
      runSafe(
        localTools.pgRestore,
        [
          "--dbname",
          rehearsalUrl,
          "--clean",
          "--if-exists",
          "--no-owner",
          "--no-privileges",
          "--exit-on-error",
          dumpFile,
        ],
        { secrets }
      );
    } else {
      runSafe(
        "docker",
        [
          "exec",
          "-i",
          dockerContainer,
          "pg_restore",
          "-U",
          "postgres",
          "-d",
          rehearsalDbName,
          "--clean",
          "--if-exists",
          "--no-owner",
          "--no-privileges",
          "--exit-on-error",
        ],
        { input: dumpBytesBuf, secrets }
      );
    }

    const rowCountsSql = `SELECT json_build_object(
      'users', (SELECT count(*) FROM users),
      'sessions', (SELECT count(*) FROM sessions),
      'password_reset_tokens', (SELECT count(*) FROM password_reset_tokens),
      'recovery_codes', (SELECT count(*) FROM recovery_codes),
      'pricing_config', (SELECT count(*) FROM pricing_config),
      'orders', (SELECT count(*) FROM orders),
      'uploaded_files', (SELECT count(*) FROM uploaded_files),
      'order_events', (SELECT count(*) FROM order_events),
      'payment_events', (SELECT count(*) FROM payment_events),
      'feedback', (SELECT count(*) FROM feedback),
      'notifications', (SELECT count(*) FROM notifications),
      'audit_logs', (SELECT count(*) FROM audit_logs),
      'settings', (SELECT count(*) FROM settings)
    )::text;`;

    const countsBeforeRaw = psqlRehearsal(rowCountsSql);
    const totalAmountBefore = psqlRehearsal("SELECT coalesce(sum(total_amount), 0)::text FROM orders;");

    // --- Step 6: Apply pending migrations strictly against loopback copy -----
    log("Step 6/7: Running pending Prisma migrations against isolated local PG17 copy ONLY...");
    assertLoopbackOnlyTarget(rehearsalUrl);
    const migrateEnv: NodeJS.ProcessEnv = {
      ...process.env,
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

    // --- Step 7: Verify 1:1 data preservation, schema convergence & untouched Prod
    log("Step 7/7: Verifying 1:1 row/amount preservation, schema convergence, and untouched Production DB...");
    const countsAfterRaw = psqlRehearsal(rowCountsSql);
    const totalAmountAfter = psqlRehearsal("SELECT coalesce(sum(total_amount), 0)::text FROM orders;");

    if (countsBeforeRaw !== countsAfterRaw || totalAmountBefore !== totalAmountAfter) {
      throw new Error(
        `Data preservation check failed on rehearsal DB (counts before=${countsBeforeRaw}, after=${countsAfterRaw}; sum before=${totalAmountBefore}, after=${totalAmountAfter}).`
      );
    }

    const schemaVerify = psqlRehearsal(`SELECT
      (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) || ':' ||
      (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='orders') || ':' ||
      ('DELIVERED'::"OrderStatus")::text || ':' ||
      ('UPI'::"PaymentMethod")::text;`);
    if (schemaVerify !== "5:40:DELIVERED:UPI") {
      throw new Error(
        `Post-migration schema verification failed on rehearsal DB (got "${schemaVerify}", expected "5:40:DELIVERED:UPI").`
      );
    }

    const appliedRowsJson = psqlRehearsal(
      "SELECT coalesce(json_agg(migration_name ORDER BY started_at), '[]'::json)::text FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;"
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

    const srcMigrationsAfter = Number(
      psqlSource("SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;")
    );
    if (srcMigrationsBefore !== srcMigrationsAfter) {
      throw new Error(
        `Unexpected change in source _prisma_migrations count (${srcMigrationsBefore} -> ${srcMigrationsAfter}).`
      );
    }

    const report: RehearsalReport = {
      verifiedAt: new Date().toISOString(),
      dumpBytes: dumpBytesBuf.byteLength,
      dumpSha256,
      tocEntries,
      storage: {
        bucket: storageSummary.bucket,
        objectCount: storageSummary.objectCount,
        totalBytes: storageSummary.totalBytes,
      },
      rehearsalRowCountsBefore: JSON.parse(countsBeforeRaw) as Record<string, number>,
      rehearsalRowCountsAfter: JSON.parse(countsAfterRaw) as Record<string, number>,
      ordersTotalAmountBefore: totalAmountBefore,
      ordersTotalAmountAfter: totalAmountAfter,
      rehearsalSchemaVerify: schemaVerify,
      sourceFinishedMigrationsUnchanged: srcMigrationsAfter,
      productionModified: false,
    };

    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

    log("======================================================================");
    log("REHEARSAL PASSED — Production database was NOT modified.");
    log(`  Backup folder     : ${backupDir}`);
    log(`  Dump size (bytes) : ${report.dumpBytes}`);
    log(`  Dump SHA-256      : ${report.dumpSha256}`);
    log(`  Storage archive   : ${JSON.stringify(report.storage)}`);
    log(`  Orders sum kept   : ${report.ordersTotalAmountBefore} -> ${report.ordersTotalAmountAfter}`);
    log(`  Schema verified   : ${report.rehearsalSchemaVerify}`);
    log(`  Report file       : ${reportFile}`);
    log("======================================================================");

    return { backupDir, reportPath: reportFile, report };
  } finally {
    if (localTempDbToDrop && localAdminUrlObj) {
      const cleanupTools = discoverLocalPgTools(16);
      if (cleanupTools) {
        spawnSync(
          cleanupTools.psql,
          [localAdminUrlObj.toString(), "-X", "-q", "-c", `DROP DATABASE IF EXISTS "${localTempDbToDrop}" WITH (FORCE);`],
          { stdio: "ignore" }
        );
      }
    }
    if (dockerContainer) {
      spawnSync("docker", ["rm", "-f", "-v", dockerContainer], { stdio: "ignore" });
    }
  }
}

async function main(): Promise<void> {
  try {
    await runProdBackupRehearsal();
  } catch (err) {
    const safeMsg = err instanceof Error ? err.message : "Rehearsal failed.";
    console.error(
      `[rehearse] FAILED: ${redactSecrets(safeMsg, [
        process.env.DIRECT_URL ?? "",
        process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      ])}`
    );
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
