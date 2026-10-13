import { prisma } from "@/lib/prisma";
import { newToken, sha256 } from "./auth";

export const RESET_TTL_MINUTES = 30;

/**
 * Issue a single-use password-reset token.
 *
 * Only the SHA-256 hash of the token is stored, and every previously issued unused
 * token for the same user is expired first so a user can never hold two live links.
 * Returns the raw token (the only time it exists outside the user's mailbox) or
 * null when no active account exists — callers must not distinguish that case.
 */
export async function issuePasswordResetToken(userId: string): Promise<string> {
  const token = newToken(24);
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);

  await prisma.passwordResetToken.updateMany({
    where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
    data: { expiresAt: new Date() },
  });

  await prisma.passwordResetToken.create({
    data: { userId, tokenHash: sha256(token), expiresAt },
  });

  return token;
}

export type RedeemResult = { ok: true; userId: string } | { ok: false };

/**
 * Redeem a reset token atomically.
 *
 * The conditional UPDATE (`usedAt IS NULL AND expiresAt > now`) is what makes the
 * token single-use: two concurrent redemptions of the same token race for the same
 * row and exactly one can match. Sessions are revoked and remaining tokens expired
 * in the same transaction, so a successful reset always invalidates everything
 * derived from the old password.
 */
export async function redeemPasswordResetToken(token: string, newPasswordHash: string): Promise<RedeemResult> {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: sha256(token) },
  });
  if (!record || record.usedAt || record.expiresAt < new Date()) return { ok: false };

  const now = new Date();

  const claimed = await prisma.$transaction(async (tx) => {
    const { count } = await tx.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (count !== 1) return false;

    await tx.user.update({
      where: { id: record.userId },
      data: { passwordHash: newPasswordHash, failedLoginCount: 0, lockedUntil: null },
    });
    // Revoke every existing session (force logout everywhere).
    await tx.session.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: now },
    });
    // Any other outstanding links for this user are now useless.
    await tx.passwordResetToken.updateMany({
      where: { userId: record.userId, usedAt: null },
      data: { expiresAt: now },
    });
    return true;
  });

  return claimed ? { ok: true, userId: record.userId } : { ok: false };
}
