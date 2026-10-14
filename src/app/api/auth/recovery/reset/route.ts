import { hashPassword } from "@/server/auth";
import { recoveryResetSchema } from "@/server/validation";
import { apiError, enforceRateLimit, getClientIp, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { audit } from "@/server/audit";
import { notify } from "@/server/notifications";
import { redeemRecoveryCode } from "@/server/recovery";

/**
 * Redeem a recovery code for a new password.
 *
 * No email is sent and no out-of-band token travels anywhere: the account owner
 * supplies the code they stored when they set the account up.
 *
 * The response is identical whether the account exists, has no code, or the code is
 * wrong, expired or already used — otherwise this endpoint becomes an account
 * enumeration and code-validity oracle.
 */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const data = await parseBody(req, recoveryResetSchema);
    const ip = getClientIp(req);
    const identifier = data.identifier.toLowerCase();

    // Keyed on IP *and* the submitted identifier so one client cannot hammer many
    // different accounts from a single address.
    const limited = await enforceRateLimit(
      req,
      RATE_LIMITS.recoveryReset,
      "recovery-reset",
      identifier.slice(0, 64)
    );
    if (limited) return limited;

    const { hash } = await hashPassword(data.password);

    const result = await redeemRecoveryCode({
      identifier,
      code: data.recoveryCode,
      newPasswordHash: hash,
    });

    if (!result.ok) {
      // Deliberately no metadata: recording which identifier or code was tried
      // would turn the audit log into a recovery-code disclosure channel.
      await audit({
        action: "RECOVERY_CODE_REDEEM_FAILED",
        targetType: "USER",
        ip,
      });
      return apiError(
        "We could not verify those details. Check the identifier and recovery code, or ask an administrator to issue you a new code.",
        400,
        "RECOVERY_FAILED"
      );
    }

    await audit({
      actorId: result.userId,
      action: "RECOVERY_CODE_REDEEMED",
      targetType: "USER",
      targetId: result.userId,
      ip,
    });
    await notify({
      userId: result.userId,
      type: "SYSTEM",
      title: "Password reset with your recovery code",
      body: "Your password was reset using your recovery code and all sessions were signed out. Generate a new recovery code now — the one you used cannot be used again.",
    });

    return json({ ok: true });
  });
}

export const dynamic = "force-dynamic";
