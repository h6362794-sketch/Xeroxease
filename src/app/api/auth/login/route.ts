import { prisma } from "@/lib/prisma";
import { createSession, verifyPassword } from "@/server/auth";
import { loginSchema } from "@/server/validation";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling, getClientIp } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { audit } from "@/server/audit";

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const limited = await enforceRateLimit(req, RATE_LIMITS.login, "login");
    if (limited) return limited;

    const data = await parseBody(req, loginSchema);
    const ip = getClientIp(req);
    const identifier = data.identifier.toLowerCase();

    // Students may log in with email OR registration number.
    const user = await prisma.user.findFirst({
      where: { OR: [{ emailNorm: identifier }, { regNo: data.identifier.toUpperCase() }] },
    });

    const genericFailure = apiError("Invalid credentials.", 401);

    if (!user) {
      await audit({ action: "LOGIN_FAILED", targetType: "USER", metadata: { identifier: "[redacted]" }, ip });
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

    const ok = await verifyPassword(data.password, user.passwordHash);
    if (!ok) {
      const failedLoginCount = user.failedLoginCount + 1;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount,
          lockedUntil:
            failedLoginCount >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        },
      });
      await audit({ actorId: user.id, action: "LOGIN_FAILED", targetType: "USER", targetId: user.id, ip });
      return genericFailure;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await createSession(user.id, "STUDENT", {
      ip,
      userAgent: req.headers.get("user-agent") ?? undefined,
    });
    await audit({ actorId: user.id, actorRole: "STUDENT", action: "LOGIN_SUCCESS", targetType: "USER", targetId: user.id, ip });

    return json({ ok: true, role: "STUDENT" });
  });
}

export const dynamic = "force-dynamic";
