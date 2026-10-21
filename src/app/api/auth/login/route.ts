import { prisma } from "@/lib/prisma";
import { createSession, recordFailedLogin, verifyPassword } from "@/server/auth";
import { loginSchema } from "@/server/validation";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling, getClientIp } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { audit } from "@/server/audit";

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

function isTransientPrismaError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === "string" && ["P1001", "P1002", "P1008", "P1017", "P2024", "P2037"].includes(code);
}

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const limited = await enforceRateLimit(req, RATE_LIMITS.login, "login");
    if (limited) return limited;

    const data = await parseBody(req, loginSchema);
    let ip = "unknown";
    try {
      ip = getClientIp(req);
    } catch {
      ip = "unknown";
    }
    const identifier = data.identifier.toLowerCase();

    // Students may log in with email OR registration number.
    let user: Awaited<ReturnType<typeof prisma.user.findFirst>> = null;
    try {
      user = await prisma.user.findFirst({
        where: { OR: [{ emailNorm: identifier }, { regNo: data.identifier.toUpperCase() }] },
      });
    } catch (err) {
      if (isTransientPrismaError(err)) {
        throw Object.assign(new Error("Service temporarily unavailable"), { status: 503, code: (err as { code?: string }).code });
      }
      throw err;
    }

    const genericFailure = apiError("Invalid credentials.", 401);

    if (!user) {
      try {
        await audit({ action: "LOGIN_FAILED", targetType: "USER", metadata: { identifier: "[redacted]" }, ip });
      } catch {}
      return genericFailure;
    }
    if (user.role !== "STUDENT") {
      // Admins must use /admin/login.
      return apiError("Invalid credentials.", 401);
    }
    if (!user.isActive) return apiError("This account has been disabled. Contact support.", 403);
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return apiError("Account temporarily locked due to failed attempts. Try again later.", 429);
    }

    let ok = false;
    try {
      ok = await verifyPassword(data.password, user.passwordHash);
    } catch (err) {
      // verifyPassword throws 503 when argon2 unavailable — propagate as 503
      if ((err as { status?: number })?.status === 503) throw err;
      // Otherwise treat as credential mismatch
      ok = false;
    }
    if (!ok) {
      // recordFailedLogin is resilient internally; still await it but don't let it crash login
      try {
        await recordFailedLogin(user.id, { maxFailed: MAX_FAILED, lockMinutes: LOCK_MINUTES });
      } catch {}
      try {
        await audit({ actorId: user.id, action: "LOGIN_FAILED", targetType: "USER", targetId: user.id, ip });
      } catch {}
      return genericFailure;
    }

    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
      });
    } catch (err) {
      if (isTransientPrismaError(err)) {
        console.error("[login] failed to reset lockout counter (transient):", err);
        // Don't block login if transient — session can still be created; counter will retry next success
      } else {
        throw err;
      }
    }
    try {
      await createSession(user.id, "STUDENT", {
        ip,
        userAgent: req.headers.get("user-agent") ?? undefined,
      });
    } catch (err) {
      // createSession already maps transient to 503
      throw err;
    }
    try {
      await audit({ actorId: user.id, actorRole: "STUDENT", action: "LOGIN_SUCCESS", targetType: "USER", targetId: user.id, ip });
    } catch {}

    return json({ ok: true, role: "STUDENT" });
  });
}

export const dynamic = "force-dynamic";
