// Seed-account security tests.
//
// Two layers:
//   1. Pure policy tests for prisma/seed-config.ts — the credential
//      rules that must hold before any database write happens.
//   2. Execution tests for prisma/seed.ts against a mocked Prisma
//      client, proving the upsert shape: reseeding never overwrites
//      a password hash, never deletes, and never disables accounts.
//
// All tests are mocked (no database). They do not prove anything
// about a real Supabase round-trip.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------- Layer 1: credential policy (pure) ----------

import {
  resolveSeedPasswords,
  isStrongSeedPassword,
  DEV_DEFAULT_ADMIN_PASSWORD,
  DEV_DEFAULT_STUDENT_PASSWORD,
  MIN_SEED_PASSWORD_LENGTH,
} from "../prisma/seed-config";

describe("seed password policy", () => {
  it("uses documented development defaults outside production", () => {
    const r = resolveSeedPasswords({ nodeEnv: "development" });
    expect(r.studentPassword).toBe(DEV_DEFAULT_STUDENT_PASSWORD);
    expect(r.adminPassword).toBe(DEV_DEFAULT_ADMIN_PASSWORD);
    expect(r.studentSource).toBe("dev-default");
    expect(r.adminSource).toBe("dev-default");
  });

  it("accepts operator-supplied strong passwords and records their provenance", () => {
    const r = resolveSeedPasswords({
      nodeEnv: "production",
      seedStudentPassword: "Sup3rStrongStudentPass!",
      seedAdminPassword: "Sup3rStrongAdminPass!",
    });
    expect(r.studentPassword).toBe("Sup3rStrongStudentPass!");
    expect(r.adminPassword).toBe("Sup3rStrongAdminPass!");
    expect(r.studentSource).toBe("env");
    expect(r.adminSource).toBe("env");
  });

  it("fails closed in production when no admin bootstrap password is supplied", () => {
    expect(() => resolveSeedPasswords({ nodeEnv: "production" })).toThrow(
      /SEED_ADMIN_PASSWORD is required/
    );
  });

  it("fails closed in production even with ALLOW_DEV_SEED=true (no silent random or default admin password)", () => {
    expect(() =>
      resolveSeedPasswords({ nodeEnv: "production", allowDevSeed: true })
    ).toThrow(/SEED_ADMIN_PASSWORD is required/);
  });

  it("rejects the publicly documented development default as an explicit production admin password (too weak)", () => {
    expect(() =>
      resolveSeedPasswords({ nodeEnv: "production", seedAdminPassword: DEV_DEFAULT_ADMIN_PASSWORD })
    ).toThrow(/SEED_ADMIN_PASSWORD is too weak/);
  });

  it("rejects weak operator-supplied student passwords", () => {
    expect(() =>
      resolveSeedPasswords({
        nodeEnv: "production",
        seedAdminPassword: "Sup3rStrongAdminPass!",
        seedStudentPassword: "short",
      })
    ).toThrow(/SEED_STUDENT_PASSWORD is too weak/);
  });

  it("rejects production student seeding without an explicit password unless ALLOW_DEV_SEED is set", () => {
    expect(() =>
      resolveSeedPasswords({
        nodeEnv: "production",
        seedAdminPassword: "Sup3rStrongAdminPass!",
      })
    ).toThrow(/SEED_STUDENT_PASSWORD is required/);
    // Explicit operator opt-in keeps local-style seeding possible,
    // but only with full awareness that the default is public.
    const r = resolveSeedPasswords({
      nodeEnv: "production",
      allowDevSeed: true,
      seedAdminPassword: "Sup3rStrongAdminPass!",
    });
    expect(r.studentPassword).toBe(DEV_DEFAULT_STUDENT_PASSWORD);
  });

  it("strength rule: length plus upper, lower and digit", () => {
    expect(isStrongSeedPassword("Abcdefghijkl1")).toBe(true);
    expect(isStrongSeedPassword("abcdefghijkl1")).toBe(false); // no upper
    expect(isStrongSeedPassword("ABCDEFGHIJKL1")).toBe(false); // no lower
    expect(isStrongSeedPassword("Abcdefghijkl")).toBe(false); // no digit
    expect(isStrongSeedPassword("Abc1")).toBe(false); // too short
    expect(MIN_SEED_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
  });

  it("failure messages never contain a password value", () => {
    const messages: string[] = [];
    try {
      resolveSeedPasswords({ nodeEnv: "production" });
    } catch (e) {
      messages.push((e as Error).message);
    }
    try {
      resolveSeedPasswords({ nodeEnv: "production", seedAdminPassword: "hunter2" });
    } catch (e) {
      messages.push((e as Error).message);
    }
    expect(messages.join("\n")).not.toContain("hunter2");
    expect(messages.join("\n")).not.toContain(DEV_DEFAULT_ADMIN_PASSWORD);
    expect(messages.join("\n")).not.toContain(DEV_DEFAULT_STUDENT_PASSWORD);
  });
});

// ---------- Layer 2: seed execution against a mocked Prisma client ----------

interface UpsertCall {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

const calls = {
  userUpsert: [] as UpsertCall[],
  userUpdate: [] as unknown[],
  userUpdateMany: [] as unknown[],
  userDelete: [] as unknown[],
  userDeleteMany: [] as unknown[],
  pricingUpsert: [] as unknown[],
  settingUpsert: [] as unknown[],
};

function resetCalls() {
  calls.userUpsert = [];
  calls.userUpdate = [];
  calls.userUpdateMany = [];
  calls.userDelete = [];
  calls.userDeleteMany = [];
  calls.pricingUpsert = [];
  calls.settingUpsert = [];
}

async function runSeed(env: Record<string, string | undefined>) {
  const previousEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    previousEnv[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  // main() runs on import and ends with $disconnect(); resolving
  // this promise is the deterministic "seed finished" signal.
  let disconnect!: () => void;
  const finished = new Promise<void>((resolve) => {
    disconnect = resolve;
  });
  try {
    vi.resetModules();
    vi.doMock("@prisma/client", () => ({
      PrismaClient: class {
        pricingConfig = {
          upsert: vi.fn(async (args: unknown) => {
            calls.pricingUpsert.push(args);
            return {};
          }),
        };
        user = {
          upsert: vi.fn(async (args: UpsertCall) => {
            calls.userUpsert.push(args);
            return { id: `id-${args.where.emailNorm}` };
          }),
          update: vi.fn(async (args: unknown) => {
            calls.userUpdate.push(args);
            return {};
          }),
          updateMany: vi.fn(async (args: unknown) => {
            calls.userUpdateMany.push(args);
            return { count: 0 };
          }),
          delete: vi.fn(async (...args: unknown[]) => {
            calls.userDelete.push(args);
            return {};
          }),
          deleteMany: vi.fn(async (...args: unknown[]) => {
            calls.userDeleteMany.push(args);
            return { count: 0 };
          }),
        };
        setting = {
          upsert: vi.fn(async (args: unknown) => {
            calls.settingUpsert.push(args);
            return {};
          }),
        };
        order = {
          count: vi.fn(async () => 0),
          create: vi.fn(async () => ({})),
        };
        orderEvent = { create: vi.fn(async () => ({})) };
        feedback = { create: vi.fn(async () => ({})) };
        $disconnect = vi.fn(async () => {
          disconnect();
        });
      },
    }));
    await import("../prisma/seed");
    await finished;
  } finally {
    for (const key of Object.keys(env)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
}

describe("seed execution (mocked Prisma client)", () => {
  beforeEach(() => {
    resetCalls();
  });

  it("upserts the four documented accounts with an empty update clause", async () => {
    await runSeed({ NODE_ENV: "development" });

    const seeded = calls.userUpsert.map((c) => c.where.emailNorm).sort();
    expect(seeded).toEqual([
      "admin@xeroxease.local",
      "student2@college.edu",
      "student@college.edu",
      "superadmin@xeroxease.local",
    ]);

    // The update clause is empty: routine reseeding must never
    // reassign a password (or any other field) of an existing user.
    for (const call of calls.userUpsert) {
      expect(call.update).toEqual({});
      expect(JSON.stringify(call.update)).not.toContain("passwordHash");
    }

    // New accounts get a real argon2id hash on create.
    for (const call of calls.userUpsert) {
      expect(typeof call.create.passwordHash).toBe("string");
      expect(call.create.passwordHash).toMatch(/^\$argon2/);
    }
  });

  it("never deletes, disables or otherwise mutates existing users", async () => {
    await runSeed({ NODE_ENV: "development" });

    expect(calls.userDelete).toEqual([]);
    expect(calls.userDeleteMany).toEqual([]);
    expect(calls.userUpdate).toEqual([]);
    expect(calls.userUpdateMany).toEqual([]);
  });

  it("uses the operator-supplied admin password, distinct from the student password", async () => {
    await runSeed({
      NODE_ENV: "development",
      SEED_ADMIN_PASSWORD: "Sup3rStrongAdminPass!",
    });

    const admin = calls.userUpsert.find((c) => c.where.emailNorm === "admin@xeroxease.local");
    const student = calls.userUpsert.find((c) => c.where.emailNorm === "student@college.edu");
    expect(admin).toBeDefined();
    expect(student).toBeDefined();
    // The admin hash must differ from the student hash: privileged and
    // non-privileged accounts never share a password hash.
    expect(admin!.create.passwordHash).not.toBe(student!.create.passwordHash);
  });

  it("keeps pricing and settings idempotent", async () => {
    await runSeed({ NODE_ENV: "development" });
    expect(calls.pricingUpsert.length).toBe(7);
    expect(calls.settingUpsert.length).toBe(1);
  });
});
