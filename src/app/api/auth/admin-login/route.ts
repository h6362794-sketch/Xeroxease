import { prisma } from "@/lib/prisma";
import { createSession, verifyPassword } from "@/server/auth";
import { adminLoginSchema } from "@/server/validation";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling, getClientIp } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { audit } from "@/server/audit";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const limited = await enforceRateLimit(req, RATE_LIMITS.login, "admin-login");
    if (limited) return limited;

    const data = await parseBody(req, adminLoginSchema);
    const ip = getClientIp(req);

    const user = await prisma.user.findUnique({ where: { emailNorm: data.email } });

    const genericFailure = apiError("Invalid credentials.", 401);

    if (!user || (user.role !== "ADMIN" && user.role !== "SUPER_ADMIN")) {
      await audit({ action: "ADMIN_LOGIN_FAILED", metadata: { reason: "unknown-or-non-admin" }, ip });
      return genericFailure;
    }
    if (!user.isActive) {
      await audit({ actorId: user.id, action: "ADMIN_LOGIN_FAILED", metadata: { reason: "disabled" }, ip });
      return genericFailure;
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return apiError("Account temporarily locked. Try again later.", 429);
    }

    const ok = await verifyPassword(data.password, user.passwordHash);
    if (!ok) {
      const failedLoginCount = user.failedLoginCount + 1;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount,
          lockedUntil: failedLoginCount >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        },
      });
      await audit({ actorId: user.id, action: "ADMIN_LOGIN_FAILED", targetType: "USER", targetId: user.id, ip });
      return genericFailure;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await createSession(user.id, "ADMIN", { ip, userAgent: req.headers.get("user-agent") ?? undefined });
    await audit({ actorId: user.id, actorRole: user.role, action: "ADMIN_LOGIN_SUCCESS", targetType: "USER", targetId: user.id, ip });

    return json({ ok: true, role: user.role });
  });
}

export const dynamic = "force-dynamic";
