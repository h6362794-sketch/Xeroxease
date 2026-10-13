import { hashPassword } from "@/server/auth";
import { resetPasswordSchema } from "@/server/validation";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { audit } from "@/server/audit";
import { redeemPasswordResetToken } from "@/server/password-reset";

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    // This endpoint was previously unthrottled, so a leaked token could be brute
    // forced and the endpoint itself could be hammered.
    const limited = await enforceRateLimit(req, RATE_LIMITS.resetPassword, "reset");
    if (limited) return limited;

    const data = await parseBody(req, resetPasswordSchema);
    const { hash } = await hashPassword(data.password);

    const result = await redeemPasswordResetToken(data.token, hash);

    // Identical response for unknown, expired, malformed and already-used tokens so
    // the endpoint cannot be used to probe which tokens are live.
    if (!result.ok) {
      return apiError(
        "This reset link is invalid or has expired. Please request a new one.",
        400,
        "RESET_TOKEN_INVALID"
      );
    }

    await audit({
      actorId: result.userId,
      action: "PASSWORD_RESET_COMPLETED",
      targetType: "USER",
      targetId: result.userId,
    });

    return json({ ok: true });
  });
}

export const dynamic = "force-dynamic";
