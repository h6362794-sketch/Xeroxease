// Database connection-string diagnostics.
//
// Pure unit tests — no database, no network. They pin the sanitised
// parsing and the fail-fast/fail-loud behaviour that guards against
// the `prepared statement "..." does not exist` (SQLSTATE 26000)
// class of pooler misconfiguration.

import { describe, it, expect } from "vitest";
import {
  parseDatabaseUrl,
  diagnoseDatabaseConfig,
  assertDatabaseConfig,
} from "@/server/db-config";

const DIRECT =
  "postgresql://postgres:secret-password@db.abc123.supabase.co:5432/postgres";
const POOLED =
  "postgresql://postgres:secret-password@aws-01-abc.pooler.supabase.com:6543/postgres";

describe("parseDatabaseUrl", () => {
  it("extracts sanitised facts without exposing credentials", () => {
    const result = parseDatabaseUrl(DIRECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info.protocol).toBe("postgresql");
    expect(result.info.host).toBe("db.abc123.supabase.co");
    expect(result.info.port).toBe(5432);
    expect(result.info.database).toBe("postgres");
    expect(result.info.hasUsername).toBe(true);
    expect(result.info.hasPassword).toBe(true);
    expect(result.info.pgbouncer).toBe(false);
    expect(result.info.connectionLimit).toBeNull();
    // The serialised form must never round-trip the secret.
    expect(JSON.stringify(result.info)).not.toContain("secret-password");
  });

  it("detects pgbouncer and connection_limit parameters", () => {
    const result = parseDatabaseUrl(
      "postgresql://u:p@h.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info.pgbouncer).toBe(true);
    expect(result.info.connectionLimit).toBe(1);
    expect(result.info.sslMode).toBe("require");
    // Parameter names are preserved so operators can see what is set.
    expect(result.info.paramKeys).toEqual(["connection_limit", "pgbouncer", "sslmode"]);
  });

  it("keeps pre-existing parameters intact when none are modified", () => {
    const result = parseDatabaseUrl(`${DIRECT}?sslmode=verify-full&foo=bar`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info.paramKeys).toEqual(["foo", "sslmode"]);
  });

  it("rejects unparseable URLs", () => {
    const result = parseDatabaseUrl("not a url at all");
    expect(result.ok).toBe(false);
  });

  it("rejects non-PostgreSQL schemes", () => {
    const result = parseDatabaseUrl("mysql://u:p@h:3306/db");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not postgresql");
  });
});

describe("diagnoseDatabaseConfig", () => {
  it("passes a direct connection with no findings", () => {
    const d = diagnoseDatabaseConfig({ databaseUrl: DIRECT, directUrl: DIRECT });
    expect(d.errors).toEqual([]);
    expect(d.warnings).toEqual([]);
  });

  it("fails closed when DATABASE_URL is missing", () => {
    const d = diagnoseDatabaseConfig({ databaseUrl: "", directUrl: DIRECT });
    expect(d.errors.length).toBeGreaterThan(0);
    expect(d.errors[0]).toContain("DATABASE_URL");
    // Never echoes a (nonexistent) value or anything sensitive.
    expect(JSON.stringify(d)).not.toContain("postgres");
  });

  it("fails closed on placeholder credentials copied from .env.example", () => {
    const d = diagnoseDatabaseConfig({
      databaseUrl: "postgresql://postgres:YOUR_PASSWORD@db.X.supabase.co:5432/postgres",
      directUrl: DIRECT,
    });
    expect(d.errors.some((e) => e.includes("placeholder"))).toBe(true);
  });

  it("detects placeholders regardless of casing (regression: the old check-env matched case-insensitively)", () => {
    const mixedCase = [
      "your_password",
      "Your_Password",
      "your_project_ref",
      "Your_Project_Ref",
      "changeme",
      "ChangeMe",
      "replace_me",
      "Replace_Me",
    ];
    for (const password of mixedCase) {
      const d = diagnoseDatabaseConfig({
        databaseUrl: `postgresql://postgres:${password}@db.X.supabase.co:5432/postgres`,
        directUrl: DIRECT,
      });
      expect(d.errors.some((e) => e.includes("placeholder"))).toBe(true);
    }
  });

  it("accepts real credentials that merely resemble placeholders, including URL-encoded ones", () => {
    // None of these contain a marker even when case-folded: digits,
    // different words, and percent-encoding must all pass through.
    const realPasswords = ["yourPass123", "y0ur_p4ssw0rd", "p%40ssw0rd%3A1", "Chang3Me!2026"];
    for (const password of realPasswords) {
      const d = diagnoseDatabaseConfig({
        databaseUrl: `postgresql://postgres:${password}@db.X.supabase.co:5432/postgres`,
        directUrl: DIRECT,
      });
      expect(d.errors).toEqual([]);
    }
  });

  it("warns on the transaction-mode pooler without pgbouncer=true", () => {
    const d = diagnoseDatabaseConfig({ databaseUrl: POOLED, directUrl: DIRECT });
    expect(d.errors).toEqual([]);
    const warn = d.warnings.join("\n");
    expect(warn).toContain("transaction-mode pooler");
    expect(warn).toContain("SQLSTATE 26000");
  });

  it("warns that pgbouncer=true is unnecessary (and harmful) on modern poolers", () => {
    const d = diagnoseDatabaseConfig({
      databaseUrl: `${POOLED}?pgbouncer=true`,
      directUrl: DIRECT,
    });
    const warn = d.warnings.join("\n");
    expect(warn).toContain("PGBOUNCER_");
    expect(warn).toContain("remove it");
  });

  it("warns that connection_limit=1 serialises the singleton client", () => {
    const d = diagnoseDatabaseConfig({
      databaseUrl: `${DIRECT}?connection_limit=1`,
      directUrl: DIRECT,
    });
    expect(d.warnings.some((w) => w.includes("connection_limit=1"))).toBe(true);
  });

  it("warns when DIRECT_URL is missing", () => {
    const d = diagnoseDatabaseConfig({ databaseUrl: DIRECT });
    expect(d.warnings.some((w) => w.includes("DIRECT_URL"))).toBe(true);
  });

  it("warns when DIRECT_URL points at the transaction-mode pooler", () => {
    const d = diagnoseDatabaseConfig({ databaseUrl: DIRECT, directUrl: POOLED });
    expect(d.warnings.some((w) => w.includes("DIRECT_URL") && w.includes("advisory locks"))).toBe(true);
  });

  it("warns when DIRECT_URL carries pgbouncer=true", () => {
    const d = diagnoseDatabaseConfig({
      databaseUrl: DIRECT,
      directUrl: `${DIRECT}?pgbouncer=true`,
    });
    expect(d.warnings.some((w) => w.includes("DIRECT_URL") && w.includes("pgbouncer=true"))).toBe(true);
  });

  it("never leaks the password in errors or warnings", () => {
    const d = diagnoseDatabaseConfig({
      databaseUrl: "postgresql://u:hunter2@db.x.supabase.co:6543/postgres",
      directUrl: "postgresql://u:hunter2@db.x.supabase.co:5432/postgres",
    });
    expect(JSON.stringify(d)).not.toContain("hunter2");
  });
});

describe("assertDatabaseConfig", () => {
  it("does not throw for a valid configuration", () => {
    expect(() =>
      assertDatabaseConfig({ databaseUrl: DIRECT, directUrl: DIRECT })
    ).not.toThrow();
  });

  it("throws an actionable, sanitised error for invalid configuration", () => {
    expect(() => assertDatabaseConfig({ databaseUrl: "  " })).toThrow(
      /DATABASE_URL is not set/
    );
    expect(() => assertDatabaseConfig({ databaseUrl: "garbage" })).toThrow(
      /DATABASE_URL is invalid/
    );
  });
});
