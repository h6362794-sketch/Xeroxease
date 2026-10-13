// Email-free account recovery.
//
// A recovery code is a high-entropy, single-use credential the account owner
// generates in advance and stores themselves (password manager, printed copy).
// Redeeming one — together with the account identifier — sets a new password.
//
// No email or SMS is sent anywhere in this flow, and no paid third-party service
// is involved. See the OWASP Forgot Password Cheat Sheet for the properties this
// implements: https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html

import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { sha256 } from "./auth";

/** Crockford base32: no I, L, O or U, so codes are unambiguous when read aloud. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 20 bytes = 160 bits = 32 base32 characters. Not brute-forceable. */
const CODE_BYTES = 20;
const CODE_CHARS = 32;
const GROUP_SIZE = 4;

export const RECOVERY_CODE_SHAPE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{32}$/;

/** Default lifetime for a code issued by an administrator on a user's behalf. */
export const ADMIN_ISSUED_CODE_TTL_HOURS = 24;

/**
 * Generate a recovery code from a CSPRNG. Never derived from a username, phone
 * number, timestamp or database id — those are predictable.
 */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(CODE_BYTES);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return formatRecoveryCode(out);
}

/** Group the code for readability: ABCD-EFGH-… */
export function formatRecoveryCode(raw: string): string {
  return raw.match(new RegExp(`.{1,${GROUP_SIZE}}`, "g"))?.join("-") ?? raw;
}

/**
 * Accept the code however the user types it: any case, with or without separators,
 * and with the Crockford typo equivalences (I/L -> 1, O -> 0) applied.
 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

export function isValidRecoveryCodeShape(input: string): boolean {
  return RECOVERY_CODE_SHAPE.test(normalizeRecoveryCode(input));
}

/**
 * Codes are 160-bit random, so a fast hash is appropriate — there is no dictionary
 * to attack and therefore no need for a slow KDF. Storing a plain SHA-256 (rather
 * than an HMAC keyed on SESSION_SECRET) also means codes survive secret rotation.
 * The plaintext code is never written to the database, logs or audit metadata.
 */
export function hashRecoveryCode(code: string): string {
  return sha256(normalizeRecoveryCode(code));
}

export interface IssuedRecoveryCode {
  /** Plaintext code. Returned to the caller exactly once; never persisted. */
  code: string;
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date | null;
}

/**
 * Issue (or rotate) the single active recovery code for an account.
 *
 * The replace happens inside one transaction: the old row is deleted and the new
 * one inserted together, so a failure while writing the new code rolls back the
 * deletion and the user never ends up with no code at all.
 */
export async function issueRecoveryCode(params: {
  userId: string;
  /** Set when a Super Admin issues the code on the user's behalf. */
  actorId?: string | null;
  /** Omit (or null) for a self-generated code that does not expire. */
  ttlHours?: number | null;
}): Promise<IssuedRecoveryCode> {
  const code = generateRecoveryCode();
  const codeHash = hashRecoveryCode(code);
  const now = new Date();
  const expiresAt =
    params.ttlHours && params.ttlHours > 0
      ? new Date(now.getTime() + params.ttlHours * 3_600_000)
      : null;

  const row = await prisma.$transaction(async (tx) => {
    // `userId` is unique, so this replaces any previous code (used or not).
    await tx.recoveryCode.deleteMany({ where: { userId: params.userId } });
    return tx.recoveryCode.create({
      data: {
        userId: params.userId,
        codeHash,
        createdBy: params.actorId ?? null,
        expiresAt,
      },
      select: { id: true, createdAt: true, expiresAt: true },
    });
  });

  return { code, id: row.id, userId: params.userId, createdAt: row.createdAt, expiresAt: row.expiresAt };
}

export type RedeemResult = { ok: true; userId: string } | { ok: false };

/**
 * Verify a recovery code and apply a new password atomically.
 *
 * The guarded `updateMany` (`usedAt IS NULL`) is what makes the code single-use:
 * concurrent redemptions race for the same row and exactly one can match. The
 * password update and the session revocation happen in the same transaction, so a
 * successful reset can never leave an old session alive.
 *
 * Every failure path returns the identical `{ ok: false }` so the caller can emit
 * one generic message — the endpoint must not reveal whether the account exists,
 * whether it has a code, or whether that code was already used or expired.
 */
export async function redeemRecoveryCode(params: {
  identifier: string;
  code: string;
  newPasswordHash: string;
}): Promise<RedeemResult> {
  const normalized = normalizeRecoveryCode(params.code);
  if (!RECOVERY_CODE_SHAPE.test(normalized)) return { ok: false };

  const codeHash = hashRecoveryCode(normalized);
  const record = await prisma.recoveryCode.findUnique({ where: { codeHash } });
  if (!record) return { ok: false };
  if (record.usedAt) return { ok: false };
  if (record.expiresAt && record.expiresAt < new Date()) return { ok: false };

  // The code must belong to the account being recovered, not merely exist.
  const identifier = params.identifier.trim().toLowerCase();
  const user = await prisma.user.findFirst({
    where: { OR: [{ emailNorm: identifier }, { regNo: params.identifier.trim().toUpperCase() }] },
    select: { id: true, isActive: true },
  });
  if (!user || !user.isActive || user.id !== record.userId) return { ok: false };

  const now = new Date();
  const applied = await prisma.$transaction(async (tx) => {
    const { count } = await tx.recoveryCode.updateMany({
      where: {
        id: record.id,
        userId: user.id,
        usedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: { usedAt: now },
    });
    if (count !== 1) return false;

    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash: params.newPasswordHash,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    // Force re-authentication everywhere.
    await tx.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now },
    });
    return true;
  });

  return applied ? { ok: true, userId: user.id } : { ok: false };
}

export interface RecoveryCodeStatus {
  hasCode: boolean;
  createdAt: Date | null;
  expiresAt: Date | null;
  usedAt: Date | null;
  issuedByAdmin: boolean;
}

/** Metadata only — a code's plaintext is never retrievable after issue. */
export async function getRecoveryCodeStatus(userId: string): Promise<RecoveryCodeStatus> {
  const row = await prisma.recoveryCode.findUnique({
    where: { userId },
    select: { createdAt: true, expiresAt: true, usedAt: true, createdBy: true },
  });
  if (!row) {
    return { hasCode: false, createdAt: null, expiresAt: null, usedAt: null, issuedByAdmin: false };
  }
  return {
    hasCode: true,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    issuedByAdmin: row.createdBy !== null,
  };
}
