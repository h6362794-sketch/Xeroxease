import { prisma } from "@/lib/prisma";
import { hashPassword, sha256 } from "@/server/auth";
import { resetPasswordSchema } from "@/server/validation";
import { apiError, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { audit } from "@/server/audit";

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const data = await parseBody(req, resetPasswordSchema);

    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256(data.token) },
    });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      return apiError("This reset link is invalid or has expired. Please request a new one.", 400);
    }

    const { hash } = await hashPassword(data.password);

    await prisma.$transaction([
      prisma.user.update({ where: { id: record.userId }, data: { passwordHash: hash, failedLoginCount: 0, lockedUntil: null } }),
      prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      // Revoke all existing sessions for safety.
      prisma.session.updateMany({ where: { userId: record.userId }, data: { revokedAt: new Date() } }),
    ]);

    await audit({ actorId: record.userId, action: "PASSWORD_RESET_COMPLETED", targetType: "USER", targetId: record.userId });

    return json({ ok: true });
  });
}

export const dynamic = "force-dynamic";
