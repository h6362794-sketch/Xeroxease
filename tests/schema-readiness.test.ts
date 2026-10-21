// Regression coverage for the deploy-time schema-readiness gate.
//
// `npm run schema:check` compares schema.prisma with the committed SQL, and CI replays
// migrations against a throwaway database. Neither inspects the database a deploy will
// use, and Vercel's build never runs `prisma migrate deploy`. The 2026-10-20 incident is
// therefore reproducible as a pure comparison: the repository had five migrations, the
// production database had applied the first three.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareMigrations,
  formatReadinessReport,
  normaliseMigrationNames,
} from "@/server/schema-readiness";

/** The migration set actually committed in this repository. */
function committed(): string[] {
  return readdirSync(join(process.cwd(), "prisma", "migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * What `_prisma_migrations` reported in the production database on 2026-10-20:
 * init, recovery codes and direct-upload intents only. The two order-lifecycle
 * migrations introduced by PR #13 were never applied.
 */
const PRODUCTION_APPLIED_2026_10_20 = [
  "20261013000000_init",
  "20261014000000_recovery_codes",
  "20261015000000_direct_upload_intents",
];

describe("the 2026-10-20 production state", () => {
  it("is reported as NOT ready, naming exactly the two unapplied migrations", () => {
    const readiness = compareMigrations(committed(), PRODUCTION_APPLIED_2026_10_20);

    expect(readiness.ok).toBe(false);
    expect(readiness.pending).toEqual([
      "20261020000000_order_lifecycle_enum_values",
      "20261020000100_order_lifecycle_payments_pricing",
    ]);
    expect(readiness.unknownApplied).toEqual([]);
  });

  it("prints those names and nothing that could leak a connection string", () => {
    const report = formatReadinessReport(
      compareMigrations(committed(), PRODUCTION_APPLIED_2026_10_20),
      committed().length
    );

    expect(report).toContain("Schema readiness FAILED");
    expect(report).toContain("20261020000100_order_lifecycle_payments_pricing");
    // Never a URL, host, database, user or password.
    expect(report).not.toMatch(/postgres(ql)?:\/\//i);
    expect(report).not.toContain("@");
    expect(report).not.toContain("5432");
    expect(report).not.toContain("6543");
  });

  it("passes once both migrations are applied", () => {
    const applied = [...PRODUCTION_APPLIED_2026_10_20, ...committed().slice(3)];
    const readiness = compareMigrations(committed(), applied);
    expect(readiness).toEqual({ ok: true, pending: [], unknownApplied: [] });
    expect(formatReadinessReport(readiness, committed().length)).toContain("Schema readiness OK");
  });
});

describe("compareMigrations", () => {
  it("is order-insensitive", () => {
    const a = compareMigrations(["a", "b", "c"], ["c", "a", "b"]);
    expect(a).toEqual({ ok: true, pending: [], unknownApplied: [] });
  });

  it("lists every pending migration, in committed order", () => {
    const result = compareMigrations(["a", "b", "c", "d"], ["a", "c"]);
    expect(result.ok).toBe(false);
    expect(result.pending).toEqual(["b", "d"]);
  });

  it("treats an empty database as fully pending, not as ready", () => {
    const result = compareMigrations(["a", "b"], []);
    expect(result.ok).toBe(false);
    expect(result.pending).toEqual(["a", "b"]);
  });

  it("fails when the database has migrations this checkout does not contain", () => {
    // Deploying older code onto a newer schema is its own hazard, and silently
    // reporting "ready" would hide a wrong-database mistake.
    const result = compareMigrations(["a", "b"], ["a", "b", "z_future"]);
    expect(result.ok).toBe(false);
    expect(result.unknownApplied).toEqual(["z_future"]);
    expect(formatReadinessReport(result, 2)).toContain("wrong database");
  });

  it("fails when both directions drift at once", () => {
    const result = compareMigrations(["a", "b"], ["a", "x"]);
    expect(result.ok).toBe(false);
    expect(result.pending).toEqual(["b"]);
    expect(result.unknownApplied).toEqual(["x"]);
  });

  it("is defensive about duplicates, blanks and non-strings", () => {
    const messy = ["a", " a ", "", "  ", "b", "a"] as unknown as string[];
    expect(normaliseMigrationNames(messy)).toEqual(["a", "b"]);
    const result = compareMigrations(messy, ["a", "b", "b"]);
    expect(result.ok).toBe(true);
  });

  it("does not treat a repeated application as new work", () => {
    const result = compareMigrations(["a"], ["a", "a"]);
    expect(result.ok).toBe(true);
  });
});
