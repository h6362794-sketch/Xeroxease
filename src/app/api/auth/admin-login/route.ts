import { prisma } from "@/lib/prisma";
import { createSession, recordFailedLogin, verifyPassword } from "@/server/auth";
import { adminLoginSchema } from "@/server/validation";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling, getClientIp } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { audit } from "@/server/audit";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

function isTransientPrismaError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === "string" && ["P1001", "P1002", "P1008", "P1017", "P2024", "P2037"].includes(code);
}

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const limited = await enforceRateLimit(req, RATE_LIMITS.login, "admin-login");
    if (limited) return limited;

    const data = await parseBody(req, adminLoginSchema);
    let ip = "unknown";
    try {
      ip = getClientIp(req);
    } catch {
      ip = "unknown";
    }

    let user: Awaited<ReturnType<typeof prisma.user.findUnique>> = null;
    try {
      user = await prisma.user.findUnique({ where: { emailNorm: data.email } });
    } catch (err) {
      if (isTransientPrismaError(err)) {
        throw Object.assign(new Error("Service temporarily unavailable"), { status: 503, code: (err as { code?: string }).code });
      }
      throw err;
    }

    const genericFailure = apiError("Invalid credentials.", 401);

    if (!user || (user.role !== "ADMIN" && user.role !== "SUPER_ADMIN")) {
      try {
        await audit({ action: "ADMIN_LOGIN_FAILED", metadata: { reason: "unknown-or-non-admin" }, ip });
      } catch {}
      return genericFailure;
    }
    if (!user.isActive) {
      try {
        await audit({ actorId: user.id, action: "ADMIN_LOGIN_FAILED", metadata: { reason: "disabled" }, ip });
      } catch {}
      return genericFailure;
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return apiError("Account temporarily locked. Try again later.", 429);
    }

    let ok = false;
    try {
      ok = await verifyPassword(data.password, user.passwordHash);
    } catch (err) {
      if ((err as { status?: number })?.status === 503) throw err;
      ok = false;
    }
    if (!ok) {
      try {
        await recordFailedLogin(user.id, { maxFailed: MAX_FAILED, lockMinutes: LOCK_MINUTES });
      } catch {}
      try {
        await audit({ actorId: user.id, action: "ADMIN_LOGIN_FAILED", targetType: "USER", targetId: user.id, ip });
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
        console.error("[admin-login] transient failure resetting counter:", err);
      } else {
        throw err;
      }
    }
    await createSession(user.id, "ADMIN", { ip, userAgent: req.headers.get("user-agent") ?? undefined });
    try {
      await audit({ actorId: user.id, actorRole: user.role, action: "ADMIN_LOGIN_SUCCESS", targetType: "USER", targetId: user.id, ip });
    } catch {}

    return json({ ok: true, role: user.role });
  });
}

export const dynamic = "force-dynamic";
