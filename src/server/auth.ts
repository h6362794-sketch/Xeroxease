import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { env } from "@/server/env";
import { SESSION_COOKIE } from "@/lib/constants";
import type { Role } from "@prisma/client";

// ---------- Password hashing (argon2id; bcryptjs fallback) ----------

type HashResult = { hash: string; algo: "argon2id" | "bcrypt" };

// Share the pending import as well as its result. A boolean "tried" flag can
// make concurrent cold-start logins observe null before the first import ends,
// rejecting correct argon2 passwords and incrementing the lockout counter.
let argon2Promise: Promise<typeof import("argon2") | null> | undefined;

function getArgon2(): Promise<typeof import("argon2") | null> {
  if (!argon2Promise) {
    argon2Promise = (async () => {
      try {
        const mod = await import("argon2");
        return mod.default ?? (mod as unknown as typeof import("argon2"));
      } catch (err) {
        // Warn once per process on a real import failure; NEW hashes still use
        // bcrypt, but existing argon2id hashes cannot be verified until repaired.
        console.warn(
          "[auth] argon2 failed to load; falling back to bcrypt for NEW hashes. " +
            "Existing argon2id hashes cannot be verified until argon2 loads " +
            "correctly. Cause: " +
            (err instanceof Error ? err.message : String(err))
        );
        return null;
      }
    })();
  }
  return argon2Promise;
}

export async function hashPassword(plain: string): Promise<HashResult> {
  const argon2 = await getArgon2();
  if (argon2) {
    return { hash: await argon2.hash(plain, { type: argon2.argon2id }), algo: "argon2id" };
  }
  const bcrypt = await import("bcryptjs");
  return { hash: await bcrypt.hash(plain, 12), algo: "bcrypt" };
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    if (hash.startsWith("$argon2")) {
      const argon2 = await getArgon2();
      if (!argon2) {
        // Do not silently return false — that would lock correct users out
        // and increment the brute-force counter for every login attempt
        // while argon2 is unavailable. Instead surface a transient error
        // so withErrorHandling can return 503 and the UI can retry.
        console.error("[auth] argon2 hash cannot be verified: argon2 module unavailable");
        throw Object.assign(new Error("Authentication service temporarily unavailable"), {
          status: 503,
          code: "P1001",
        });
      }
      return await argon2.verify(hash, plain);
    }
    const bcrypt = await import("bcryptjs");
    return await bcrypt.compare(plain, hash);
  } catch (err) {
    // If we already threw a 503 above, re-throw it
    if (err && typeof err === "object" && "status" in err && (err as { status?: number }).status === 503) {
      throw err;
    }
    // Malformed hash or bcrypt failure is a credential mismatch, not a server fault
    return false;
  }
}

// ---------- Tokens ----------

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// ---------- Sessions ----------

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
}

function isPrismaTransientCode(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && ["P1001", "P1002", "P1008", "P1017", "P2024", "P2037"].includes(code)) {
    return true;
  }
  return false;
}

export async function createSession(
  userId: string,
  kind: "STUDENT" | "ADMIN",
  meta?: { ip?: string; userAgent?: string }
): Promise<string> {
  let ttlHours: number;
  try {
    ttlHours = env.SESSION_TTL_HOURS;
  } catch (err) {
    console.error("[auth] SESSION_TTL_HOURS misconfigured:", err instanceof Error ? err.message : err);
    ttlHours = 24;
  }

  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);

  // Retry on rare tokenHash collision (P2002). Original code threw raw Prisma error as 500.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = newToken();
    try {
      await prisma.session.create({
        data: {
          userId,
          tokenHash: sha256(token),
          kind,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent?.slice(0, 255) ?? null,
          expiresAt,
        },
      });
      // Only set cookie after successful DB write
      try {
        const store = await cookies();
        store.set(SESSION_COOKIE, token, {
          httpOnly: true,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
          path: "/",
          expires: expiresAt,
        });
      } catch (err) {
        // Cookie failure is a server misconfiguration, but the session already exists.
        // Log and re-throw so the login can clean up or report correctly.
        console.error("[auth] failed to set session cookie:", err instanceof Error ? err.message : err);
        // Attempt to clean up the just-created session to avoid orphaned rows
        try {
          await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
        } catch {}
        throw Object.assign(new Error("Failed to establish session"), { status: 500 });
      }
      return token;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "P2002" && attempt < 2) {
        lastError = err;
        continue; // retry with new token
      }
      if (isPrismaTransientCode(err)) {
        console.error("[auth] transient DB error during createSession:", (err as Error).message);
        throw Object.assign(new Error("Service temporarily unavailable"), { status: 503, code });
      }
      throw err;
    }
  }
  throw lastError ?? new Error("Failed to create session");
}

export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const session = await prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: true },
    });
    if (!session) return null;
    if (session.revokedAt || session.expiresAt < new Date()) return null;
    if (!session.user.isActive) return null;
    return {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role,
      isActive: session.user.isActive,
    };
  } catch (err) {
    // DB connectivity / schema skew during session lookup must not crash the page
    // as a 500. Return null so the layout redirects to /login, and let
    // instrumentation log the skew.
    if (err && typeof err === "object" && "status" in err && typeof (err as { status?: number }).status === "number") {
      throw err;
    }
    console.error("[auth] getSessionUser failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function destroySession(): Promise<void> {
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (token) {
      await prisma.session.updateMany({
        where: { tokenHash: sha256(token) },
        data: { revokedAt: new Date() },
      });
    }
    store.delete(SESSION_COOKIE);
  } catch (err) {
    console.error("[auth] destroySession failed:", err instanceof Error ? err.message : err);
    // Still attempt to clear cookie
    try {
      const store = await cookies();
      store.delete(SESSION_COOKIE);
    } catch {}
  }
}

/**
 * Record a failed login attempt.
 *
 * The counter increment is atomic. A read-then-write pattern loses
 * updates when several wrong-password requests race: each reads the
 * same count and writes the same incremented value, undercounting
 * attempts and delaying the lockout. The lock itself is applied by a
 * conditional update that only matches once the counter reaches the
 * threshold, so concurrent failures cannot skip the lockout either.
 *
 * Resilience: DB failures here must NOT turn a wrong-password 401 into a 500.
 * The caller (login route) already handles the credential failure; we log
 * and swallow transient errors so the user gets the expected 401.
 */
export async function recordFailedLogin(
  userId: string,
  opts: { maxFailed: number; lockMinutes: number }
): Promise<void> {
  try {
    const locked = await prisma.user.updateMany({
      where: { id: userId, failedLoginCount: { gte: opts.maxFailed - 1 } },
      data: {
        failedLoginCount: { increment: 1 },
        lockedUntil: new Date(Date.now() + opts.lockMinutes * 60_000),
      },
    });
    if (locked.count === 0) {
      await prisma.user.update({
        where: { id: userId },
        data: { failedLoginCount: { increment: 1 } },
      });
    }
  } catch (err) {
    console.error("[auth] recordFailedLogin failed for", userId, ":", err instanceof Error ? err.message : err);
    // Swallow — login should still return 401 to the user. Lockout will be
    // eventually consistent on next successful DB write.
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    const err = new Error("UNAUTHENTICATED");
    (err as Error & { status?: number }).status = 401;
    throw err;
  }
  return user;
}

/**
 * Guard for **page** components (Server Components).
 *
 * Server pages must redirect rather than throw. A layout and its page render
 * concurrently in the App Router, so a page that throws a plain Error races the
 * layout's `redirect()` and produces a noisy server-side stack trace (and, if the
 * error wins, an error-boundary page instead of the login redirect). Redirecting
 * from the page as well is both quieter and defence-in-depth: the page keeps
 * working even if the enclosing layout guard is ever removed or changed.
 *
 * API routes should keep using `requireUser()` / `requireRole()`, which correctly
 * return 401/403 instead of an HTML redirect.
 */
export async function requirePageUser(redirectTo = "/login"): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(redirectTo);
  return user;
}

export async function requireRole(...roles: Role[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) {
    const err = new Error("FORBIDDEN");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
  return user;
}

/**
 * Role as it reaches the role helpers.
 *
 * Prisma's generated `Role` union is the normal input, but several modules take an
 * *injection* rather than a call — e.g. `direct-upload/download.ts` receives
 * `isAdminRole` as a predicate over the role it read from a row, and `tests/` hand it
 * plain strings. Widening the parameter to `string` keeps those call sites honest
 * without weakening the comparison, which is a closed set of two literals either way.
 */
export type RoleLike = Role | string;

export function isAdminRole(role: RoleLike): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}
