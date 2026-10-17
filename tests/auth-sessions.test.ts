// Unit tests for the real session/auth primitives in
// src/server/auth.ts — session creation, cookie attributes,
// lookup/expiry/revocation, disabled-account enforcement,
// role guards, password verification and the failed-login
// counter. Mocked Prisma and cookie store; no database.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "crypto";

const TTL_HOURS = 24;

let sessionRows: Array<Record<string, unknown>>;
let userRows: Record<string, Record<string, unknown>>;
let cookieStore: {
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
let currentToken: string | undefined;

async function load() {
  vi.resetModules();

  vi.doMock("@/lib/prisma", () => ({
    prisma: {
      session: {
        async create({ data }: any) {
          const row = { id: `sess-${sessionRows.length + 1}`, ...data };
          sessionRows.push(row);
          return row;
        },
        async findUnique({ where }: any) {
          const row = sessionRows.find((r) => r.tokenHash === where.tokenHash);
          if (!row) return null;
          return { ...row, user: userRows[row.userId as string] ?? null };
        },
        async updateMany({ where, data }: any) {
          let count = 0;
          for (const row of sessionRows) {
            if (row.tokenHash === where.tokenHash) {
              Object.assign(row, data);
              count++;
            }
          }
          return { count };
        },
      },
      user: {
        async updateMany({ where, data }: any) {
          let count = 0;
          const failedGte = (where.failedLoginCount as { gte?: number } | undefined)?.gte;
          for (const [id, row] of Object.entries(userRows)) {
            if (where.id !== id) continue;
            if (failedGte !== undefined && (row.failedLoginCount as number) < failedGte) continue;
            const inc = (data.failedLoginCount as { increment?: number } | undefined)?.increment;
            if (inc !== undefined) row.failedLoginCount = (row.failedLoginCount as number) + inc;
            if (data.lockedUntil !== undefined) row.lockedUntil = data.lockedUntil;
            count++;
          }
          return { count };
        },
        async update({ where, data }: any) {
          const row = userRows[where.id];
          if (!row) throw new Error("record not found");
          const inc = (data.failedLoginCount as { increment?: number } | undefined)
            ?.increment;
          if (inc !== undefined) {
            row.failedLoginCount = (row.failedLoginCount as number) + inc;
          } else if (data.failedLoginCount !== undefined) {
            row.failedLoginCount = data.failedLoginCount;
          }
          if (data.lockedUntil !== undefined) row.lockedUntil = data.lockedUntil;
          return { ...row };
        },
      },
    },
  }));

  vi.doMock("next/headers", () => ({
    cookies: async () => cookieStore,
  }));

  vi.doMock("@/server/env", () => ({
    env: {
      get SESSION_TTL_HOURS() {
        return TTL_HOURS;
      },
    },
  }));

  return import("@/server/auth");
}

beforeEach(() => {
  sessionRows = [];
  userRows = {
    "user-student": {
      id: "user-student",
      email: "student@college.edu",
      name: "Demo Student",
      role: "STUDENT",
      isActive: true,
    },
    "user-admin": {
      id: "user-admin",
      email: "admin@xeroxease.local",
      name: "Admin",
      role: "ADMIN",
      isActive: true,
    },
    "user-disabled": {
      id: "user-disabled",
      email: "disabled@college.edu",
      name: "Disabled",
      role: "STUDENT",
      isActive: false,
    },
  };
  cookieStore = {
    set: vi.fn(),
    get: vi.fn(() => (currentToken ? { value: currentToken } : undefined)),
    delete: vi.fn(),
  };
  currentToken = undefined;
});

const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");

describe("createSession", () => {
  it("stores only the SHA-256 hash of the token and returns the plaintext token", async () => {
    const auth = await load();
    const token = await auth.createSession("user-student", "STUDENT", {
      ip: "203.0.113.9",
      userAgent: "vitest/1.0",
    });

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(sessionRows.length).toBe(1);
    const row = sessionRows[0];
    expect(row.tokenHash).toBe(sha256(token)); // never the raw token
    expect(row.userId).toBe("user-student");
    expect(row.kind).toBe("STUDENT");
    expect(row.ip).toBe("203.0.113.9");
    expect(row.userAgent).toBe("vitest/1.0");
    expect((row.expiresAt as Date).getTime()).toBeCloseTo(
      Date.now() + TTL_HOURS * 3600_000,
      -2
    );
  });

  it("sets a HttpOnly, SameSite=Lax cookie that expires with the session", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const auth = await load();
      const token = await auth.createSession("user-student", "STUDENT");

      expect(cookieStore.set).toHaveBeenCalledTimes(1);
      const [name, value, attrs] = cookieStore.set.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>
      ];
      expect(name).toBe("xe_session");
      expect(value).toBe(token);
      expect(attrs.httpOnly).toBe(true);
      expect(attrs.sameSite).toBe("lax");
      expect(attrs.secure).toBe(true); // HTTPS-only in production
      expect(attrs.path).toBe("/");
      expect(attrs.expires).toBeInstanceOf(Date);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("marks the cookie non-secure outside production (local development over http)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    try {
      const auth = await load();
      await auth.createSession("user-student", "STUDENT");
      const attrs = (cookieStore.set.mock.calls[0] as Array<unknown>)[2] as Record<
        string,
        unknown
      >;
      expect(attrs.secure).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("truncates over-long user agents", async () => {
    const auth = await load();
    await auth.createSession("user-student", "STUDENT", {
      userAgent: "x".repeat(500),
    });
    expect(sessionRows[0].userAgent).toHaveLength(255);
  });
});

describe("getSessionUser", () => {
  it("resolves a valid, unexpired session to its user", async () => {
    const auth = await load();
    const token = await auth.createSession("user-student", "STUDENT");
    currentToken = token;

    const user = await auth.getSessionUser();
    expect(user).toMatchObject({
      id: "user-student",
      email: "student@college.edu",
      role: "STUDENT",
      isActive: true,
    });
    expect(user).not.toHaveProperty("passwordHash");
  });

  it("rejects an unknown token", async () => {
    const auth = await load();
    currentToken = "not-a-real-token";
    expect(await auth.getSessionUser()).toBeNull();
  });

  it("rejects a revoked session", async () => {
    const auth = await load();
    const token = await auth.createSession("user-student", "STUDENT");
    const row = sessionRows[0];
    row.revokedAt = new Date();
    currentToken = token;
    expect(await auth.getSessionUser()).toBeNull();
  });

  it("rejects an expired session", async () => {
    const auth = await load();
    const token = await auth.createSession("user-student", "STUDENT");
    const row = sessionRows[0];
    row.expiresAt = new Date(Date.now() - 1000);
    currentToken = token;
    expect(await auth.getSessionUser()).toBeNull();
  });

  it("rejects sessions of disabled accounts", async () => {
    const auth = await load();
    const token = await auth.createSession("user-disabled", "STUDENT");
    currentToken = token;
    expect(await auth.getSessionUser()).toBeNull();
  });

  it("returns null when no cookie is present", async () => {
    const auth = await load();
    expect(await auth.getSessionUser()).toBeNull();
  });
});

describe("destroySession", () => {
  it("revokes the session server-side and clears the cookie", async () => {
    const auth = await load();
    const token = await auth.createSession("user-student", "STUDENT");
    currentToken = token;

    await auth.destroySession();

    expect(sessionRows[0].revokedAt).toBeInstanceOf(Date);
    expect(cookieStore.delete).toHaveBeenCalledWith("xe_session");
  });
});

describe("isAdminRole", () => {
  it("recognises both admin tiers and nothing else", async () => {
    const auth = await load();
    expect(auth.isAdminRole("ADMIN")).toBe(true);
    expect(auth.isAdminRole("SUPER_ADMIN")).toBe(true);
    expect(auth.isAdminRole("STUDENT")).toBe(false);
    expect(auth.isAdminRole("")).toBe(false);
  });
});

describe("role guards", () => {
  it("requireUser throws a 401-tagged error without a session", async () => {
    const auth = await load();
    await expect(auth.requireUser()).rejects.toMatchObject({ status: 401 });
  });

  it("requireRole admits matching roles and rejects others with 403", async () => {
    const auth = await load();
    const token = await auth.createSession("user-admin", "ADMIN");
    currentToken = token;

    await expect(auth.requireRole("ADMIN", "SUPER_ADMIN")).resolves.toMatchObject({
      role: "ADMIN",
    });

    const studentToken = await auth.createSession("user-student", "STUDENT");
    currentToken = studentToken;
    await expect(auth.requireRole("ADMIN")).rejects.toMatchObject({ status: 403 });
  });

});

describe("password hashing and verification (real argon2/bcrypt)", () => {
  it("hashes with argon2id and verifies round-trip", async () => {
    const auth = await load();
    const { hash, algo } = await auth.hashPassword("Str0ngPass!");
    expect(algo).toBe("argon2id");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await auth.verifyPassword("Str0ngPass!", hash)).toBe(true);
    expect(await auth.verifyPassword("WrongPass1", hash)).toBe(false);
  });

  it("verifies legacy bcrypt hashes without rehashing them", async () => {
    const auth = await load();
    const bcrypt = await import("bcryptjs");
    const legacy = await bcrypt.hash("Str0ngPass!", 12);
    expect(await auth.verifyPassword("Str0ngPass!", legacy)).toBe(true);
    expect(await auth.verifyPassword("wrong", legacy)).toBe(false);
  });

  it("returns false (never throws) for malformed hashes", async () => {
    const auth = await load();
    expect(await auth.verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await auth.verifyPassword("x", "")).toBe(false);
  });
});

describe("recordFailedLogin (atomic lockout counter)", () => {
  it("increments atomically and locks exactly at the threshold", async () => {
    const auth = await load();

    // 7 failures so far: the 8th must increment AND lock.
    userRows["user-student"].failedLoginCount = 7;
    const before = Date.now();
    await auth.recordFailedLogin("user-student", { maxFailed: 8, lockMinutes: 15 });
    expect(userRows["user-student"].failedLoginCount).toBe(8);
    expect(userRows["user-student"].lockedUntil).toBeInstanceOf(Date);
    expect((userRows["user-student"].lockedUntil as Date).getTime()).toBeGreaterThanOrEqual(
      before + 14 * 60_000
    );
  });

  it("keeps incrementing without unlocking when failures continue after expiry", async () => {
    const auth = await load();
    userRows["user-student"].failedLoginCount = 20;
    userRows["user-student"].lockedUntil = null;

    await auth.recordFailedLogin("user-student", { maxFailed: 8, lockMinutes: 15 });
    expect(userRows["user-student"].failedLoginCount).toBe(21);
    expect(userRows["user-student"].lockedUntil).toBeInstanceOf(Date);
  });

  it("increments below-threshold counters without touching lockedUntil", async () => {
    const auth = await load();
    userRows["user-student"].failedLoginCount = 2;
    userRows["user-student"].lockedUntil = null;

    await auth.recordFailedLogin("user-student", { maxFailed: 8, lockMinutes: 15 });
    expect(userRows["user-student"].failedLoginCount).toBe(3);
    expect(userRows["user-student"].lockedUntil).toBeNull();
  });
});
