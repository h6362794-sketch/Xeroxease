import { prisma } from "@/lib/prisma";
import { getSessionUser, verifyPassword } from "@/server/auth";
import { recoveryCodeIssueSchema } from "@/server/validation";
import {
  apiError,
  enforceRateLimit,
  getClientIp,
  json,
  parseBody,
  withErrorHandling,
} from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { audit } from "@/server/audit";
import { issueRecoveryCode } from "@/server/recovery";

/**
 * Generate or rotate the signed-in user's recovery code.
 *
 * The current password is required: the recovery code is an account-takeover
 * credential, so it must not be issuable by anyone holding only a stolen session.
 *
 * The plaintext code is returned exactly once. It is never persisted, logged or
 * written to the audit entry — only its hash is stored.
 */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    if (!user) return apiError("Not authenticated.", 401);

    const limited = await enforceRateLimit(req, RATE_LIMITS.recoveryGenerate, "recovery-generate", user.id);
    if (limited) return limited;

    const data = await parseBody(req, recoveryCodeIssueSchema);
    const ip = getClientIp(req);

    const account = await prisma.user.findUnique({ where: { id: user.id } });
    if (!account) return apiError("Account not found.", 404);
    if (!account.isActive) return apiError("This account has been disabled.", 403);

    const ok = await verifyPassword(data.password, account.passwordHash);
    if (!ok) {
      await audit({
        actorId: user.id,
        actorRole: user.role,
        action: "RECOVERY_CODE_ISSUE_FAILED",
        targetType: "USER",
        targetId: user.id,
        ip,
      });
      return apiError("Your current password is incorrect.", 401);
    }

    const issued = await issueRecoveryCode({ userId: user.id });

    await audit({
      actorId: user.id,
      actorRole: user.role,
      action: "RECOVERY_CODE_GENERATED",
      targetType: "USER",
      targetId: user.id,
      ip,
    });

    return json({
      ok: true,
      // Shown once; the server cannot show it again.
      code: issued.code,
      createdAt: issued.createdAt.toISOString(),
      expiresAt: null,
    });
  });
}

export const dynamic = "force-dynamic";
