// Deploy-time readiness: does the *target database* have every migration that this
// checkout commits?
//
// WHY THIS EXISTS
// ---------------
// `scripts/verify-migrations.ts` (`npm run schema:check`) compares `schema.prisma`
// with the committed SQL, and the CI `migrations` job replays them against a
// throwaway Postgres. Neither one looks at the database the deploy is about to use —
// and Vercel's build is `prisma generate && next build`, which never runs
// `prisma migrate deploy`. So there is no point in the pipeline at which
// "the code I am shipping" is compared with "the schema my database actually has".
//
// That gap is exactly what broke `/dashboard` on 2026-10-20: migrations
// 20261020000000 and 20261020000100 existed in the repository, CI replayed them
// happily against an empty database, the Vercel build succeeded — and production was
// still two migrations behind, so the first `orders` read raised PostgreSQL 42703
// (Prisma P2022).
//
// This module is the pure half: a total, I/O-free comparison so the rule can be
// unit-tested. `scripts/check-schema-ready.ts` is the thin adapter that reads the two
// lists (committed directory names, and `_prisma_migrations`) and applies it.

export interface MigrationReadiness {
  /** True only when nothing is pending and nothing is unrecognised. */
  ok: boolean;
  /** Committed migrations the database has not recorded as applied. */
  pending: string[];
  /**
   * Migrations the database recorded that this checkout does not contain.
   *
   * This is not cosmetic. It means the database belongs to a *different* version of
   * the application (an older checkout pointed at a newer database, or a completely
   * different project). Deploying then would run new code against a schema it does
   * not understand, so it is treated as a failure, not a warning.
   */
  unknownApplied: string[];
}

/**
 * Trim, drop blanks and de-duplicate while preserving first-seen order, so the report
 * is stable and a repeated directory name cannot inflate the comparison.
 */
export function normaliseMigrationNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Compare committed migrations with those the database reports as applied.
 *
 * Order-insensitive: Prisma records a name per applied migration and applies them in
 * lexicographic order, so the set is what matters. Lexicographic ordering of the
 * committed list is the migrator's job, not this check's.
 */
export function compareMigrations(
  committed: readonly string[],
  applied: readonly string[]
): MigrationReadiness {
  const expected = normaliseMigrationNames(committed);
  const actual = normaliseMigrationNames(applied);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  const pending = expected.filter((name) => !actualSet.has(name));
  const unknownApplied = actual.filter((name) => !expectedSet.has(name));

  return { ok: pending.length === 0 && unknownApplied.length === 0, pending, unknownApplied };
}

/**
 * Render a report that names migrations only.
 *
 * Deliberately contains no connection string, host, database name, user or password:
 * this output is meant to be pasted into a release ticket or a chat thread.
 */
export function formatReadinessReport(
  readiness: MigrationReadiness,
  committedCount: number
): string {
  const lines: string[] = [];

  if (readiness.ok) {
    lines.push(
      `Schema readiness OK — the database has applied all ${committedCount} committed migration(s).`
    );
    return lines.join("\n");
  }

  lines.push(
    `Schema readiness FAILED — the database does not match the ${committedCount} migration(s) in this checkout.`
  );

  if (readiness.pending.length > 0) {
    lines.push("", `Pending (committed here, not applied in the database): ${readiness.pending.length}`);
    for (const name of readiness.pending) lines.push(`  - ${name}`);
    lines.push(
      "",
      "The application reads columns and enum values these migrations create, so any",
      "page or endpoint that touches them will fail until they are applied.",
      "Apply them with `npx prisma migrate deploy` against the intended target, then",
      "re-run this check."
    );
  }

  if (readiness.unknownApplied.length > 0) {
    lines.push("", `Unrecognised (applied in the database, absent from this checkout): ${readiness.unknownApplied.length}`);
    for (const name of readiness.unknownApplied) lines.push(`  - ${name}`);
    lines.push(
      "",
      "The database has migrations this checkout does not contain. This is usually the",
      "wrong database, or a checkout older than the deployed schema. Do not deploy",
      "against it: confirm the target and the branch before proceeding."
    );
  }

  return lines.join("\n");
}
