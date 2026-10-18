import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * Access-control matrix for the REST surface. Authorization is enforced per handler, not
 * by a central router, so a new route that forgets its guard would be silently open.
 *
 * These checks read each route module and examine EACH HTTP METHOD HANDLER separately:
 *  - the guard must exist in that handler (not just somewhere in the file);
 *  - it must name the right role(s);
 *  - it must run before the handler touches the database or writes anything;
 *  - an ADMIN may perform only the desk mutations listed below. Every other mutating
 *    admin endpoint must require SUPER_ADMIN. Adding a new admin mutation therefore fails
 *    this test until someone decides, deliberately, which role it belongs to.
 */

const API = join(process.cwd(), "src/app/api");
const METHOD_RE = /export async function (GET|POST|PATCH|PUT|DELETE)\b/g;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type Handler = { route: string; method: string; body: string };

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (name === "route.ts") out.push(p);
  }
  return out.sort();
}

/** Split a route module into one body per exported HTTP method. */
function handlersOf(file: string): Handler[] {
  const src = readFileSync(file, "utf8");
  const route = relative(API, file).replace(/\\/g, "/").replace(/\/route\.ts$/, "");
  const starts = [...src.matchAll(METHOD_RE)].map((m) => ({ method: m[1], index: m.index ?? 0 }));
  return starts.map((s, i) => ({
    route,
    method: s.method,
    body: src.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : src.length),
  }));
}

/** Index of the first DB or side-effect call in a handler body, or -1. */
function firstEffect(body: string): number {
  const candidates = ["prisma.", "audit(", "notify(", "NOTIFY.", "saveBuffer(", "deleteFile("]
    .map((t) => body.indexOf(t))
    .filter((i) => i >= 0);
  return candidates.length ? Math.min(...candidates) : -1;
}

/** Roles named by the admin guard in this handler, if any. */
function adminGuardRoles(body: string): string[] | null {
  const m = body.match(/requireRole\(([^)]*)\)/);
  if (!m) return null;
  return [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]);
}

/**
 * Desk mutations an ADMIN (not only SUPER_ADMIN) may perform. Keep this list short and
 * reviewed. Keys are `<route>|<method>`.
 */
const ADMIN_DESK_MUTATIONS = new Set([
  "admin/collection|POST",
  "admin/orders/[id]/status|PATCH",
  "admin/orders/[id]/files/[fileId]/pagecount|PATCH",
  "admin/payments/[id]/verify|PATCH",
  "admin/payments/[id]/reject|PATCH",
]);

/** Routes deliberately reachable without a session. Keep this list short. */
const PUBLIC = new Set([
  "auth/login",
  "auth/admin-login",
  "auth/register",
  "auth/recovery/reset",
  "pricing",
  // Idempotent: clears the session cookie whether or not one exists. Audits only when a user is present.
  "auth/logout",
  // Returns 404 unconditionally; kept so old clients get a clear error, not a 405.
  "payment/submit",
]);

const handlers = routeFiles(API).flatMap(handlersOf);
const adminHandlers = handlers.filter((h) => h.route.startsWith("admin/"));

describe("route access matrix", () => {
  it("finds the handlers it is checking (guards against a silently empty matrix)", () => {
    expect(adminHandlers.length).toBeGreaterThan(20);
    expect(handlers.length).toBeGreaterThan(50);
  });

  it("every admin handler checks an admin role before doing any work", () => {
    for (const h of adminHandlers) {
      const id = `${h.route} ${h.method}`;
      const roles = adminGuardRoles(h.body);
      const sessionGuard = /getSessionUser\(\)/.test(h.body) && /isAdminRole\(/.test(h.body);
      expect(roles !== null || sessionGuard, `${id} has no admin-role guard`).toBe(true);
      if (roles) {
        expect(roles.length, `${id} names no role`).toBeGreaterThan(0);
        expect(roles.every((r) => r === "ADMIN" || r === "SUPER_ADMIN"), `${id} names a non-admin role`).toBe(true);
      }
      if (sessionGuard) {
        // getSessionUser alone is not a guard: the handler must reject a missing user.
        expect(h.body, `${id} must reject a missing session`).toMatch(/if \(!user\b[^)]*\)/);
      }
      const effect = firstEffect(h.body);
      const guardAt = roles ? h.body.indexOf("requireRole(") : h.body.indexOf("isAdminRole(");
      if (effect >= 0) {
        expect(guardAt, `${id} touches the database or writes before its guard`).toBeGreaterThanOrEqual(0);
        expect(guardAt, `${id} touches the database or writes before its guard`).toBeLessThan(effect);
      }
    }
  });

  it("a plain ADMIN can perform only the reviewed desk mutations", () => {
    const mutating = adminHandlers.filter((h) => MUTATING.has(h.method));
    expect(mutating.length).toBeGreaterThan(5);
    for (const h of mutating) {
      const key = `${h.route}|${h.method}`;
      const roles = adminGuardRoles(h.body);
      if (ADMIN_DESK_MUTATIONS.has(key)) {
        expect(roles, `${key} is a desk mutation and must allow ADMIN`).toEqual(
          expect.arrayContaining(["ADMIN"])
        );
      } else {
        expect(roles, `${key} must require SUPER_ADMIN only`).toEqual(["SUPER_ADMIN"]);
      }
    }
  });

  it("every allowlisted ADMIN mutation exists (the list cannot silently go stale)", () => {
    const present = new Set(adminHandlers.filter((h) => MUTATING.has(h.method)).map((h) => `${h.route}|${h.method}`));
    for (const key of ADMIN_DESK_MUTATIONS) expect(present, key).toContain(key);
  });

  it("every non-public handler requires a signed-in user", () => {
    for (const h of handlers) {
      if (PUBLIC.has(h.route)) continue;
      const id = `${h.route} ${h.method}`;
      const authed = /requireUser\(|requireRole\(|getSessionUser\(/.test(h.body);
      expect(authed, `${id} does not require a session`).toBe(true);
      if (/getSessionUser\(\)/.test(h.body) && !/requireRole\(|isAdminRole\(/.test(h.body)) {
        expect(h.body, `${id} must reject a missing session`).toMatch(/if \(!user\b[^)]*\)/);
      }
    }
  });

  it("the public allowlist only names routes that exist", () => {
    const routes = new Set(handlers.map((h) => h.route));
    for (const p of PUBLIC) expect(routes).toContain(p);
  });

  it("the admin user-creation endpoint is SUPER_ADMIN only, for POST", () => {
    const post = handlers.find((h) => h.route === "admin/users" && h.method === "POST");
    expect(post).toBeTruthy();
    expect(adminGuardRoles(post!.body)).toEqual(["SUPER_ADMIN"]);
  });
});
