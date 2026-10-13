import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "crypto";

/**
 * Password-reset token lifecycle.
 *
 * Previously the token was looked up, validated, and then marked used in a separate
 * statement, so two concurrent redemptions could both succeed. These tests pin the
 * atomic behaviour: valid, expired, malformed, reused and concurrently consumed.
 */

type Row = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
};

let tokens: Row[] = [];
let sessions: { userId: string; revokedAt: Date | null }[] = [];
let userPasswordHash = "old-hash";
let idSeq = 0;
const locks = new Map<string, Promise<unknown>>();

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function tx() {
  return {
    passwordResetToken: {
      updateMany: (args: {
        where: { id?: string; userId?: string; usedAt: null; expiresAt?: { gt: Date } };
        data: { usedAt?: Date; expiresAt?: Date };
      }) => {
        const key = args.where.id ?? `user:${args.where.userId}`;
        const prior = locks.get(key) ?? Promise.resolve();
        const run = prior.then(async () => {
          let matched = 0;
          for (const row of tokens) {
            if (args.where.id && row.id !== args.where.id) continue;
            if (args.where.userId && row.userId !== args.where.userId) continue;
            if (args.where.usedAt === null && row.usedAt !== null) continue;
            if (args.where.expiresAt?.gt && !(row.expiresAt > args.where.expiresAt.gt)) continue;
            if (args.data.usedAt !== undefined) row.usedAt = args.data.usedAt;
            if (args.data.expiresAt !== undefined) row.expiresAt = args.data.expiresAt;
            matched++;
          }
          return { count: matched };
        });
        locks.set(key, run.catch(() => undefined));
        return run;
      },
      create: async (args: { data: { userId: string; tokenHash: string; expiresAt: Date } }) => {
        // `usedAt` is nullable with no Prisma default; mirror the DB column default.
        const row: Row = { id: `t${++idSeq}`, usedAt: null, ...args.data };
        tokens.push(row);
        return row;
      },
    },
    user: {
      update: async (args: { where: { id: string }; data: { passwordHash: string } }) => {
        userPasswordHash = args.data.passwordHash;
        return { id: args.where.id };
      },
    },
    session: {
      updateMany: async (args: { where: { userId: string; revokedAt: null }; data: { revokedAt: Date } }) => {
        let n = 0;
        for (const s of sessions) {
          if (s.userId === args.where.userId && s.revokedAt === null) {
            s.revokedAt = args.data.revokedAt;
            n++;
          }
        }
        return { count: n };
      },
    },
  };
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordResetToken: {
      findUnique: async (args: { where: { tokenHash: string } }) =>
        tokens.find((t) => t.tokenHash === args.where.tokenHash) ?? null,
      updateMany: (args: any) => tx().passwordResetToken.updateMany(args),
      create: (args: any) => tx().passwordResetToken.create(args),
    },
    $transaction: (fn: (t: ReturnType<typeof tx>) => Promise<unknown>) => fn(tx()),
  },
}));

let tokenSeq = 0;
vi.mock("@/server/auth", () => ({
  newToken: (n: number) => `tok-${++tokenSeq}-${"x".repeat(n)}`,
  sha256,
}));

let reset: typeof import("@/server/password-reset");

beforeEach(async () => {
  tokens = [];
  sessions = [{ userId: "user-1", revokedAt: null }];
  userPasswordHash = "old-hash";
  idSeq = 0;
  tokenSeq = 0;
  locks.clear();
  vi.resetModules();
  reset = await import("@/server/password-reset");
});

describe("password reset tokens", () => {
  it("stores only the token hash", async () => {
    const token = await reset.issuePasswordResetToken("user-1");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].tokenHash).toBe(sha256(token));
    expect(tokens[0].tokenHash).not.toBe(token);
  });

  it("expires previously issued unused tokens", async () => {
    const first = await reset.issuePasswordResetToken("user-1");
    await reset.issuePasswordResetToken("user-1");
    const firstRow = tokens.find((t) => t.tokenHash === sha256(first))!;
    expect(firstRow.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("redeems a valid token, rotates the password and revokes sessions", async () => {
    const token = await reset.issuePasswordResetToken("user-1");
    const res = await reset.redeemPasswordResetToken(token, "new-hash");
    expect(res.ok).toBe(true);
    expect(userPasswordHash).toBe("new-hash");
    expect(sessions[0].revokedAt).not.toBeNull();
  });

  it("is single-use under concurrent redemption", async () => {
    const token = await reset.issuePasswordResetToken("user-1");
    const results = await Promise.all(
      Array.from({ length: 6 }, () => reset.redeemPasswordResetToken(token, "new-hash"))
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("rejects a reused token after a successful reset", async () => {
    const token = await reset.issuePasswordResetToken("user-1");
    expect((await reset.redeemPasswordResetToken(token, "new-hash")).ok).toBe(true);
    expect((await reset.redeemPasswordResetToken(token, "again")).ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const token = await reset.issuePasswordResetToken("user-1");
    tokens[0].expiresAt = new Date(Date.now() - 1_000);
    expect((await reset.redeemPasswordResetToken(token, "new-hash")).ok).toBe(false);
    expect(userPasswordHash).toBe("old-hash");
  });

  it("rejects a malformed or unknown token", async () => {
    expect((await reset.redeemPasswordResetToken("", "new-hash")).ok).toBe(false);
    expect((await reset.redeemPasswordResetToken("nope", "new-hash")).ok).toBe(false);
  });

  it("invalidates other outstanding tokens once one is redeemed", async () => {
    const a = await reset.issuePasswordResetToken("user-1");
    const b = await reset.issuePasswordResetToken("user-1");
    // `a` was expired by issuing `b`; prove redemption of the older one fails.
    expect((await reset.redeemPasswordResetToken(a, "hash-a")).ok).toBe(false);
    expect((await reset.redeemPasswordResetToken(b, "hash-b")).ok).toBe(true);
  });
});
