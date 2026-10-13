import { prisma } from "@/lib/prisma";
import { issuePasswordResetToken, RESET_TTL_MINUTES } from "@/server/password-reset";
import { forgotPasswordSchema } from "@/server/validation";
import { enforceRateLimit, getClientIp, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { audit } from "@/server/audit";
import { buildResetUrl, isEmailConfigured, sendPasswordResetEmail } from "@/server/email";

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    // Rate limited by IP *and* by the submitted address, so one client cannot probe
    // many accounts from a single host.
    const ipLimited = await enforceRateLimit(req, RATE_LIMITS.forgotPassword, "forgot-ip");
    if (ipLimited) return ipLimited;

    const data = await parseBody(req, forgotPasswordSchema);
    const emailLimited = await enforceRateLimit(
      req,
      RATE_LIMITS.forgotPassword,
      "forgot-email",
      data.email
    );
    if (emailLimited) return emailLimited;

    const user = await prisma.user.findUnique({ where: { emailNorm: data.email } });

    // Identical response whether or not the account exists (no account enumeration).
    const message = "If an account exists for this email, a reset link has been created.";
    const base = { ok: true as const, message };

    if (!user || !user.isActive) {
      await audit({
        action: "PASSWORD_RESET_REQUESTED",
        metadata: { outcome: "no-active-account" },
        ip: getClientIp(req),
      });
      return json(base);
    }

    // Issues (and stores only the hash of) a single-use token, expiring any
    // previously issued unused token for this user.
    const token = await issuePasswordResetToken(user.id);

    await audit({
      actorId: user.id,
      action: "PASSWORD_RESET_REQUESTED",
      targetType: "USER",
      targetId: user.id,
      ip: getClientIp(req),
    });

    let delivered = false;
    if (isEmailConfigured()) {
      const result = await sendPasswordResetEmail({
        to: user.email,
        resetUrl: buildResetUrl(token),
        expiresInMinutes: RESET_TTL_MINUTES,
      });
      delivered = result.delivered;
      await audit({
        actorId: user.id,
        action: delivered ? "PASSWORD_RESET_EMAIL_SENT" : "PASSWORD_RESET_EMAIL_FAILED",
        targetType: "USER",
        targetId: user.id,
        metadata: { detail: result.detail },
      });
    }

    // Never expose the token in production, and never when email delivery is on
    // (the link has already left the system through a real channel).
    const devOnly =
      process.env.NODE_ENV !== "production" &&
      !isEmailConfigured() &&
      process.env.EXPOSE_RESET_TOKEN_IN_DEV === "true";

    return json(devOnly ? { ...base, devResetToken: token, emailed: delivered } : base);
  });
}

export const dynamic = "force-dynamic";
