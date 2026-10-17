// Route-level regression tests for student (/api/auth/login) and
// administrator (/api/auth/admin-login) authentication.
//
// Mocked infrastructure only (in-memory user store, stubbed auth
// helpers, stubbed rate limiter) — no database and no live service.
// These tests pin the HTTP contract: role separation, generic
// failure responses, lockout boundaries, session creation on
// success only, and safe handling of database failures.

import { describe, it, expect, beforeEach, vi } from "vitest";

interface UserRow {
  id: string;
  emailNorm: string;
  regNo: string | null;
  role: "STUDENT" | "ADMIN" | "SUPER_ADMIN";
  isActive: boolean;
  passwordHash: string;
  failedLoginCount: number;
  lockedUntil: Date | null;
}

type LoginState = {
  dbUser: UserRow | null;
  lookupThrows: boolean;
  verifyOk: boolean;
  rateLimitOk: boolean;
  createSessionCalls: Array<[string, string, unknown]>;
  recordFailedCalls: Array<[string, unknown]>;
  userUpdates: Array<Record<string, unknown>>;
};

let state: LoginState;

const STUDENT: UserRow = {
  id: "11111111-1111-4111-8111-111111111111",
  emailNorm: "student@college.edu",
  regNo: "RA2211003010001",
  role: "STUDENT",
  isActive: true,
  passwordHash: "$argon2id$mocked-hash",
  failedLoginCount: 0,
  lockedUntil: null,
};

const ADMIN: UserRow = {
  id: "22222222-2222-4222-8222-222222222222",
  emailNorm: "admin@xeroxease.local",
  regNo: null,
  role: "ADMIN",
  isActive: true,
  passwordHash: "$argon2id$mocked-hash",
  failedLoginCount: 0,
  lockedUntil: null,
};

async function load() {
  vi.resetModules();

  vi.doMock("@/lib/prisma", () => ({
    prisma: {
      user: {
        async findFirst({ where }: any) {
          if (state.lookupThrows) throw new Error("connection refused");
          const identifier = (where.OR as Array<Record<string, string>>)[0].emailNorm;
          if (identifier === state.dbUser?.emailNorm) return { ...state.dbUser };
          // Registration-number lookup branch.
          const regNo = (where.OR as Array<Record<string, string>>)[1].regNo;
          if (regNo && regNo === state.dbUser?.regNo) return { ...state.dbUser };
          return null;
        },
        async findUnique({ where }: any) {
          if (state.lookupThrows) throw new Error("connection refused");
          return state.dbUser && state.dbUser.emailNorm === where.emailNorm
            ? { ...state.dbUser }
            : null;
        },
        async update({ where, data }: any) {
          state.userUpdates.push({ where, data });
          return { ...state.dbUser, ...data };
        },
      },
      session: {
        // Session rows are only created through the (mocked) auth
        // helper; a direct create here would mean the route built
        // a session outside createSession.
        create: vi.fn(async () => {
          throw new Error("routes must create sessions via createSession");
        }),
      },
    },
  }));

  vi.doMock("@/server/auth", () => ({
    verifyPassword: vi.fn(async () => state.verifyOk),
    createSession: vi.fn(async (...args: [string, string, unknown]) => {
      state.createSessionCalls.push(args);
      return "session-token";
    }),
    recordFailedLogin: vi.fn(async (...args: [string, unknown]) => {
      state.recordFailedCalls.push(args);
    }),
    hashPassword: vi.fn(async () => ({ hash: "hash", algo: "argon2id" })),
    getSessionUser: vi.fn(async () => null),
    requireUser: vi.fn(async () => {
      throw Object.assign(new Error("UNAUTHENTICATED"), { status: 401 });
    }),
    requireRole: vi.fn(async () => {
      throw Object.assign(new Error("FORBIDDEN"), { status: 403 });
    }),
  }));

  vi.doMock("@/server/rate-limit", () => ({
    RATE_LIMITS: {
      login: { limit: 10, windowMs: 5 * 60_000 },
      register: { limit: 5, windowMs: 60 * 60_000 },
    },
    rateLimitAsync: vi.fn(async () =>
      state.rateLimitOk
        ? { ok: true, remaining: 9, retryAfterSec: 0 }
        : { ok: false, remaining: 0, retryAfterSec: 42 }
    ),
  }));

  vi.doMock("@/server/audit", () => ({
    audit: vi.fn(async () => undefined),
  }));

  const login = await import("@/app/api/auth/login/route");
  const adminLogin = await import("@/app/api/auth/admin-login/route");
  return { login, adminLogin };
}

beforeEach(() => {
  state = {
    dbUser: { ...STUDENT },
    lookupThrows: false,
    verifyOk: false,
    rateLimitOk: true,
    createSessionCalls: [],
    recordFailedCalls: [],
    userUpdates: [],
  };
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://app.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.9",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function body(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("student login — /api/auth/login", () => {
  it("creates a STUDENT session for valid credentials and resets lockout counters", async () => {
    const { login } = await load();
    state.dbUser = { ...STUDENT };
    state.verifyOk = true;

    const res = await login.POST(
      post("/api/auth/login", { identifier: "student@college.edu", password: "correct horse" })
    );

    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true, role: "STUDENT" });
    expect(state.createSessionCalls.length).toBe(1);
    expect(state.createSessionCalls[0][0]).toBe(STUDENT.id);
    expect(state.createSessionCalls[0][1]).toBe("STUDENT");
    // Success clears the failure counter and any stale lock.
    expect(state.userUpdates).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ failedLoginCount: 0, lockedUntil: null }),
      })
    );
    expect(state.recordFailedCalls).toEqual([]);
  });

  it("accepts the registration number as an identifier", async () => {
    const { login } = await load();
    state.dbUser = { ...STUDENT };
    state.verifyOk = true;

    const res = await login.POST(
      post("/api/auth/login", { identifier: "ra2211003010001", password: "correct horse" })
    );
    expect(res.status).toBe(200);
    expect(state.createSessionCalls.length).toBe(1);
  });

  it("rejects wrong credentials generically, without creating a session", async () => {
    const { login } = await load();
    state.dbUser = { ...STUDENT, failedLoginCount: 3 };
    state.verifyOk = false;

    const res = await login.POST(
      post("/api/auth/login", { identifier: "student@college.edu", password: "wrong" })
    );

    expect(res.status).toBe(401);
    expect(await body(res)).toEqual({ error: "Invalid credentials." });
    expect(state.createSessionCalls).toEqual([]);
    // No Set-Cookie header may accompany a failed login.
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(state.recordFailedCalls.length).toBe(1);
    expect(state.recordFailedCalls[0][0]).toBe(STUDENT.id);
  });

  it("rejects unknown identifiers with the same generic response", async () => {
    const { login } = await load();
    state.dbUser = null;

    const res = await login.POST(
      post("/api/auth/login", { identifier: "nobody@college.edu", password: "x" })
    );
    expect(res.status).toBe(401);
    expect(await body(res)).toEqual({ error: "Invalid credentials." });
    expect(state.createSessionCalls).toEqual([]);
  });

  it("rejects administrator credentials at the student endpoint (role separation)", async () => {
    const { login } = await load();
    state.dbUser = { ...ADMIN };
    state.verifyOk = true; // even a correct password must not authenticate

    const res = await login.POST(
      post("/api/auth/login", { identifier: "admin@xeroxease.local", password: "correct horse" })
    );

    expect(res.status).toBe(401);
    expect(await body(res)).toEqual({ error: "Invalid credentials." });
    expect(state.createSessionCalls).toEqual([]);
    expect(state.recordFailedCalls).toEqual([]);
  });

  it("reports disabled accounts distinctly but still without a session", async () => {
    const { login } = await load();
    state.dbUser = { ...STUDENT, isActive: false };
    state.verifyOk = true;

    const res = await login.POST(
      post("/api/auth/login", { identifier: "student@college.edu", password: "correct horse" })
    );
    expect(res.status).toBe(403);
    expect(state.createSessionCalls).toEqual([]);
  });

  it("refuses locked accounts with 429 before any password work", async () => {
    const { login } = await load();
    state.dbUser = {
      ...STUDENT,
      failedLoginCount: 8,
      lockedUntil: new Date(Date.now() + 60_000),
    };
    state.verifyOk = true;

    const res = await login.POST(
      post("/api/auth/login", { identifier: "student@college.edu", password: "correct horse" })
    );
    expect(res.status).toBe(429);
    expect(await body(res)).toMatchObject({ error: expect.stringContaining("locked") });
    expect(state.createSessionCalls).toEqual([]);
  });

  it("lets a locked-in account retry once the lock has expired", async () => {
    const { login } = await load();
    state.dbUser = {
      ...STUDENT,
      failedLoginCount: 8,
      lockedUntil: new Date(Date.now() - 1_000), // expired
    };
    state.verifyOk = true;

    const res = await login.POST(
      post("/api/auth/login", { identifier: "student@college.edu", password: "correct horse" })
    );
    expect(res.status).toBe(200);
    expect(state.createSessionCalls.length).toBe(1);
  });

  it("turns a database failure into a generic 500, never a session", async () => {
    const { login } = await load();
    state.lookupThrows = true;

    const res = await login.POST(
      post("/api/auth/login", { identifier: "student@college.edu", password: "x" })
    );
    expect(res.status).toBe(500);
    expect(await body(res)).toEqual({ error: "Something went wrong. Please try again.", code: "INTERNAL_ERROR" });
    expect(state.createSessionCalls).toEqual([]);
  });

  it("returns 429 with Retry-After when the IP rate limit is exceeded", async () => {
    const { login } = await load();
    state.rateLimitOk = false;

    const res = await login.POST(
      post("/api/auth/login", { identifier: "student@college.edu", password: "x" })
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(await body(res)).toMatchObject({ error: expect.stringContaining("Too many requests") });
  });

  it("rejects malformed JSON with 400", async () => {
    const { login } = await load();
    const res = await login.POST(
      new Request("https://app.test/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("rejects invalid input with 422", async () => {
    const { login } = await load();
    const res = await login.POST(post("/api/auth/login", { identifier: "ab", password: "" }));
    expect(res.status).toBe(422);
    expect(state.createSessionCalls).toEqual([]);
  });
});

describe("administrator login — /api/auth/admin-login", () => {
  it("creates an ADMIN session for valid credentials and resets counters", async () => {
    const { adminLogin } = await load();
    state.dbUser = { ...ADMIN };
    state.verifyOk = true;

    const res = await adminLogin.POST(
      post("/api/auth/admin-login", { email: "admin@xeroxease.local", password: "correct horse" })
    );

    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true, role: "ADMIN" });
    expect(state.createSessionCalls.length).toBe(1);
    expect(state.createSessionCalls[0][1]).toBe("ADMIN");
    expect(state.userUpdates).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ failedLoginCount: 0, lockedUntil: null }),
      })
    );
  });

  it("accepts SUPER_ADMIN credentials", async () => {
    const { adminLogin } = await load();
    state.dbUser = { ...ADMIN, role: "SUPER_ADMIN" };
    state.verifyOk = true;

    const res = await adminLogin.POST(
      post("/api/auth/admin-login", { email: "admin@xeroxease.local", password: "correct horse" })
    );
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true, role: "SUPER_ADMIN" });
  });

  it("rejects student credentials at the admin endpoint (role separation)", async () => {
    const { adminLogin } = await load();
    state.dbUser = { ...STUDENT };
    state.verifyOk = true;

    const res = await adminLogin.POST(
      post("/api/auth/admin-login", { email: "student@college.edu", password: "correct horse" })
    );

    expect(res.status).toBe(401);
    expect(await body(res)).toEqual({ error: "Invalid credentials." });
    expect(state.createSessionCalls).toEqual([]);
    expect(state.recordFailedCalls).toEqual([]);
  });

  it("rejects wrong passwords generically without a session", async () => {
    const { adminLogin } = await load();
    state.dbUser = { ...ADMIN };
    state.verifyOk = false;

    const res = await adminLogin.POST(
      post("/api/auth/admin-login", { email: "admin@xeroxease.local", password: "wrong" })
    );
    expect(res.status).toBe(401);
    expect(await body(res)).toEqual({ error: "Invalid credentials." });
    expect(state.createSessionCalls).toEqual([]);
    expect(state.recordFailedCalls.length).toBe(1);
  });

  it("answers disabled admin accounts with the same generic credential failure", async () => {
    const { adminLogin } = await load();
    state.dbUser = { ...ADMIN, isActive: false };
    state.verifyOk = true;

    const res = await adminLogin.POST(
      post("/api/auth/admin-login", { email: "admin@xeroxease.local", password: "correct horse" })
    );
    // Deliberately identical to the unknown-credential response:
    // a disabled account must not be enumerable through this route.
    expect(res.status).toBe(401);
    expect(await body(res)).toEqual({ error: "Invalid credentials." });
    expect(state.createSessionCalls).toEqual([]);
  });

  it("refuses locked admin accounts with 429", async () => {
    const { adminLogin } = await load();
    state.dbUser = {
      ...ADMIN,
      failedLoginCount: 5,
      lockedUntil: new Date(Date.now() + 60_000),
    };

    const res = await adminLogin.POST(
      post("/api/auth/admin-login", { email: "admin@xeroxease.local", password: "x" })
    );
    expect(res.status).toBe(429);
    expect(state.createSessionCalls).toEqual([]);
  });

  it("rejects unknown emails generically", async () => {
    const { adminLogin } = await load();
    state.dbUser = null;

    const res = await adminLogin.POST(
      post("/api/auth/admin-login", { email: "nope@xeroxease.local", password: "x" })
    );
    expect(res.status).toBe(401);
    expect(await body(res)).toEqual({ error: "Invalid credentials." });
  });

  it("returns 429 with Retry-After when rate limited", async () => {
    const { adminLogin } = await load();
    state.rateLimitOk = false;

    const res = await adminLogin.POST(
      post("/api/auth/admin-login", { email: "admin@xeroxease.local", password: "x" })
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
  });

  it("rejects malformed JSON with 400 and invalid input with 422", async () => {
    const { adminLogin } = await load();

    const badJson = await adminLogin.POST(
      new Request("https://app.test/api/auth/admin-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      })
    );
    expect(badJson.status).toBe(400);

    const invalid = await adminLogin.POST(
      post("/api/auth/admin-login", { email: "not-an-email", password: "x" })
    );
    expect(invalid.status).toBe(422);
  });
});
