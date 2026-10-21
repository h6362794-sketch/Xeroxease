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
// Builds three scratch databases from the committed migrations:
//   * `prod`  — only the migrations production had applied (the three pre-existing ones)
//   * `full`  — all committed migrations
//   * `data`  — `prod`, then seeded with legacy-shaped rows, then migrated
// and asserts that the dashboard's exact query shape fails on `prod` and succeeds on
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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareMigrations } from "@/server/schema-readiness";

const DSN = process.env.PG_TEST_DSN;
const MIGRATIONS = join(process.cwd(), "prisma", "migrations");

/** Hosts that must never be used for scratch-database creation. */
const FORBIDDEN_DSN = /supabase\.(co|com|in)|pooler|vercel|amazonaws|neon\.tech|azure/i;

const psqlAvailable = spawnSync("psql", ["--version"], { encoding: "utf8" }).status === 0;
const targetIsSafe = !!DSN && !FORBIDDEN_DSN.test(DSN);
const enabled = psqlAvailable && targetIsSafe;

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
 * `psql "<uri>" -d otherdb` discards the URI entirely — including a `?host=` socket
 * directory — so the database is substituted into the URI instead. Both
 * `postgresql://user:pw@host:5432/db` and `postgresql://user@/db?host=/run/pg` work.
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

/** Run psql and return stdout. Throws with stderr attached on failure. */
function psql(database: string, args: string[]): string {
  return execFileSync(
    "psql",
    [withDatabase(DSN as string, database), "-v", "ON_ERROR_STOP=1", "-q", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

/** Run psql, returning `{ ok, stderr }` instead of throwing. */
function psqlFail(database: string, sql: string): { ok: boolean; stderr: string } {
  try {
    psql(database, ["-c", sql]);
    return { ok: true, stderr: "" };
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    return { ok: false, stderr: `${e.stderr ?? ""}${e.message ?? ""}` };
  }
}

function applyMigrations(database: string, names: string[]): void {
  for (const name of names) {
    psql(database, ["-f", join(MIGRATIONS, name, "migration.sql")]);
  }
}

const suffix = `${process.pid}_${Date.now()}`;
const PROD_DB = `xe_replay_prod_${suffix}`;
const FULL_DB = `xe_replay_full_${suffix}`;
const DATA_DB = `xe_replay_data_${suffix}`;

/** The three migrations production had applied before the incident. */
const APPLIED_IN_PRODUCTION = [
  "20261013000000_init",
  "20261014000000_recovery_codes",
  "20261015000000_direct_upload_intents",
];

describe.skipIf(!enabled)("migration replay against a real PostgreSQL", () => {
  beforeAll(() => {
    const all = committedMigrations();
    for (const db of [PROD_DB, FULL_DB, DATA_DB]) {
      psql("postgres", ["-c", `CREATE DATABASE "${db}"`]);
    }
    applyMigrations(PROD_DB, all.filter((name) => APPLIED_IN_PRODUCTION.includes(name)));
    applyMigrations(FULL_DB, all);
    applyMigrations(DATA_DB, all.filter((name) => APPLIED_IN_PRODUCTION.includes(name)));
  });

  afterAll(() => {
    for (const db of [PROD_DB, FULL_DB, DATA_DB]) {
      try {
        psql("postgres", ["-c", `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`]);
      } catch {
        // Best effort: a leftover scratch database must never fail the suite.
      }
    }
  });

  it("applies every committed migration cleanly, in order", () => {
    const expected = committedMigrations();
    expect(expected.length).toBeGreaterThanOrEqual(5);
    const tables = psql(FULL_DB, ["-tAc", "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"]);
    expect(Number(tables.trim())).toBeGreaterThan(0);
  });

  it("reproduces the production failure on the production-state schema", () => {
    const failure = psqlFail(
      PROD_DB,
      'SELECT "t"."pricing_snapshot" FROM "public"."orders" AS "t" LIMIT 0'
    );
    expect(failure.ok).toBe(false);
    // The exact sentence from the production log.
    expect(failure.stderr).toMatch(/pricing_snapshot/);
    expect(failure.stderr).toMatch(/does not exist/i);
  });

  it("reproduces the enum failure the same deploy would hit next", () => {
    const failure = psqlFail(PROD_DB, `SELECT 'DELIVERED'::"OrderStatus"`);
    expect(failure.ok).toBe(false);
    expect(failure.stderr).toMatch(/invalid input value for enum/i);

    const type = psqlFail(PROD_DB, `SELECT 'UPI'::"PaymentMethod"`);
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

    applyMigrations(DATA_DB, committedMigrations().filter((name) => !APPLIED_IN_PRODUCTION.includes(name)));

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

  it("drives the release gate from real recorded history", () => {
    // `npm run preflight:schema` reads `_prisma_migrations` and hands the names to
    // `compareMigrations`. This exercises that decision path against a real history
    // table, so the gate's verdict is validated even where the Prisma *client* cannot
    // be generated (the adapter itself only issues the SELECT asserted here).
    psql(PROD_DB, ["-c", `
      CREATE TABLE "_prisma_migrations" (
        id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz,
        migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
        started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0);
    `]);
    for (const name of APPLIED_IN_PRODUCTION) {
      psql(PROD_DB, ["-c",
        `INSERT INTO "_prisma_migrations" (id,checksum,finished_at,migration_name,started_at,applied_steps_count)
         VALUES (gen_random_uuid()::text,'x',now(),'${name}',now(),1)`]);
    }

    const recorded = rows(
      PROD_DB,
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"
    ).map((r) => r[0]);

    const readiness = compareMigrations(committedMigrations(), recorded);
    expect(readiness.ok).toBe(false);
    expect(readiness.pending).toEqual([
      "20261020000000_order_lifecycle_enum_values",
      "20261020000100_order_lifecycle_payments_pricing",
    ]);
    expect(readiness.unknownApplied).toEqual([]);

    // A rolled-back or unfinished row must not count as applied.
    psql(PROD_DB, ["-c", `UPDATE "_prisma_migrations" SET rolled_back_at = now()`]);
    expect(
      rows(PROD_DB, "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
    ).toEqual([]);
  });

  it("uses the new lifecycle default for orders created after migration", () => {
    psql(FULL_DB, ["-c", `
      INSERT INTO users (id,email,email_norm,name,"passwordHash",role,is_active,created_at,updated_at)
      VALUES ('u-new','n@example.test','n@example.test','N','h','STUDENT',true,now(),now());
      INSERT INTO orders (id,order_number,user_id,paper_size,color_mode,copies,total_pages,billable_pages,
        price_per_page,finishing_fee,total_amount,created_at,updated_at)
      VALUES ('o-new','XE-NEW-1','u-new','A4','BW',1,1,1,2.5,0,2.5,now(),now());
    `]);
    expect(psql(FULL_DB, ["-tAc", "SELECT status::text FROM orders WHERE id='o-new'"]).trim()).toBe("ORDER_RECEIVED");
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
