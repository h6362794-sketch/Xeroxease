import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * Access-control matrix for the REST surface. Authorization is enforced per handler, not
 * by a central router, so a new route that forgets its guard would be silently open.
 * These checks read each route module and fail if its guard is missing.
 */

const API = join(process.cwd(), "src/app/api");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (name === "route.ts") out.push(p);
  }
  return out.sort();
}

const rel = (p: string) => relative(API, p).replace(/\\/g, "/");
const src = (p: string) => readFileSync(p, "utf8");

/** Routes that are deliberately reachable without a session. Keep this list short. */
const PUBLIC = new Set([
  "auth/login/route.ts",
  "auth/admin-login/route.ts",
  "auth/register/route.ts",
  "auth/recovery/reset/route.ts",
  "pricing/route.ts",
  // Returns 404 unconditionally; kept so old clients get a clear error, not a 405.
  "payment/submit/route.ts",
]);

const SUPER_ADMIN_ONLY_HANDLERS = [
  "admin/settings/route.ts",
  "admin/audit-logs/route.ts",
  "admin/payment-qr/route.ts",
  "admin/users/[id]/route.ts",
  "admin/uploads/sweep/route.ts",
  "admin/users/[id]/recovery-code/route.ts",
];

describe("route access matrix", () => {
  const files = routeFiles(API);

  it("every admin route checks an admin role", () => {
    const admin = files.filter((f) => rel(f).startsWith("admin/"));
    expect(admin.length).toBeGreaterThan(10);
    for (const f of admin) {
      const s = src(f);
      const guarded = /requireRole\(|isAdminRole\(/.test(s);
      expect(guarded, `${rel(f)} has no admin-role guard`).toBe(true);
    }
  });

  it("every non-public route requires a signed-in user", () => {
    for (const f of files) {
      const r = rel(f);
      if (PUBLIC.has(r)) continue;
      const s = src(f);
      const authed = /requireUser\(|requireRole\(|getSessionUser\(/.test(s);
      expect(authed, `${r} does not require a session`).toBe(true);
    }
  });

  it("the public allowlist only contains routes that exist", () => {
    for (const p of PUBLIC) {
      expect(files.map(rel)).toContain(p);
    }
  });

  it("SUPER_ADMIN-only handlers require SUPER_ADMIN for their mutating methods", () => {
    for (const r of SUPER_ADMIN_ONLY_HANDLERS) {
      const s = src(join(API, r));
      expect(s, `${r} must require SUPER_ADMIN`).toMatch(/requireRole\("SUPER_ADMIN"\)/);
    }
  });

  it("the admin user-creation endpoint cannot be called by a plain ADMIN", () => {
    const s = src(join(API, "admin/users/route.ts"));
    const post = s.slice(s.indexOf("export async function POST"));
    expect(post).toMatch(/requireRole\("SUPER_ADMIN"\)/);
  });
});
