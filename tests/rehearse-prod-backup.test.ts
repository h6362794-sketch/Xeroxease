import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertLoopbackOnlyTarget,
  assertOutsideRepository,
  redactSecrets,
  validateProductionDirectUrl,
} from "../scripts/rehearse-prod-backup";

describe("rehearse-prod-backup preflight guards & secret safety", () => {
  it("accepts valid Session Pooler port 5432 URLs including special password characters", () => {
    const parsed = validateProductionDirectUrl(
      "postgresql://postgres.vjwvvoczyuebtowbnuqf:p%40ss%23w0rd!@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require"
    );
    expect(parsed.hostname).toBe("aws-0-ap-northeast-1.pooler.supabase.com");
    expect(parsed.port).toBe("5432");
  });

  it("rejects port 6543 Transaction Pooler URLs with clear Session Pooler guidance", () => {
    expect(() =>
      validateProductionDirectUrl(
        "postgresql://postgres.ref:secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?sslmode=require"
      )
    ).toThrow(/port 5432/i);
  });

  it("rejects DIRECT_URL values with ?pgbouncer=true enabled", () => {
    expect(() =>
      validateProductionDirectUrl(
        "postgresql://postgres.ref:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?pgbouncer=true&sslmode=require"
      )
    ).toThrow(/pgbouncer=true/i);
  });

  it("enforces strict loopback lock on rehearsal write targets", () => {
    expect(() =>
      assertLoopbackOnlyTarget("postgresql://postgres:pw@127.0.0.1:55417/xe_rehearsal?sslmode=disable")
    ).not.toThrow();
    expect(() =>
      assertLoopbackOnlyTarget("postgresql://postgres:pw@localhost:5432/xe_rehearsal")
    ).not.toThrow();
    expect(() =>
      assertLoopbackOnlyTarget(
        "postgresql://postgres.ref:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"
      )
    ).toThrow(/SAFETY LOCK/i);
    expect(() =>
      assertLoopbackOnlyTarget("postgresql://127.0.0.1:5432/postgres?host=db.example.supabase.co")
    ).toThrow(/SAFETY LOCK/i);
  });

  it("refuses backup target paths inside the repository root", () => {
    expect(() =>
      assertOutsideRepository(path.join(process.cwd(), "backups", "unsafe"), process.cwd())
    ).toThrow(/outside the Git repository/i);
  });

  it("redacts connection strings, bearer headers, JWTs, and explicit secret values", () => {
    const raw =
      "Error connecting to postgresql://postgres.ref:MySuperSecret!@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres with Authorization: Bearer sb_secret_123456789 and raw=MySuperSecret!";
    const cleaned = redactSecrets(raw, ["MySuperSecret!"]);
    expect(cleaned).not.toContain("MySuperSecret!");
    expect(cleaned).not.toContain("sb_secret_123456789");
    expect(cleaned).not.toContain("aws-0-ap-northeast-1.pooler.supabase.com");
    expect(cleaned).toContain("postgresql://[REDACTED]");
  });
});
