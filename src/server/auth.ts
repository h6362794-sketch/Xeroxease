import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { env } from "@/server/env";
import { SESSION_COOKIE } from "@/lib/constants";
import type { Role } from "@prisma/client";

// ---------- Password hashing (argon2id; bcryptjs fallback) ----------

type HashResult = { hash: string; algo: "argon2id" | "bcrypt" };

let argon2Module: typeof import("argon2") | null = null;
let argon2Tried = false;

async function getArgon2() {
  if (argon2Tried) return argon2Module;
  argon2Tried = true;
  try {
    const mod = await import("argon2");
    argon2Module = mod.default ?? (mod as unknown as typeof import("argon2"));
  } catch {
    argon2Module = null;
  }
  return argon2Module;
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
      if (!argon2) return false;
      return await argon2.verify(hash, plain);
    }
    const bcrypt = await import("bcryptjs");
    return await bcrypt.compare(plain, hash);
  } catch {
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

export async function createSession(
  userId: string,
  kind: "STUDENT" | "ADMIN",
  meta?: { ip?: string; userAgent?: string }
): Promise<string> {
  const token = newToken();
  const ttlHours = env.SESSION_TTL_HOURS;
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
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
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
  return token;
}

export async function getSessionUser(): Promise<SessionUser | null> {
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
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.updateMany({
      where: { tokenHash: sha256(token) },
      data: { revokedAt: new Date() },
    });
  }
  store.delete(SESSION_COOKIE);
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
