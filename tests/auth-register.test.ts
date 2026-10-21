// Route-level regression tests for registration — /api/auth/register.
//
// Mocked infrastructure only (in-memory user store, stubbed hashing
// and audit). No database, no live service. Pins: validation
// contract, duplicate handling (preflight AND the unique-constraint
// race), client-role immunity, the 5/hour rate limit boundary, and
// the fact that registration never creates a session.

import { describe, it, expect, beforeEach, vi } from "vitest";

interface UserRow {
  emailNorm: string;
  phone: string | null;
  regNo: string | null;
}

type RegisterState = {
  existing: UserRow | null;
  lookupThrows: boolean;
  createThrows: unknown;
  hashCalls: string[];
  createCalls: Array<Record<string, unknown>>;
  auditCalls: unknown[];
};

let state: RegisterState;

const VALID = {
  name: "Aarav Sharma",
  email: "aarav@college.edu",
  phone: "9876543210",
  regNo: "RA2211003010009",
  branch: "CSE",
  section: "A",
  year: 3,
  password: "Str0ngPass!",
  confirmPassword: "Str0ngPass!",
};

async function load() {
  vi.resetModules();

  vi.doMock("@/lib/prisma", () => ({
    prisma: {
      user: {
        async findFirst() {
          if (state.lookupThrows) throw new Error("connection refused");
          return state.existing ? { ...state.existing } : null;
        },
        async create({ data }: any) {
          if (state.createThrows) throw state.createThrows;
          state.createCalls.push(data);
          return { id: "new-user-id" };
        },
      },
    },
  }));

  vi.doMock("@/server/auth", () => ({
    hashPassword: vi.fn(async (plain: string) => {
      state.hashCalls.push(plain);
      return { hash: `$argon2id$mocked-${plain.length}`, algo: "argon2id" as const };
    }),
    createSession: vi.fn(async () => {
      throw new Error("registration must not create a session");
    }),
    verifyPassword: vi.fn(async () => false),
    recordFailedLogin: vi.fn(async () => undefined),
  }));

  vi.doMock("@/server/audit", () => ({
    audit: vi.fn(async (entry: unknown) => {
      state.auditCalls.push(entry);
    }),
  }));

  // Real rate limiter (fresh module registry per load, so the
  // in-memory store starts empty): the 5/hour boundary is exercised
  // against the actual accounting logic.
  return import("@/app/api/auth/register/route");
}

beforeEach(() => {
  state = {
    existing: null,
    lookupThrows: false,
    createThrows: null,
    hashCalls: [],
    createCalls: [],
    auditCalls: [],
  };
});

function post(body: unknown) {
  return new Request("https://app.test/api/auth/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.9",
    },
    body: JSON.stringify(body),
  });
}

async function body(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("registration — happy path", () => {
  it("creates a STUDENT account with normalised identifiers and no session", async () => {
    const { POST } = await load();

    const res = await POST(post({ ...VALID, email: "AARAV@College.EDU", regNo: "ra2211003010009" }));

    expect(res.status).toBe(201);
    expect(await body(res)).toEqual({ ok: true });
    expect(state.createCalls.length).toBe(1);
    const created = state.createCalls[0];
    expect(created).toMatchObject({
      emailNorm: "aarav@college.edu",
      regNo: "RA2211003010009",
      phone: "9876543210",
      role: "STUDENT",
    });
    // The plaintext password reaches the hasher and nothing else.
    expect(state.hashCalls).toEqual([VALID.password]);
    expect(state.auditCalls.length).toBe(1);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("strips spaces and dashes from the phone number", async () => {
    const { POST } = await load();
    const res = await POST(post({ ...VALID, phone: "98765 432 10" }));
    expect(res.status).toBe(201);
    expect(state.createCalls[0].phone).toBe("9876543210");
  });

  it("ignores any client-supplied role", async () => {
    const { POST } = await load();
    const res = await POST(post({ ...VALID, role: "SUPER_ADMIN" } as never));
    expect(res.status).toBe(201);
    expect(state.createCalls[0].role).toBe("STUDENT");
  });
});

describe("registration — duplicates", () => {
  it("maps a preflight email collision to 409", async () => {
    const { POST } = await load();
    state.existing = { emailNorm: "aarav@college.edu", phone: null, regNo: null };
    const res = await POST(post(VALID));
    expect(res.status).toBe(409);
    expect(await body(res)).toEqual({ error: "An account with this email already exists." });
  });

  it("maps a preflight phone collision to 409", async () => {
    const { POST } = await load();
    state.existing = { emailNorm: "other@college.edu", phone: "9876543210", regNo: null };
    const res = await POST(post(VALID));
    expect(res.status).toBe(409);
    expect(await body(res)).toEqual({ error: "An account with this phone number already exists." });
  });

  it("maps a preflight registration-number collision to 409", async () => {
    const { POST } = await load();
    state.existing = { emailNorm: "other@college.edu", phone: null, regNo: "RA2211003010009" };
    const res = await POST(post(VALID));
    expect(res.status).toBe(409);
    expect(await body(res)).toEqual({
      error: "An account with this registration number already exists.",
    });
  });

  it("converts a P2002 unique violation on the insert (the preflight/create race) into the same 409, not a 500", async () => {
    const { POST } = await load();
    state.existing = null; // preflight passes
    state.createThrows = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { modelName: "User", target: ["email_norm"] },
    });

    const res = await POST(post(VALID));
    expect(res.status).toBe(409);
    expect(await body(res)).toEqual({ error: "An account with this email already exists." });
  });

  it("maps P2002 on phone and reg_no to their field-specific conflict messages", async () => {
    const mod = await load();

    state.createThrows = Object.assign(new Error("u"), {
      code: "P2002",
      meta: { target: ["phone"] },
    });
    const phoneRes = await mod.POST(post(VALID));
    expect(phoneRes.status).toBe(409);
    expect(await body(phoneRes)).toEqual({ error: "An account with this phone number already exists." });

    state.createThrows = Object.assign(new Error("u"), {
      code: "P2002",
      meta: { target: ["reg_no"] },
    });
    const regRes = await mod.POST(post(VALID));
    expect(regRes.status).toBe(409);
    expect(await body(regRes)).toEqual({
      error: "An account with this registration number already exists.",
    });
  });

  it("answers an unknown P2002 target with a safe generic conflict", async () => {
    const { POST } = await load();
    state.createThrows = Object.assign(new Error("u"), {
      code: "P2002",
      meta: { target: ["something_unexpected"] },
    });
    const res = await POST(post(VALID));
    expect(res.status).toBe(409);
    const text = JSON.stringify(await body(res));
    expect(text).not.toContain("P2002");
    expect(text).not.toContain("something_unexpected");
    expect(text).toContain("already exists");
  });

  it("still fails closed (generic 500) on non-constraint database errors", async () => {
    const { POST } = await load();
    state.createThrows = new Error("connection refused");
    const res = await POST(post(VALID));
    expect(res.status).toBe(500);
    expect(await body(res)).toMatchObject({ error: "Something went wrong. Please try again.", code: "INTERNAL_ERROR" });
  });

  it("does not leak database internals on a lookup failure", async () => {
    const { POST } = await load();
    state.lookupThrows = true;
    const res = await POST(post(VALID));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await body(res))).not.toContain("connection refused");
  });
});

describe("registration — validation", () => {
  it.each([
    ["missing name", { ...VALID, name: "" }],
    ["invalid email", { ...VALID, email: "not-an-email" }],
    ["short password", { ...VALID, password: "Ab1!", confirmPassword: "Ab1!" }],
    ["password without digit", { ...VALID, password: "Abcdefgh!", confirmPassword: "Abcdefgh!" }],
    ["mismatched confirmation", { ...VALID, confirmPassword: "Str0ngPass2" }],
    ["year out of range", { ...VALID, year: 9 }],
    ["missing regNo", { ...VALID, regNo: "ab" }],
    ["invalid phone", { ...VALID, phone: "123" }],
  ])("rejects %s with 422", async (_label, payload) => {
    const { POST } = await load();
    const res = await POST(post(payload));
    expect(res.status).toBe(422);
    expect(state.createCalls).toEqual([]);
  });

  it("rejects malformed JSON with 400", async () => {
    const { POST } = await load();
    const res = await POST(
      new Request("https://app.test/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("registration — rate limit (real in-memory limiter)", () => {
  it("allows exactly 5 registrations per IP per hour, then 429 with Retry-After", async () => {
    const { POST } = await load();

    for (let i = 0; i < 5; i++) {
      const res = await POST(post({ ...VALID, email: `user${i}@college.edu` }));
      expect(res.status).toBe(201);
    }

    const limited = await POST(post({ ...VALID, email: "sixth@college.edu" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(await body(limited)).toMatchObject({
      error: expect.stringContaining("Too many requests"),
    });
  });
});
