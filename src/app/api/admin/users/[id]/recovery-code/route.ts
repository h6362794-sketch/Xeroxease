import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";
import { apiError, enforceRateLimit, getClientIp, json, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { audit } from "@/server/audit";
import { notify } from "@/server/notifications";
import { ADMIN_ISSUED_CODE_TTL_HOURS, issueRecoveryCode } from "@/server/recovery";
import { z } from "zod";

const bodySchema = z.object({
  // Free-text justification. Stored in the audit trail; required so that an
  // admin-assisted recovery is always attributable and reviewable.
  reason: z.string().trim().min(5).max(500),
});

/**
 * Admin-assisted recovery fallback (SUPER_ADMIN only).
 *
 * For the user who never set up a recovery code and has lost their password. The
 * administrator is expected to verify the person's identity out of band (for
 * XeroxEase: in person at the shop counter, against student ID) before issuing.
 *
 * This endpoint never reveals, resets or displays the user's password, and never
 * signs anyone in. It returns a single-use, short-lived recovery code that the
 * administrator hands to the verified user, who then sets their own password at
 * /forgot-password.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return withErrorHandling(async () => {
    const actor = await requireRole("SUPER_ADMIN");
    const { id } = params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid user id.", 400);

    const limited = await enforceRateLimit(req, RATE_LIMITS.adminRecoveryCode, "admin-recovery-code", actor.id);
    if (limited) return limited;

    const body = bodySchema.safeParse(await req.json().catch(() => null));
    if (!body.success) {
      return apiError("A reason of at least 5 characters is required and is recorded in the audit log.", 400);
    }

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, isActive: true, regNo: true },
    });
    if (!target) return apiError("User not found.", 404);
    if (!target.isActive) return apiError("This account is disabled. Re-enable it first.", 409);

    const issued = await issueRecoveryCode({
      userId: target.id,
      actorId: actor.id,
      ttlHours: ADMIN_ISSUED_CODE_TTL_HOURS,
    });

    await audit({
      actorId: actor.id,
      actorRole: actor.role,
      action: "RECOVERY_CODE_ADMIN_ISSUED",
      targetType: "USER",
      targetId: target.id,
      // The reason is stored; the code is not — not here, not anywhere.
      metadata: { reason: body.data.reason, expiresInHours: ADMIN_ISSUED_CODE_TTL_HOURS },
      ip: getClientIp(req),
    });

    await notify({
      userId: target.id,
      type: "SYSTEM",
      title: "A recovery code was issued for your account",
      body: `An administrator issued a single-use recovery code for your account after verifying your identity. It expires in ${ADMIN_ISSUED_CODE_TTL_HOURS} hours. If this was not you, reset your password immediately and contact support.`,
    });

    return json({
      ok: true,
      // Shown once to the administrator, to hand to the verified user.
      code: issued.code,
      expiresAt: issued.expiresAt?.toISOString() ?? null,
      regNo: target.regNo,
    });
  });
}

export const dynamic = "force-dynamic";
