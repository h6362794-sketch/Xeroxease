import { getSessionUser } from "@/server/auth";
import { apiError, enforceRateLimit, json, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { getRecoveryCodeStatus } from "@/server/recovery";

/**
 * Metadata about the signed-in user's recovery code.
 *
 * Deliberately returns no secret: whether a code exists is not sensitive, but the
 * code itself is unrecoverable by design.
 */
export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    if (!user) return apiError("Not authenticated.", 401);

    const limited = await enforceRateLimit(req, RATE_LIMITS.publicApi, "recovery-status", user.id);
    if (limited) return limited;

    const status = await getRecoveryCodeStatus(user.id);
    return json({
      ok: true,
      ...status,
      createdAt: status.createdAt?.toISOString() ?? null,
      expiresAt: status.expiresAt?.toISOString() ?? null,
      usedAt: status.usedAt?.toISOString() ?? null,
    });
  });
}

export const dynamic = "force-dynamic";
