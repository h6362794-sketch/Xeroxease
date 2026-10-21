// Enum ↔ migration drift guard.
//
// WHY THIS TEST EXISTS
// `scripts/verify-migrations.ts` compares tables, columns, indexes and unique
// constraints, and says so in its header: it "cannot verify types, precision, defaults,
// nullability, constraint names, foreign keys or **enums**". So nothing caught the
// 2026-10-20 defect, where `src/lib/order-status.ts` and `prisma/schema.prisma`
// declared five new `OrderStatus` labels while the production database had applied only
// the three original migrations.
//
// The failure this prevents is specific and was observed: the dashboard filtered with
// `TERMINAL_STATUSES`, which contains `DELIVERED` and `REJECTED`. Prisma binds those as
// enum parameters, and a database without the labels rejects the query with
// PostgreSQL 22P02 (`invalid input value for enum "OrderStatus"`). Even before that,
// the same deploy's `SELECT *` shape failed with 42703/P2022 on `pricing_snapshot`.
//
// These are static text checks. They do not replay SQL, prove the *deployed* database
// has the migrations, or authorise running anything — that is
// `npm run preflight:schema` against an approved target.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANCELLABLE_STATUSES,
  ORDER_STATUS_VALUES,
  PAYMENT_ELIGIBLE_ORDER_STATUSES,
  STUDENT_STAGES,
  TERMINAL_STATUSES,
} from "@/lib/order-status";

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const SCHEMA = join(process.cwd(), "prisma", "schema.prisma");

/** Strip `--` line comments so prose cannot be mistaken for DDL. */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function migrationSql(dir: string): string {
  return stripSqlComments(readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf8"));
}

function allMigrationDirNames(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Every enum label the given migration SQL would leave in the database.
 *
 * Handles both idioms the repository uses: `CREATE TYPE ... AS ENUM (...)` and the
 * additive `ALTER TYPE ... ADD VALUE IF NOT EXISTS 'X'` used to append lifecycle values
 * without rewriting historical rows.
 */
function enumLabelsFrom(sqlTexts: string[]): Map<string, Set<string>> {
  const enums = new Map<string, Set<string>>();
  const ensure = (name: string): Set<string> => {
    const existing = enums.get(name);
    if (existing) return existing;
    const created = new Set<string>();
    enums.set(name, created);
    return created;
  };

  for (const sql of sqlTexts) {
    for (const match of sql.matchAll(/CREATE TYPE\s+"(\w+)"\s+AS ENUM\s*\(([\s\S]*?)\);/g)) {
      const labels = ensure(match[1]);
      for (const label of match[2].matchAll(/'([^']+)'/g)) labels.add(label[1]);
    }
    for (const match of sql.matchAll(
      /ALTER TYPE\s+"(\w+)"\s+ADD VALUE\s+(?:IF NOT EXISTS\s+)?'([^']+)'/g
    )) {
      ensure(match[1]).add(match[2]);
    }
  }

  return enums;
}

/** Enums declared in prisma/schema.prisma, comments removed. */
function schemaEnums(): Map<string, Set<string>> {
  const source = readFileSync(SCHEMA, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  const enums = new Map<string, Set<string>>();
  for (const match of source.matchAll(/enum\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const labels = new Set<string>();
    for (const raw of match[2].split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("@@")) continue;
      const label = line.match(/^([A-Z][A-Z0-9_]*)$/);
      if (label) labels.add(label[1]);
    }
    enums.set(match[1], labels);
  }
  return enums;
}

const committed = allMigrationDirNames();
const migratedEnums = enumLabelsFrom(committed.map(migrationSql));
const expectedEnums = schemaEnums();

describe("every enum value the application schema declares is created by a migration", () => {
  it("has at least one enum to check (guards against a vacuous parse)", () => {
    expect(expectedEnums.size).toBeGreaterThanOrEqual(8);
    expect(expectedEnums.get("OrderStatus")?.size).toBe(17);
  });

  it("creates every enum type and every label", () => {
    const missing: string[] = [];
    for (const [name, labels] of expectedEnums) {
      const migrated = migratedEnums.get(name);
      if (!migrated) {
        missing.push(`${name} (type never created)`);
        continue;
      }
      for (const label of labels) {
        if (!migrated.has(label)) missing.push(`${name}.${label}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("creates the PaymentMethod type with both documented values", () => {
    expect([...(migratedEnums.get("PaymentMethod") ?? [])].sort()).toEqual([
      "CASH_ON_DELIVERY",
      "UPI",
    ]);
  });
});

describe("every status the application filters on is a migrated OrderStatus label", () => {
  // This is the direct regression guard for the dashboard break: `TERMINAL_STATUSES`
  // is interpolated into `prisma.order.findFirst({ where: { status: { notIn: ... } } })`,
  // so every member must exist in the database enum or that query fails with 22P02.
  const runtimeStatusSets: Array<[string, readonly string[]]> = [
    ["TERMINAL_STATUSES", TERMINAL_STATUSES],
    ["CANCELLABLE_STATUSES", CANCELLABLE_STATUSES],
    ["PAYMENT_ELIGIBLE_ORDER_STATUSES", PAYMENT_ELIGIBLE_ORDER_STATUSES],
    ["ORDER_STATUS_VALUES", ORDER_STATUS_VALUES],
    ...STUDENT_STAGES.map((stage): [string, readonly string[]] => [
      `STUDENT_STAGES.${stage.key}`,
      stage.statuses,
    ]),
  ];

  it.each(runtimeStatusSets)("%s is fully migrated", (_name, statuses) => {
    const migrated = migratedEnums.get("OrderStatus");
    expect(migrated).toBeDefined();
    const unmigrated = statuses.filter((status) => !migrated!.has(status));
    expect(unmigrated).toEqual([]);
  });

  it("covers the two labels whose absence broke the dashboard", () => {
    const migrated = migratedEnums.get("OrderStatus")!;
    for (const label of ["DELIVERED", "REJECTED"]) {
      expect(TERMINAL_STATUSES as readonly string[]).toContain(label);
      expect(migrated.has(label)).toBe(true);
    }
  });
});

describe("the guard is not vacuous — it fails on the pre-fix baseline", () => {
  it("reports the new labels as missing when only the init migration is applied", () => {
    // Exactly the production database state on 2026-10-20: init, recovery codes and
    // direct-upload intents; none of the order-lifecycle migrations.
    const baseline = committed.filter((dir) => dir < "20261020000000");
    expect(baseline.length).toBeGreaterThan(0);

    const baselineEnums = enumLabelsFrom(baseline.map(migrationSql));
    const orderStatus = baselineEnums.get("OrderStatus")!;

    // The runtime filter that crashed the dashboard.
    expect([...TERMINAL_STATUSES].filter((label) => !orderStatus.has(label))).toEqual([
      "DELIVERED",
      "REJECTED",
    ]);
    // And the type this deploy introduced.
    expect(baselineEnums.has("PaymentMethod")).toBe(false);
  });
});
