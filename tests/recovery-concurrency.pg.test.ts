// PostgreSQL-backed concurrency test for recovery-code redemption.
//
// WHY THIS FILE EXISTS
//
// `tests/recovery.test.ts` asserts that "8 concurrent redemptions produce exactly 1
// password change", but it runs against an in-memory JavaScript stand-in for Prisma
// (`vi.mock("@/lib/prisma")`). A JS array has no row locking, no MVCC and no
// independent connections, so `Promise.all` there only proves the application-level
// guard — it cannot demonstrate that the DATABASE serialises two concurrent
// `UPDATE ... WHERE used_at IS NULL` statements.
//
// This test proves the real thing. It opens genuinely independent Prisma clients
// (each with its own connection pool) against a real PostgreSQL 16 instance and
// fires concurrent redemptions of one code.
//
// EXPECTATION: under PostgreSQL's default READ COMMITTED isolation, the second
// UPDATE blocks on the row lock held by the first, then re-evaluates its WHERE
// clause against the newly committed row, finds `used_at IS NOT NULL`, and matches
// 0 rows. Exactly one redemption therefore wins.
//
// SKIP BEHAVIOUR: requires DATABASE_URL. Without it the suite skips rather than
// fails, so `npm test` stays green in environments with no database. CI runs it in
// the `migrations` job, which has a PostgreSQL 16 service container.
//
// SAFETY: creates its own uniquely-suffixed rows and deletes them in afterAll. It
// never touches pre-existing data. Point it only at a disposable database.

import { describe, it, expect, beforeAll, afterAll } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const ENABLED = DATABASE_URL.length > 0;

// `@prisma/client` is imported LAZILY, not at module scope. A top-level import would
// throw "Cannot find module '.prisma/client/default'" in any environment where the
// client has not been generated, which would break `npm test` for everyone even
// though these tests are meant to skip. With a lazy import the file always loads and
// cleanly skips when DATABASE_URL is absent.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

// Number of genuinely independent clients/connections racing for one code.
const RACERS = 8;

// Unique per run so concurrent CI jobs can never collide.
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const EMAIL = `concurrency-${SUFFIX}@xeroxease.test`;
const EMAIL_NORM = EMAIL.toLowerCase();
const REG_NO = `CC${SUFFIX.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 12)}`;

describe.skipIf(!ENABLED)("recovery-code concurrency (real PostgreSQL)", () => {
  let seedClient: AnyClient;
  const racers: AnyClient[] = [];
  let userId: string;
  let code: string;

  beforeAll(async () => {
    const { PrismaClient } = await import("@prisma/client");
    // Each `new PrismaClient()` owns its own connection pool. That independence is
    // the whole point: it is what turns this into a real database race rather than
    // the interleaved-Javascript simulation the mocked unit test performs.
    seedClient = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    for (let i = 0; i < RACERS; i++) {
      racers.push(new PrismaClient({ datasources: { db: { url: DATABASE_URL } } }));
    }

    // --- seed -------------------------------------------------------------
    const user = await seedClient.user.create({
      data: {
        email: EMAIL,
        emailNorm: EMAIL_NORM,
        passwordHash: `concurrency-old-${SUFFIX}`,
        name: "Concurrency Probe",
        regNo: REG_NO,
        isActive: true,
        failedLoginCount: 5,
        lockedUntil: new Date(Date.now() + 60_000), // start locked: redemption must clear it
      },
      select: { id: true },
    });
    userId = user.id;

    // Two live sessions; both must be revoked by a successful redemption.
    await seedClient.session.createMany({
      data: [1, 2].map((n) => ({
        userId,
        tokenHash: `concurrency-session-${n}-${SUFFIX}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      })),
    });

    // Mint a code through the real module so the hashing path is exercised.
    const { generateRecoveryCode, hashRecoveryCode } = await import("@/server/recovery");
    code = generateRecoveryCode();
    await seedClient.recoveryCode.create({
      data: { userId, codeHash: hashRecoveryCode(code) },
    });
  });

  afterAll(async () => {
    try {
      if (userId) {
        await seedClient.recoveryCode.deleteMany({ where: { userId } });
        await seedClient.session.deleteMany({ where: { userId } });
        await seedClient.user.delete({ where: { id: userId } });
      }
    } finally {
      await seedClient?.$disconnect();
      for (const r of racers) await r.$disconnect();
    }
  });

  it("grants exactly one winner across independent connections", async () => {
    const { redeemRecoveryCode } = await import("@/server/recovery");

    // Each racer uses its OWN client -> its own connection pool. This is the
    // critical difference from the mocked unit test, where every call shared one
    // in-memory object.
    const results = await Promise.all(
      racers.map((client, i) =>
        redeemRecoveryCode(
          { identifier: EMAIL, code, newPasswordHash: `concurrency-new-${i}-${SUFFIX}` },
          client
        ).catch((err) => ({ ok: false as const, err }))
      )
    );

    const winners = results.filter((r) => r.ok);
    console.log(
      `    ${RACERS} independent connections raced one code -> ${winners.length} winner(s)`
    );

    // Exactly one redemption succeeded.
    expect(winners.length).toBe(1);

    // ...and no racer threw (a thrown error would mean a real DB failure, not a
    // clean "someone else got there first").
    const threw = results.filter((r) => "err" in r);
    if (threw.length > 0) {
      console.log("    errors:", threw.map((r) => String((r as { err: unknown }).err)));
    }
    expect(threw.length).toBe(0);
  });

  it("changed the password exactly once and cleared the lockout", async () => {
    const user = await seedClient.user.findUniqueOrThrow({ where: { id: userId } });
    // The password is whatever the single winner set.
    expect(user.passwordHash).toMatch(/^concurrency-new-\d+-/);
    expect(user.passwordHash).not.toBe(`concurrency-old-${SUFFIX}`);
    // Lockout cleared as part of the same atomic transaction.
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
    console.log(`    password updated once -> ${user.passwordHash.slice(0, 28)}…`);
    console.log(`    lockout cleared -> failedLoginCount=0 lockedUntil=null`);
  });

  it("marked the code used so it cannot be redeemed again", async () => {
    const row = await seedClient.recoveryCode.findFirstOrThrow({ where: { userId } });
    expect(row.usedAt).not.toBeNull();
    console.log(`    code usedAt=${row.usedAt?.toISOString()}`);

    // A further redemption attempt must fail.
    const { redeemRecoveryCode } = await import("@/server/recovery");
    const again = await redeemRecoveryCode(
      { identifier: EMAIL, code, newPasswordHash: "should-not-apply" },
      racers[0]
    );
    expect(again.ok).toBe(false);
  });

  it("revoked every session for the account", async () => {
    const open = await seedClient.session.count({
      where: { userId, revokedAt: null },
    });
    expect(open).toBe(0);
    const revoked = await seedClient.session.count({ where: { userId } });
    expect(revoked).toBe(2);
    console.log(`    sessions revoked: ${revoked}/2`);
  });
});
