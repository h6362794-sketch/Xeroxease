import { prisma } from "@/lib/prisma";
import { newToken, sha256 } from "@/server/auth";
import { forgotPasswordSchema } from "@/server/validation";
import { enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { audit } from "@/server/audit";

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const limited = enforceRateLimit(req, RATE_LIMITS.forgotPassword, "forgot");
    if (limited) return limited;

    const data = await parseBody(req, forgotPasswordSchema);
    const user = await prisma.user.findUnique({ where: { emailNorm: data.email } });

    const message = "If an account exists for this email, a reset link has been created.";
    const base = { ok: true as const, message };

    if (!user || !user.isActive) return json(base);

    const token = newToken(24);
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + 30 * 60_000), // 30 minutes
      },
    });

    await audit({ actorId: user.id, action: "PASSWORD_RESET_REQUESTED", targetType: "USER", targetId: user.id });

    // Email delivery is not configured by default; expose the token only in dev.
    if (process.env.NODE_ENV !== "production" && process.env.ENABLE_EMAIL_DELIVERY !== "true") {
      return json({ ...base, devResetToken: token });
    }
    return json(base);
  });
}

export const dynamic = "force-dynamic";
