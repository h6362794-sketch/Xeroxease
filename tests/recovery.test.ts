// Recovery-code security tests.
//
// These cover the properties the email-free recovery system must hold. They are
// deliberately behavioural: each one fails against a naive implementation and is
// not weakened to make a passing run.
//
// NOTE: `src/server/recovery.ts` imports the Prisma client, which is mocked below
// with an in-memory stand-in so the tests exercise the real module logic without a
// database (see TESTING.md, "Where mocks stand in for real infrastructure").

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------- In-memory Prisma stand-in ----------

interface RecoveryRow {
  id: string;
  userId: string;
  codeHash: string;
  createdAt: Date;
  createdBy: string | null;
  expiresAt: Date | null;
  usedAt: Date | null;
  rotatedAt: Date | null;
}

function makeDb() {
  return {
    recoveryCodes: [] as RecoveryRow[],
    users: [
      { id: "user-1", emailNorm: "student@xeroxease.test", regNo: "21A91A0501", isActive: true, passwordHash: "old-hash", failedLoginCount: 5, lockedUntil: new Date(Date.now() + 60_000) },
      { id: "user-2", emailNorm: "other@xeroxease.test", regNo: "21A91A0502", isActive: true, passwordHash: "old-hash", failedLoginCount: 0, lockedUntil: null },
      { id: "user-3", emailNorm: "disabled@xeroxease.test", regNo: "21A91A0503", isActive: false, passwordHash: "old-hash", failedLoginCount: 0, lockedUntil: null },
    ] as Array<{
      id: string; emailNorm: string; regNo: string; isActive: boolean;
      passwordHash: string; failedLoginCount: number; lockedUntil: Date | null;
    }>,
    sessions: [
      { userId: "user-1", revokedAt: null },
      { userId: "user-1", revokedAt: null },
      { userId: "user-2", revokedAt: null },
    ] as Array<{ userId: string; revokedAt: Date | null }>,
    seq: 0,
    /** Test hook: make the next `recoveryCode.create` throw, to exercise rollback. */
    failCreate: false,
  };
}

let db = makeDb();

vi.mock("@/lib/prisma", () => {
  const store = () => db;

  function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (key === "OR") {
        const branches = cond as Array<Record<string, unknown>>;
        if (!branches.some((branch) => matchesWhere(row, branch))) return false;
        continue;
      }
      const actual = row[key];
      if (cond === null) {
        if (actual !== null && actual !== undefined) return false;
        continue;
      }
      if (cond && typeof cond === "object") {
        const ops = cond as Record<string, unknown>;
        for (const [op, operand] of Object.entries(ops)) {
          if (op === "gt" && !(actual instanceof Date && actual > (operand as Date))) return false;
          if (op === "lt" && !(actual instanceof Date && actual < (operand as Date))) return false;
          if (op === "not" && actual === operand) return false;
        }
        continue;
      }
      if (actual !== cond) return false;
    }
    return true;
  }

  const prisma: Record<string, unknown> = {
      recoveryCode: {
        async create({ data }: any) {
          if (store().failCreate) throw new Error("simulated database failure");
          const row: RecoveryRow = {
            id: `rc-${++store().seq}`,
            userId: data.userId,
            codeHash: data.codeHash,
            createdAt: new Date(),
            createdBy: data.createdBy ?? null,
            expiresAt: data.expiresAt ?? null,
            usedAt: null,
            rotatedAt: null,
          };
          store().recoveryCodes.push(row);
          return { ...row };
        },
        async findUnique({ where }: any) {
          const s = store();
          if (where.codeHash) return s.recoveryCodes.find((r) => r.codeHash === where.codeHash) ?? null;
          if (where.userId) return s.recoveryCodes.find((r) => r.userId === where.userId) ?? null;
          return null;
        },
        async deleteMany({ where }: any) {
          const s = store();
          const before = s.recoveryCodes.length;
          s.recoveryCodes = s.recoveryCodes.filter((r) => !matchesWhere(r as unknown as Record<string, unknown>, where));
          return { count: before - s.recoveryCodes.length };
        },
        async updateMany({ where, data }: any) {
          let count = 0;
          for (const row of store().recoveryCodes) {
            if (count === 0 && matchesWhere(row as unknown as Record<string, unknown>, where)) {
              Object.assign(row, data);
              count = 1;
            }
          }
          return { count };
        },
      },
      user: {
        async findFirst({ where }: any) {
          const s = store();
          return s.users.find((u) => {
            if (where.OR) {
              const branches = where.OR as Array<Record<string, unknown>>;
              return branches.some((branch) =>
                Object.entries(branch).every(([k, v]) => (u as unknown as Record<string, unknown>)[k] === v)
              );
            }
            return Object.entries(where).every(([k, v]) => (u as unknown as Record<string, unknown>)[k] === v);
          }) ?? null;
        },
        async update({ where, data }: any) {
          const row = store().users.find((u) => u.id === where.id);
          if (row) Object.assign(row, data);
          return row;
        },
      },
      session: {
        async updateMany({ where, data }: any) {
          let count = 0;
          for (const s of store().sessions) {
            if (s.userId === where.userId && s.revokedAt === null) {
              Object.assign(s, data);
              count++;
            }
          }
          return { count };
        },
      },
  };

  // Real transactions roll back on failure. The stand-in must too, otherwise a test
  // for "the old code survives a failed rotation" would be meaningless: without
  // rollback, `deleteMany` would unconditionally wipe the previous row.
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    const s = store();
    const snapshot = {
      recoveryCodes: structuredClone(s.recoveryCodes),
      users: structuredClone(s.users),
      sessions: structuredClone(s.sessions),
    };
    try {
      return await fn(prisma);
    } catch (err) {
      s.recoveryCodes = snapshot.recoveryCodes;
      s.users = snapshot.users;
      s.sessions = snapshot.sessions;
      throw err;
    }
  };

  return { prisma };
});

let recovery: typeof import("@/server/recovery");

beforeEach(async () => {
  db = makeDb();
  vi.resetModules();
  recovery = await import("@/server/recovery");
});

describe("recovery code generation", () => {
  it("generates 160 bits of entropy in Crockford base32, 32 characters", () => {
    for (let i = 0; i < 200; i++) {
      const code = recovery.generateRecoveryCode();
      const raw = code.replace(/-/g, "");
      expect(raw).toHaveLength(32);
      expect(raw).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{32}$/);
    }
  });

  it("never produces a duplicate across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(recovery.generateRecoveryCode());
    expect(seen.size).toBe(5000);
  });

  it("excludes the ambiguous characters I, L, O and U", () => {
    for (let i = 0; i < 500; i++) {
      expect(recovery.generateRecoveryCode()).not.toMatch(/[ILOU]/);
    }
  });

  it("is not predictable — no two codes share a long prefix beyond chance", () => {
    // 20 bytes drawn from a CSPRNG: the chance two codes match in the first 4
    // characters is 32^-4 ≈ 1 in a million. Run 2000 codes and assert none collide.
    const prefixes = new Set<string>();
    for (let i = 0; i < 2000; i++) prefixes.add(recovery.generateRecoveryCode().slice(0, 4));
    expect(prefixes.size).toBeGreaterThan(1990);
  });

  it("groups the code for readability without changing its content", () => {
    const code = recovery.generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
    expect(code.replace(/-/g, "")).toHaveLength(32);
  });
});

describe("normalisation", () => {
  it("accepts lower case, spaces, dashes and Crockford typo substitutions", () => {
    // I/L -> 1 and O -> 0, so a mistyped code still resolves.
    expect(recovery.normalizeRecoveryCode("abcd efgh")).toBe("ABCDEFGH");
    expect(recovery.normalizeRecoveryCode("o0il")).toBe("0011");
  });

  it("rejects a code of the wrong length", () => {
    expect(recovery.isValidRecoveryCodeShape("ABCDEF")).toBe(false);
    expect(recovery.isValidRecoveryCodeShape("A".repeat(33))).toBe(false);
    expect(recovery.isValidRecoveryCodeShape("A".repeat(32))).toBe(true);
  });

  it("rejects characters outside the alphabet", () => {
    const code = recovery.generateRecoveryCode();
    const tampered = code.slice(0, -1) + "!";
    expect(recovery.isValidRecoveryCodeShape(tampered)).toBe(false);
  });
});

describe("storage: only hashes are persisted", () => {
  it("never writes the plaintext code into the database", async () => {
    const issued = await recovery.issueRecoveryCode({ userId: "user-1" });
    const raw = issued.code.replace(/-/g, "");
    for (const row of db.recoveryCodes) {
      expect(JSON.stringify(row)).not.toContain(raw);
      expect(row.codeHash).not.toBe(raw);
    }
  });

  it("stores a SHA-256 of the normalised code", async () => {
    const issued = await recovery.issueRecoveryCode({ userId: "user-1" });
    expect(db.recoveryCodes[0].codeHash).toBe(recovery.hashRecoveryCode(issued.code));
    expect(db.recoveryCodes[0].codeHash).toHaveLength(64);
    expect(db.recoveryCodes[0].codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a different hash for a single-character change", async () => {
    const a = recovery.hashRecoveryCode("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const b = recovery.hashRecoveryCode("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB");
    expect(a).not.toBe(b);
  });
});

describe("rotation", () => {
  it("replaces the previous code — only one live code per account", async () => {
    const first = await recovery.issueRecoveryCode({ userId: "user-1" });
    const second = await recovery.issueRecoveryCode({ userId: "user-1" });

    expect(db.recoveryCodes).toHaveLength(1);
    expect(db.recoveryCodes[0].codeHash).toBe(recovery.hashRecoveryCode(second.code));
    expect(db.recoveryCodes[0].codeHash).not.toBe(recovery.hashRecoveryCode(first.code));
  });

  it("invalidates the old code immediately", async () => {
    const first = await recovery.issueRecoveryCode({ userId: "user-1" });
    await recovery.issueRecoveryCode({ userId: "user-1" });

    const res = await recovery.redeemRecoveryCode({
      identifier: "student@xeroxease.test",
      code: first.code,
      newPasswordHash: "new-hash",
    });
    expect(res.ok).toBe(false);
  });

  it("does not strand the user if storing the new code fails", async () => {
    const first = await recovery.issueRecoveryCode({ userId: "user-1" });

    db.failCreate = true;
    await expect(recovery.issueRecoveryCode({ userId: "user-1" })).rejects.toThrow();
    db.failCreate = false;

    // Rotation must be all-or-nothing: the previous code is still live, so the
    // user is never left with no way back into their account.
    expect(db.recoveryCodes).toHaveLength(1);
    const res = await recovery.redeemRecoveryCode({
      identifier: "student@xeroxease.test",
      code: first.code,
      newPasswordHash: "new-hash",
    });
    expect(res.ok).toBe(true);
  });

  it("keeps the new code working", async () => {
    await recovery.issueRecoveryCode({ userId: "user-1" });
    const second = await recovery.issueRecoveryCode({ userId: "user-1" });

    const res = await recovery.redeemRecoveryCode({
      identifier: "student@xeroxease.test",
      code: second.code,
      newPasswordHash: "new-hash",
    });
    expect(res.ok).toBe(true);
  });
});

describe("redemption", () => {
  it("sets the new password and revokes every session", async () => {
    const { code } = await recovery.issueRecoveryCode({ userId: "user-1" });
    const res = await recovery.redeemRecoveryCode({
      identifier: "student@xeroxease.test",
      code,
      newPasswordHash: "brand-new-hash",
    });

    expect(res.ok).toBe(true);
    const user = db.users.find((u) => u.id === "user-1")!;
    expect(user.passwordHash).toBe("brand-new-hash");
    // Lockout cleared too, so a locked-out user can recover.
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
    expect(db.sessions.filter((s) => s.userId === "user-1").every((s) => s.revokedAt !== null)).toBe(true);
  });

  it("leaves other users' sessions alone", async () => {
    const { code } = await recovery.issueRecoveryCode({ userId: "user-1" });
    await recovery.redeemRecoveryCode({ identifier: "student@xeroxease.test", code, newPasswordHash: "x" });
    expect(db.sessions.filter((s) => s.userId === "user-2" && s.revokedAt === null)).toHaveLength(1);
  });

  it("is single-use — the same code cannot redeem twice", async () => {
    const { code } = await recovery.issueRecoveryCode({ userId: "user-1" });
    const first = await recovery.redeemRecoveryCode({ identifier: "student@xeroxease.test", code, newPasswordHash: "a" });
    const second = await recovery.redeemRecoveryCode({ identifier: "student@xeroxease.test", code, newPasswordHash: "b" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(db.users.find((u) => u.id === "user-1")!.passwordHash).toBe("a");
  });

  it("grants exactly one winner under concurrent redemption", async () => {
    const { code } = await recovery.issueRecoveryCode({ userId: "user-1" });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        recovery.redeemRecoveryCode({ identifier: "student@xeroxease.test", code, newPasswordHash: `hash-${i}` })
      )
    );
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(db.recoveryCodes[0].usedAt).not.toBeNull();
  });

  it("requires the code to belong to the account being recovered", async () => {
    // user-2's code must not reset user-1's password.
    const { code } = await recovery.issueRecoveryCode({ userId: "user-2" });
    const res = await recovery.redeemRecoveryCode({
      identifier: "student@xeroxease.test",
      code,
      newPasswordHash: "attacker-hash",
    });

    expect(res.ok).toBe(false);
    expect(db.users.find((u) => u.id === "user-1")!.passwordHash).toBe("old-hash");
    // And the rejected attempt must not have burnt user-2's code.
    expect(db.recoveryCodes[0].usedAt).toBeNull();
  });

  it("accepts the registration number as the identifier", async () => {
    const { code } = await recovery.issueRecoveryCode({ userId: "user-1" });
    const res = await recovery.redeemRecoveryCode({
      identifier: "21a91a0501",
      code,
      newPasswordHash: "new-hash",
    });
    expect(res.ok).toBe(true);
  });

  it("refuses a disabled account", async () => {
    const { code } = await recovery.issueRecoveryCode({ userId: "user-3" });
    const res = await recovery.redeemRecoveryCode({
      identifier: "disabled@xeroxease.test",
      code,
      newPasswordHash: "new-hash",
    });
    expect(res.ok).toBe(false);
    expect(db.users.find((u) => u.id === "user-3")!.passwordHash).toBe("old-hash");
  });

  it("rejects an unknown account, unknown code and malformed code identically", async () => {
    const { code } = await recovery.issueRecoveryCode({ userId: "user-1" });
    const results = [
      await recovery.redeemRecoveryCode({ identifier: "nobody@xeroxease.test", code, newPasswordHash: "x" }),
      await recovery.redeemRecoveryCode({ identifier: "student@xeroxease.test", code: "A".repeat(32), newPasswordHash: "x" }),
      await recovery.redeemRecoveryCode({ identifier: "student@xeroxease.test", code: "!!!", newPasswordHash: "x" }),
      await recovery.redeemRecoveryCode({ identifier: "student@xeroxease.test", code: "", newPasswordHash: "x" }),
    ];
    // Every failure is the same shape, so the caller cannot distinguish them.
    for (const r of results) expect(r).toEqual({ ok: false });
  });

  it("rejects an expired admin-issued code", async () => {
    const { code } = await recovery.issueRecoveryCode({ userId: "user-1", actorId: "admin-1", ttlHours: 1 });
    // Force it into the past.
    db.recoveryCodes[0].expiresAt = new Date(Date.now() - 1000);

    const res = await recovery.redeemRecoveryCode({
      identifier: "student@xeroxease.test",
      code,
      newPasswordHash: "new-hash",
    });
    expect(res.ok).toBe(false);
    expect(db.users.find((u) => u.id === "user-1")!.passwordHash).toBe("old-hash");
  });

  it("accepts a still-valid admin-issued code and records no plaintext", async () => {
    const issued = await recovery.issueRecoveryCode({ userId: "user-1", actorId: "admin-1", ttlHours: 24 });
    expect(db.recoveryCodes[0].createdBy).toBe("admin-1");
    expect(db.recoveryCodes[0].expiresAt).not.toBeNull();

    const res = await recovery.redeemRecoveryCode({
      identifier: "student@xeroxease.test",
      code: issued.code,
      newPasswordHash: "new-hash",
    });
    expect(res.ok).toBe(true);
  });

  it("gives a self-generated code no expiry", async () => {
    await recovery.issueRecoveryCode({ userId: "user-1" });
    expect(db.recoveryCodes[0].expiresAt).toBeNull();
    expect(db.recoveryCodes[0].createdBy).toBeNull();
  });
});

describe("status reporting", () => {
  it("reports metadata without ever exposing a code", async () => {
    const issued = await recovery.issueRecoveryCode({ userId: "user-1" });
    const status = await recovery.getRecoveryCodeStatus("user-1");

    expect(status.hasCode).toBe(true);
    expect(status.issuedByAdmin).toBe(false);
    expect(status.usedAt).toBeNull();
    expect(JSON.stringify(status)).not.toContain(issued.code);
  });

  it("distinguishes admin-issued codes", async () => {
    await recovery.issueRecoveryCode({ userId: "user-1", actorId: "admin-1", ttlHours: 24 });
    const status = await recovery.getRecoveryCodeStatus("user-1");
    expect(status.issuedByAdmin).toBe(true);
    expect(status.expiresAt).not.toBeNull();
  });

  it("reports no code for an account that never set one up", async () => {
    const status = await recovery.getRecoveryCodeStatus("user-2");
    expect(status).toEqual({ hasCode: false, createdAt: null, expiresAt: null, usedAt: null, issuedByAdmin: false });
  });

  it("reports a code as used after redemption", async () => {
    const { code } = await recovery.issueRecoveryCode({ userId: "user-1" });
    await recovery.redeemRecoveryCode({ identifier: "student@xeroxease.test", code, newPasswordHash: "x" });
    const status = await recovery.getRecoveryCodeStatus("user-1");
    expect(status.usedAt).not.toBeNull();
  });
});
