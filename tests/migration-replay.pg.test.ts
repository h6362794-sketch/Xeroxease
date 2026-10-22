// Database-backed migration replay: reproduces the 2026-10-20 `/dashboard` outage and
// proves both the failure and the cure against a real PostgreSQL server.
//
// WHY
// Every other migration test in this repository is either text-level
// (`scripts/verify-migrations.ts`) or replays into an empty throwaway database (the CI
// `migrations` job). Neither one reproduces "the code is newer than the database", which
// is what actually broke production: the deployed build expected `orders.pricing_snapshot`
// and a `DELIVERED` enum label that the database did not have.
//
// WHAT
// Builds three local scratch databases from committed migrations:
//   * `baseline` — only the three earlier migrations reported applied in Production
//   * `full`     — all committed migrations, including both October 20 migrations
//   * `data`     — `baseline`, then seeded with synthetic legacy rows, then migrated
// These are synthetic replay targets, never a Production restore or clone. The test
// asserts that the dashboard's exact query shape fails on `baseline` and succeeds on
// `full`, that `full` satisfies schema.prisma completely, and that applying the pending
// migrations to populated tables destroys nothing.
//
// SAFETY
// Skipped unless `PG_TEST_DSN` names a disposable target explicitly, and refuses to run
// against anything that looks like a managed/production database. It only ever creates and
// drops databases whose names this file generates, and it never prints the DSN.
//
// USAGE
//   PG_TEST_DSN="postgresql://postgres@localhost:5432/postgres" npx vitest run tests/migration-replay.pg.test.ts
//
// It needs a `psql` client on PATH and a role that may CREATE DATABASE on that target.
// Prisma's own engine is deliberately not required, so this test keeps working in
// environments where `prisma generate` cannot download a binary.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareMigrations } from "@/server/schema-readiness";

const DSN = process.env.PG_TEST_DSN;
const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const PSQL_ENV: NodeJS.ProcessEnv = { ...process.env };
for (const name of ["PGHOST", "PGHOSTADDR", "PGPORT", "PGSERVICE", "PGSERVICEFILE"]) delete PSQL_ENV[name];

/**
 * This test creates and drops databases, so accept loopback DSNs only. The
 * hostname and libpq override parameters are checked without ever logging DSN.
 */
const FORBIDDEN_DSN = /supabase\.(co|com|in)|pooler|vercel|amazonaws|neon\.tech|azure/i;
function isSafeLocalDsn(raw: string | undefined): boolean {
  if (!raw || FORBIDDEN_DSN.test(raw)) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") return false;
    // Query parameters can override the URI authority or resolve a service file.
    if (url.searchParams.has("host") || url.searchParams.has("hostaddr") || url.searchParams.has("service")) {
      return false;
    }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

const psqlAvailable = spawnSync("psql", ["--version"], { encoding: "utf8" }).status === 0;
const targetIsSafe = isSafeLocalDsn(DSN);
if (DSN && !targetIsSafe) {
  throw new Error("PG_TEST_DSN must be a loopback PostgreSQL URI without host/service overrides.");
}
if (DSN && !psqlAvailable) {
  throw new Error("PG_TEST_DSN was supplied, but the psql client is unavailable.");
}
const enabled = Boolean(DSN);

describe("migration replay target guard", () => {
  it.each([
    "postgresql://localhost:5432/postgres",
    "postgresql://127.0.0.1:5432/postgres",
    "postgresql://user@[::1]:5432/postgres",
  ])("accepts loopback test target %s", (dsn) => {
    expect(isSafeLocalDsn(dsn)).toBe(true);
  });

  it.each([
    "postgresql://db.example.com:5432/postgres",
    "postgresql://localhost:5432/postgres?host=db.example.com",
    "postgresql://localhost:5432/postgres?service=production",
    "http://localhost:5432/postgres",
  ])("rejects non-local or overridden target %s", (dsn) => {
    expect(isSafeLocalDsn(dsn)).toBe(false);
  });

  it("redacts PostgreSQL connection URIs from diagnostics", () => {
    const diagnostic = redactConnectionUri("connection failed: postgresql://operator@localhost:5432/postgres");
    expect(diagnostic).not.toContain("postgresql://");
    expect(diagnostic).toContain("[redacted PostgreSQL connection URI]");
  });
});

/** Committed migrations, in the order Prisma applies them (lexicographic). */
function committedMigrations(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Point a connection URI at a different database.
 *
 * `psql "<uri>" -d otherdb` discards the URI entirely, so the database is
 * substituted into the URI instead. This test's DSN guard permits only explicit
 * loopback authorities; `host`, `hostaddr`, and `service` overrides are rejected.
 */
function withDatabase(dsn: string, database: string): string {
  const queryAt = dsn.indexOf("?");
  const base = queryAt === -1 ? dsn : dsn.slice(0, queryAt);
  const query = queryAt === -1 ? "" : dsn.slice(queryAt);
  const schemeEnd = base.indexOf("://");
  if (schemeEnd === -1) {
    throw new Error("PG_TEST_DSN must be a postgresql:// URI (keyword/value form is not supported)");
  }
  const slash = base.lastIndexOf("/");
  const authorityEnd = schemeEnd + 3;
  const prefix = slash < authorityEnd ? `${base}/` : base.slice(0, slash + 1);
  return `${prefix}${database}${query}`;
}

function redactConnectionUri(value: string): string {
  return value.replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[redacted PostgreSQL connection URI]");
}

/** Run psql and return stdout without surfacing its connection URI on errors. */
function psql(database: string, args: string[]): string {
  try {
    return execFileSync(
      "psql",
      [withDatabase(DSN as string, database), "-X", "-v", "ON_ERROR_STOP=1", "-q", ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: PSQL_ENV }
    );
  } catch (error) {
    const e = error as { stderr?: string | Buffer; message?: string };
    const stderr = redactConnectionUri(String(e.stderr ?? e.message ?? ""));
    throw Object.assign(new Error(stderr || "psql command failed without diagnostic"), { stderr });
  }
}

/** Run a binary PostgreSQL client tool (`pg_dump`/`pg_restore`) while redacting any URI on error. */
function runPgBinaryTool(tool: string, args: string[], input?: Buffer): Buffer {
  try {
    return execFileSync(tool, args, {
      input,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      env: PSQL_ENV,
    });
  } catch (error) {
    const e = error as { stderr?: string | Buffer; message?: string };
    const stderr = redactConnectionUri(String(e.stderr ?? e.message ?? ""));
    throw Object.assign(new Error(stderr || `${tool} failed without diagnostic`), { stderr });
  }
}

function majorVersionOfTool(tool: string): number | null {
  const probe = spawnSync(tool, ["--version"], { encoding: "utf8", env: PSQL_ENV });
  if (probe.status !== 0) return null;
  const match = `${probe.stdout ?? ""}`.match(/(\d+)(?:\.\d+)?/);
  return match ? Number(match[1]) : null;
}

/** Run psql, returning `{ ok, stderr }` instead of throwing. */
function psqlFail(database: string, sql: string): { ok: boolean; stderr: string } {
  try {
    psql(database, ["-c", sql]);
    return { ok: true, stderr: "" };
  } catch (error) {
    const e = error as { stderr?: string | Buffer; message?: string };
    return { ok: false, stderr: redactConnectionUri(String(e.stderr ?? e.message ?? "")) };
  }
}

function applyMigrations(database: string, names: string[]): void {
  for (const name of names) {
    psql(database, ["-1", "-f", join(MIGRATIONS, name, "migration.sql")]);
  }
}

const suffix = `${process.pid}_${Date.now()}`;
const BASELINE_DB = `xe_replay_baseline_${suffix}`;
const FULL_DB = `xe_replay_full_${suffix}`;
const DATA_DB = `xe_replay_data_${suffix}`;
const RESTORE_DB = `xe_replay_restore_${suffix}`;
let scratchDir: string | undefined;

/** The three migrations production had applied before the incident. */
const APPLIED_IN_PRODUCTION = [
  "20261013000000_init",
  "20261014000000_recovery_codes",
  "20261015000000_direct_upload_intents",
];
const OCTOBER_20_MIGRATIONS = [
  "20261020000000_order_lifecycle_enum_values",
  "20261020000100_order_lifecycle_payments_pricing",
];
const NEW_ORDER_COLUMNS = [
  "payment_method", "accepted_at", "accepted_by", "rejected_at", "rejected_by",
  "rejection_reason", "delivered_at", "pricing_snapshot", "finishing_options",
];
const NEW_ORDER_STATUS_LABELS = ["ORDER_RECEIVED", "ACCEPTED", "READY_FOR_PICKUP", "DELIVERED", "REJECTED"];
const NEW_NOTIFICATION_LABELS = ["ORDER_REJECTED", "ORDER_ACCEPTED"];

describe.skipIf(!enabled)("migration replay against a real PostgreSQL", () => {
  beforeAll(() => {
    scratchDir = mkdtempSync(join(tmpdir(), "xe-pg-replay-"));
    const all = committedMigrations();
    for (const db of [BASELINE_DB, FULL_DB, DATA_DB, RESTORE_DB]) {
      psql("postgres", ["-c", `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`]);
    }
    for (const db of [BASELINE_DB, FULL_DB, DATA_DB]) {
      psql("postgres", ["-c", `CREATE DATABASE "${db}"`]);
    }
    applyMigrations(BASELINE_DB, all.filter((name) => APPLIED_IN_PRODUCTION.includes(name)));
    applyMigrations(FULL_DB, all);
    applyMigrations(DATA_DB, all.filter((name) => APPLIED_IN_PRODUCTION.includes(name)));
  });

  afterAll(() => {
    for (const db of [BASELINE_DB, FULL_DB, DATA_DB, RESTORE_DB]) {
      try {
        psql("postgres", ["-c", `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`]);
      } catch {
        // Best effort: a leftover scratch database must never fail the suite.
      }
    }
    if (scratchDir) {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("applies every committed migration cleanly, in order", () => {
    const expected = committedMigrations();
    expect(expected.length).toBeGreaterThanOrEqual(5);
    expect(expected.slice(0, APPLIED_IN_PRODUCTION.length)).toEqual(APPLIED_IN_PRODUCTION);
    expect(expected.filter((name) => name.startsWith("20261020"))).toEqual(OCTOBER_20_MIGRATIONS);
    expect(expected.indexOf(OCTOBER_20_MIGRATIONS[0])).toBeLessThan(expected.indexOf(OCTOBER_20_MIGRATIONS[1]));
    const tables = psql(FULL_DB, ["-tAc", "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"]);
    expect(Number(tables.trim())).toBeGreaterThan(0);
  });

  it("matches the three-migration baseline before the October 20 changes", () => {
    const columns = rows(
      BASELINE_DB,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='orders'
         AND column_name IN (${NEW_ORDER_COLUMNS.map((name) => `'${name}'`).join(",")})
       ORDER BY column_name`
    ).map((row) => row[0]);
    expect(columns).toEqual([]);

    const missingEnumValues = rows(
      BASELINE_DB,
      `SELECT t.typname, e.enumlabel FROM pg_type t
       JOIN pg_enum e ON e.enumtypid=t.oid
       JOIN pg_namespace n ON n.oid=t.typnamespace
       WHERE n.nspname='public' AND (
         (t.typname='OrderStatus' AND e.enumlabel IN (${NEW_ORDER_STATUS_LABELS.map((label) => `'${label}'`).join(",")})) OR
         (t.typname='NotificationType' AND e.enumlabel IN (${NEW_NOTIFICATION_LABELS.map((label) => `'${label}'`).join(",")}))
       ) ORDER BY t.typname, e.enumsortorder`
    );
    expect(missingEnumValues).toEqual([]);
    expect(psql(BASELINE_DB, ["-tAc", `SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='PaymentMethod'`]).trim()).toBe("0");
    expect(psql(BASELINE_DB, ["-tAc", "SELECT to_regclass('public.orders_payment_method_payment_status_idx') IS NULL"]).trim()).toBe("t");

    const statusDefault = psql(
      BASELINE_DB,
      ["-tAc", "SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='status'"]
    ).trim();
    expect(statusDefault).toContain("ORDER_PLACED");
    expect(statusDefault).not.toContain("ORDER_RECEIVED");
  });

  it("reproduces the production failure on the three-migration baseline schema", () => {
    const failure = psqlFail(
      BASELINE_DB,
      'SELECT "t"."pricing_snapshot" FROM "public"."orders" AS "t" LIMIT 0'
    );
    expect(failure.ok).toBe(false);
    // The exact sentence from the production log.
    expect(failure.stderr).toMatch(/pricing_snapshot/);
    expect(failure.stderr).toMatch(/does not exist/i);
  });

  it("reproduces the enum failure the same deploy would hit next", () => {
    const failure = psqlFail(BASELINE_DB, `SELECT 'DELIVERED'::"OrderStatus"`);
    expect(failure.ok).toBe(false);
    expect(failure.stderr).toMatch(/invalid input value for enum/i);

    const type = psqlFail(BASELINE_DB, `SELECT 'UPI'::"PaymentMethod"`);
    expect(type.ok).toBe(false);
    expect(type.stderr).toMatch(/PaymentMethod|does not exist/i);
  });

  it("runs the dashboard's exact query shape once migrated", () => {
    const columns = orderColumnsFromSchema();
    expect(columns.length).toBe(40);

    const select = columns.map((c) => `"t"."${c}"`).join(", ");
    const sql =
      `SELECT ${select} FROM "public"."orders" AS "t" ` +
      `WHERE ("t"."user_id" = 'replay-none' AND "t"."status" NOT IN ` +
      `('DELIVERED','REJECTED','COMPLETED','CANCELLED','FAILED')) ` +
      `ORDER BY "t"."created_at" DESC LIMIT 5`;
    expect(() => psql(FULL_DB, ["-c", sql])).not.toThrow();
  });

  it("satisfies schema.prisma completely — every column, enum label and table", () => {
    const { tables, columns, enums } = parseSchema();
    const dbColumns = new Map<string, Set<string>>();
    for (const row of rows(FULL_DB, "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'")) {
      if (!dbColumns.has(row[0])) dbColumns.set(row[0], new Set());
      dbColumns.get(row[0])!.add(row[1]);
    }

    const missing: string[] = [];
    for (const [table, cols] of columns) {
      if (!dbColumns.has(table)) { missing.push(`table ${table}`); continue; }
      for (const col of cols) if (!dbColumns.get(table)!.has(col)) missing.push(`${table}.${col}`);
    }
    for (const [name, labels] of enums) {
      const present = new Set(
        rows(FULL_DB, `SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid WHERE t.typname='${name}'`).map((r) => r[0])
      );
      if (present.size === 0) { missing.push(`enum ${name}`); continue; }
      for (const label of labels) if (!present.has(label)) missing.push(`${name}.${label}`);
    }
    expect(tables.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it("verifies October 20 order columns, enum labels, index, and defaults", () => {
    const columnRows = rows(
      FULL_DB,
      `SELECT column_name, data_type, udt_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='orders'
         AND column_name IN (${NEW_ORDER_COLUMNS.map((name) => `'${name}'`).join(",")})
       ORDER BY column_name`
    );
    expect(columnRows.map((row) => row[0]).sort()).toEqual([...NEW_ORDER_COLUMNS].sort());
    const byName = new Map(columnRows.map((row) => [row[0], row]));
    expect(byName.get("payment_method")?.slice(1, 4)).toEqual(["USER-DEFINED", "PaymentMethod", "YES"]);
    expect(byName.get("pricing_snapshot")?.slice(1, 4)).toEqual(["jsonb", "jsonb", "YES"]);
    expect(byName.get("finishing_options")?.slice(1, 4)).toEqual(["ARRAY", "_text", "NO"]);
    expect(byName.get("finishing_options")?.[4].toLowerCase()).toContain("array[]::text[]");
    for (const name of ["accepted_at", "rejected_at", "delivered_at"]) {
      expect(byName.get(name)?.slice(1, 4)).toEqual(["timestamp without time zone", "timestamp", "YES"]);
    }
    for (const name of ["accepted_by", "rejected_by", "rejection_reason"]) {
      expect(byName.get(name)?.slice(1, 4)).toEqual(["text", "text", "YES"]);
    }

    const orderLabels = rows(
      FULL_DB,
      `SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
       JOIN pg_namespace n ON n.oid=t.typnamespace
       WHERE n.nspname='public' AND t.typname='OrderStatus'
         AND e.enumlabel IN (${NEW_ORDER_STATUS_LABELS.map((label) => `'${label}'`).join(",")})
       ORDER BY e.enumsortorder`
    ).map((row) => row[0]);
    expect(orderLabels).toEqual(NEW_ORDER_STATUS_LABELS);

    const notificationLabels = rows(
      FULL_DB,
      `SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
       JOIN pg_namespace n ON n.oid=t.typnamespace
       WHERE n.nspname='public' AND t.typname='NotificationType'
         AND e.enumlabel IN (${NEW_NOTIFICATION_LABELS.map((label) => `'${label}'`).join(",")})
       ORDER BY e.enumsortorder`
    ).map((row) => row[0]);
    expect(notificationLabels).toEqual(NEW_NOTIFICATION_LABELS);

    const paymentMethodLabels = rows(
      FULL_DB,
      `SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
       JOIN pg_namespace n ON n.oid=t.typnamespace
       WHERE n.nspname='public' AND t.typname='PaymentMethod' ORDER BY e.enumsortorder`
    ).map((row) => row[0]);
    expect(paymentMethodLabels).toEqual(["CASH_ON_DELIVERY", "UPI"]);

    const indexRows = rows(
      FULL_DB,
      `SELECT i.indisvalid::text, pg_get_indexdef(i.indexrelid) FROM pg_index i
       JOIN pg_class idx ON idx.oid=i.indexrelid
       JOIN pg_namespace n ON n.oid=idx.relnamespace
       WHERE n.nspname='public' AND idx.relname='orders_payment_method_payment_status_idx'`
    );
    expect(indexRows).toHaveLength(1);
    expect(indexRows[0][0]).toBe("true");
    const indexDefinition = indexRows[0][1].toLowerCase();
    expect(indexDefinition).toContain("create index orders_payment_method_payment_status_idx");
    expect(indexDefinition).toContain("(payment_method, payment_status)");

    const statusDefault = psql(
      FULL_DB,
      ["-tAc", "SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='status'"]
    ).trim();
    expect(statusDefault).toContain("ORDER_RECEIVED");
  });

  it("preserves existing data while applying the pending migrations", () => {
    // Legacy-shaped synthetic rows: a student, a session, orders in old statuses, an
    // event, a payment, a recovery code and a notification.
    psql(DATA_DB, ["-c", `
      INSERT INTO users (id,email,email_norm,name,"passwordHash",role,is_active,failed_login_count,created_at,updated_at)
      VALUES ('u1','a@example.test','a@example.test','A','$2a$04$x','STUDENT',true,0,now(),now());
      INSERT INTO sessions (id,user_id,token_hash,kind,expires_at,created_at)
      VALUES ('s1','u1','h1','STUDENT',now()+interval '1 hour',now());
      INSERT INTO orders (id,order_number,user_id,paper_size,color_mode,copies,total_pages,billable_pages,
        price_per_page,finishing_fee,total_amount,status,payment_status,payment_ref,created_at,updated_at)
      VALUES ('o1','XE-R-1','u1','A4','BW',2,10,20,2.50,0.00,50.00,'PAYMENT_CONFIRMED','PAYMENT_CONFIRMED','UPI/R1',now(),now()),
             ('o2','XE-R-2','u1','LEGAL','COLOR',1,4,4,10.00,15.00,55.00,'COMPLETED','PAYMENT_CONFIRMED',NULL,now(),now());
      INSERT INTO order_events (id,order_id,type,message,created_at) VALUES ('e1','o1','STATUS_CHANGE','x',now());
      INSERT INTO payment_events (id,order_id,type,created_at) VALUES ('p1','o1','PAYMENT_CONFIRMED',now());
      INSERT INTO recovery_codes (id,user_id,code_hash,created_at) VALUES ('r1','u1','ch1',now());
      INSERT INTO notifications (id,user_id,type,title,body,created_at) VALUES ('n1','u1','ORDER_COMPLETED','t','b',now());
    `]);

    const snapshotSql =
      "SELECT (SELECT count(*) FROM users)||'|'||(SELECT count(*) FROM sessions)||'|'||" +
      "(SELECT count(*)||':'||sum(total_amount)||':'||md5(string_agg(id||status::text||total_amount, '|' ORDER BY id)) FROM orders)||'|'||" +
      "(SELECT count(*) FROM order_events)||'|'||(SELECT count(*) FROM payment_events)||'|'||" +
      "(SELECT count(*) FROM recovery_codes)||'|'||(SELECT count(*) FROM notifications)";
    const before = psql(DATA_DB, ["-tAc", snapshotSql]).trim();

    const pending = committedMigrations().filter((name) => !APPLIED_IN_PRODUCTION.includes(name));
    expect(pending.slice(0, OCTOBER_20_MIGRATIONS.length)).toEqual(OCTOBER_20_MIGRATIONS);

    // Rehearse a full custom-format dump (`pg_dump -Fc`) and isolated restore (`pg_restore`)
    // before mutating DATA_DB, then migrate BOTH the restored copy and DATA_DB and verify
    // identical checksums and row counts across every table.
    const serverMajor = Math.floor(
      Number(psql(DATA_DB, ["-tAc", "SELECT current_setting('server_version_num')::int"]).trim()) / 10000
    );
    const dumpMajor = majorVersionOfTool("pg_dump");
    const restoreMajor = majorVersionOfTool("pg_restore");
    const requireDump = process.env.PG_REQUIRE_DUMP_REHEARSAL === "1";
    if (requireDump && (!dumpMajor || !restoreMajor || dumpMajor < serverMajor)) {
      throw new Error(
        `PG_REQUIRE_DUMP_REHEARSAL=1 requires pg_dump/pg_restore >= ${serverMajor} (found dump=${dumpMajor}, restore=${restoreMajor})`
      );
    }
    if (dumpMajor && restoreMajor && dumpMajor >= serverMajor) {
      const dumpPath = join(scratchDir as string, "pre-migration.dump");
      const archive = runPgBinaryTool("pg_dump", [
        "--dbname",
        withDatabase(DSN as string, DATA_DB),
        "-Fc",
        "--no-owner",
        "--no-privileges",
      ]);
      expect(archive.byteLength).toBeGreaterThan(0);
      writeFileSync(dumpPath, archive);
      psql("postgres", ["-c", `CREATE DATABASE "${RESTORE_DB}"`]);
      runPgBinaryTool(
        "pg_restore",
        ["--dbname", withDatabase(DSN as string, RESTORE_DB), "--no-owner", "--no-privileges"],
        readFileSync(dumpPath)
      );
      expect(psql(RESTORE_DB, ["-tAc", snapshotSql]).trim()).toBe(before);

      applyMigrations(RESTORE_DB, pending);
      expect(psql(RESTORE_DB, ["-tAc", snapshotSql]).trim()).toBe(before);
    }

    applyMigrations(DATA_DB, pending);

    const after = psql(DATA_DB, ["-tAc", snapshotSql]).trim();
    expect(after).toBe(before);

    // New columns exist and are null/empty on historical rows; old labels still readable.
    const legacy = rows(DATA_DB, "SELECT status::text, payment_method::text, pricing_snapshot::text, array_length(finishing_options,1) FROM orders ORDER BY id");
    expect(legacy.map((r) => r[0])).toEqual(["PAYMENT_CONFIRMED", "COMPLETED"]);
    for (const row of legacy) {
      expect(row[1]).toBe("");
      expect(row[2]).toBe("");
      expect(row[3]).toBe("");
    }
    expect(
      Number(psql(DATA_DB, ["-tAc", "SELECT count(*) FROM orders WHERE status IN ('PAYMENT_CONFIRMED','COMPLETED')"]).trim())
    ).toBe(2);
  });

  it("drives the release gate from real recorded history and rejects incomplete or rolled-back entries", () => {
    // `npm run preflight:schema` reads `_prisma_migrations` and hands the names to
    // `compareMigrations`. This exercises that decision path against a real history
    // table, so the gate's verdict is validated even where the Prisma *client* cannot
    // be generated (the adapter itself only issues the SELECT asserted here).
    psql(BASELINE_DB, ["-c", `
      CREATE TABLE "_prisma_migrations" (
        id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz,
        migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
        started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0);
    `]);
    for (const name of APPLIED_IN_PRODUCTION) {
      psql(BASELINE_DB, ["-c",
        `INSERT INTO "_prisma_migrations" (id,checksum,finished_at,migration_name,started_at,applied_steps_count)
         VALUES (gen_random_uuid()::text,'x',now(),'${name}',now(),1)`]);
    }
    // Simulate a migration whose SQL failed mid-run (`finished_at IS NULL`, `rolled_back_at IS NULL`):
    // it MUST NOT be counted as applied by `_prisma_migrations` queries.
    psql(BASELINE_DB, ["-c", `
      INSERT INTO "_prisma_migrations" (id,checksum,finished_at,migration_name,logs,started_at,applied_steps_count)
      VALUES (gen_random_uuid()::text,'x',NULL,'20261020000000_order_lifecycle_enum_values','ERROR: statement aborted',now(),0)
    `]);

    const recorded = rows(
      BASELINE_DB,
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"
    ).map((r) => r[0]);

    const readiness = compareMigrations(committedMigrations(), recorded);
    expect(readiness.ok).toBe(false);
    expect(readiness.pending).toEqual([
      "20261020000000_order_lifecycle_enum_values",
      "20261020000100_order_lifecycle_payments_pricing",
    ]);
    expect(readiness.unknownApplied).toEqual([]);

    // A rolled-back row must not count as applied either.
    psql(BASELINE_DB, ["-c", `UPDATE "_prisma_migrations" SET rolled_back_at = now()`]);
    expect(
      rows(BASELINE_DB, "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
    ).toEqual([]);
  });

  it("uses the new lifecycle default and supports new payment, pricing snapshot, finishing, and notification values", () => {
    psql(FULL_DB, ["-c", `
      INSERT INTO users (id,email,email_norm,name,"passwordHash",role,is_active,created_at,updated_at)
      VALUES ('u-new','n@example.test','n@example.test','N','h','STUDENT',true,now(),now()),
             ('u-adm','adm@example.test','adm@example.test','Admin','h','ADMIN',true,now(),now());
      INSERT INTO orders (id,order_number,user_id,paper_size,color_mode,copies,total_pages,billable_pages,
        price_per_page,finishing_fee,total_amount,created_at,updated_at)
      VALUES ('o-new','XE-NEW-1','u-new','A4','BW',1,1,1,2.5,0,2.5,now(),now());
      INSERT INTO orders (id,order_number,user_id,paper_size,color_mode,copies,total_pages,billable_pages,
        price_per_page,finishing_fee,total_amount,status,payment_method,accepted_at,accepted_by,
        delivered_at,pricing_snapshot,finishing_options,created_at,updated_at)
      VALUES ('o-life','XE-NEW-2','u-new','A4','COLOR',2,5,10,8.0,40.0,120.0,'DELIVERED','UPI',
        now(),'u-adm',now(),'{"rateKey":"A4_COLOR","perPage":8,"finishing":["SPIRAL"]}'::jsonb,
        ARRAY['SPIRAL','STAPLE'],now(),now());
      INSERT INTO orders (id,order_number,user_id,paper_size,color_mode,copies,total_pages,billable_pages,
        price_per_page,finishing_fee,total_amount,status,payment_method,rejected_at,rejected_by,
        rejection_reason,created_at,updated_at)
      VALUES ('o-rej','XE-NEW-3','u-new','LEGAL','BW',1,3,3,3.0,0.0,9.0,'REJECTED','CASH_ON_DELIVERY',
        now(),'u-adm','Corrupted scan pages',now(),now());
      INSERT INTO notifications (id,user_id,type,title,body,created_at)
      VALUES ('n-acc','u-new','ORDER_ACCEPTED','Accepted','Order accepted',now()),
             ('n-rej','u-new','ORDER_REJECTED','Rejected','Order rejected',now());
    `]);
    expect(psql(FULL_DB, ["-tAc", "SELECT status::text FROM orders WHERE id='o-new'"]).trim()).toBe("ORDER_RECEIVED");
    expect(psql(FULL_DB, ["-tAc", "SELECT cardinality(finishing_options) FROM orders WHERE id='o-new'"]).trim()).toBe("0");
    expect(
      rows(
        FULL_DB,
        "SELECT status::text, payment_method::text, pricing_snapshot->>'rateKey', array_to_string(finishing_options, ',') FROM orders WHERE id='o-life'"
      )[0]
    ).toEqual(["DELIVERED", "UPI", "A4_COLOR", "SPIRAL,STAPLE"]);
    expect(
      rows(FULL_DB, "SELECT status::text, payment_method::text, rejection_reason FROM orders WHERE id='o-rej'")[0]
    ).toEqual(["REJECTED", "CASH_ON_DELIVERY", "Corrupted scan pages"]);
    expect(
      rows(FULL_DB, "SELECT type::text FROM notifications WHERE id IN ('n-acc','n-rej') ORDER BY id").map((r) => r[0])
    ).toEqual(["ORDER_ACCEPTED", "ORDER_REJECTED"]);
  });
});

// ---------------------------------------------------------------------------
// schema.prisma parsing (kept local: this test must not depend on app imports)
// ---------------------------------------------------------------------------

function schemaSource(): string {
  return readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const SCALARS = new Set(["String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json", "Bytes"]);

function parseSchema(): { tables: string[]; columns: Map<string, string[]>; enums: Map<string, string[]> } {
  const src = schemaSource();
  const enums = new Map<string, string[]>();
  for (const match of src.matchAll(/enum\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    enums.set(
      match[1],
      match[2].split("\n").map((l) => l.trim()).filter((l) => /^[A-Z][A-Z0-9_]*$/.test(l))
    );
  }
  const tables: string[] = [];
  const columns = new Map<string, string[]>();
  for (const match of src.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const body = match[2];
    const table = body.match(/@@map\("([^"]+)"\)/)?.[1] ?? match[1];
    tables.push(table);
    const cols: string[] = [];
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("@@")) continue;
      const field = line.match(/^(\w+)\s+([A-Za-z_]\w*)(\[\])?/);
      if (!field) continue;
      const [, name, type] = field;
      if (!SCALARS.has(type) && !enums.has(type)) continue; // relation
      cols.push(line.match(/@map\("([^"]+)"\)/)?.[1] ?? name);
    }
    columns.set(table, cols);
  }
  return { tables, columns, enums };
}

/** The `orders` columns Prisma selects when a query omits `select`. */
function orderColumnsFromSchema(): string[] {
  return parseSchema().columns.get("orders") ?? [];
}

function rows(database: string, sql: string): string[][] {
  const out = psql(database, ["-tAF", "\u0001", "-c", sql]);
  return out.split("\n").filter(Boolean).map((line) => line.split("\u0001"));
}
