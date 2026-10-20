// Real login handler + password verifier + session cookie primitives + dashboard
// Server Component. Only persistence, rate limiter and audit are test doubles.
import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { hashSync } from "bcryptjs";
const state = vi.hoisted(() => ({
  token: undefined as string | undefined,
  session: null as any,
  cookieOptions: {} as Record<string, unknown>,
  schemaDrift: false,
  orders: [] as any[],
  user: {} as any,
}));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: () => state.token ? { value: state.token } : undefined,
  set: (_name: string, value: string, options: Record<string, unknown>) => { state.token = value; state.cookieOptions = options; },
}) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  user: { findFirst: async () => state.user, update: async () => state.user },
  session: {
    create: async ({ data }: any) => { state.session = data; return data; },
    findUnique: async ({ where }: any) => state.session?.tokenHash === where.tokenHash ? { ...state.session, user: state.user } : null,
  },
  order: {
    findFirst: async () => {
      if (state.schemaDrift) throw Object.assign(new Error("orders.pricing_snapshot does not exist"), { code: "P2022" });
      return state.orders[0] ?? null;
    },
    findMany: async () => state.orders,
    aggregate: async () => ({ _count: state.orders.length, _sum: { totalAmount: null } }),
  },
} }));
vi.mock("@/server/rate-limit", () => ({ RATE_LIMITS: { login: {} }, rateLimitAsync: async () => ({ ok: true }) }));
vi.mock("@/server/audit", () => ({ audit: async () => {} }));
vi.mock("@/server/recovery", () => ({ getRecoveryCodeStatus: async () => ({ hasCode: false, usedAt: null }) }));
import { POST } from "@/app/api/auth/login/route";
import DashboardPage from "@/app/(student)/dashboard/page";
import { getSessionUser } from "@/server/auth";
function login() {
  return POST(new Request("https://app.test/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: "student@example.test", password: "correct-password" }) }));
}
beforeEach(() => {
  state.cookieOptions = {};
  state.token = undefined; state.session = null; state.schemaDrift = false; state.orders = [];
  state.user = { id: "student-1", name: "Test Student", email: "student@example.test", role: "STUDENT", isActive: true, failedLoginCount: 0, passwordHash: hashSync("correct-password", 4) };
});
it("returns success, establishes a hashed session, then renders the empty dashboard", async () => {
  expect((await login()).status).toBe(200);
  expect(state.token).toBeTruthy();
  expect(state.session.tokenHash).not.toBe(state.token);
  expect(await getSessionUser()).toMatchObject({ id: "student-1", role: "STUDENT" });
  expect(state.cookieOptions).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  expect(state.cookieOptions.expires).toBeInstanceOf(Date);
  const html = renderToStaticMarkup(await DashboardPage());
  expect(html).toContain("No active orders");
  expect(html).toContain("No orders yet.");
});
it("reproduces successful login followed by a schema-drift dashboard failure", async () => {
  state.schemaDrift = true;
  expect((await login()).status).toBe(200);
  await expect(DashboardPage()).rejects.toMatchObject({ code: "P2022" });
});
it("redirects an expired session instead of treating it as a query failure", async () => {
  await login(); state.session.expiresAt = new Date(0);
  await expect(DashboardPage()).rejects.toThrow("REDIRECT:/login");
});
it("rejects an admin at the student login endpoint without creating a cookie", async () => {
  state.user.role = "ADMIN";
  expect((await login()).status).toBe(401);
  expect(state.token).toBeUndefined();
});
