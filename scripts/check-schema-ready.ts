/**
 * Release pre-flight: does the TARGET DATABASE have every migration this checkout
 * commits?
 *
 * WHAT IT DOES
 *   Reads the committed migration directory names from `prisma/migrations`, reads the
 *   ones the database records in `_prisma_migrations`, and fails if they disagree.
 *
 * READ-ONLY
 *   Issues a single `SELECT` and nothing else. It never runs a migration, never writes
 *   a row, never creates a table, and never touches application data. Applying
 *   migrations remains a deliberate, separately-authorised operator action
 *   (`npx prisma migrate deploy`).
 *
 * WHAT IT PRINTS
 *   Migration names and counts only. It never prints DATABASE_URL, its host, database
 *   name, user, password or query parameters, and it never prints row data. The report
 *   is safe to paste into a release ticket.
 *
 * WHY IT IS NEEDED
 *   `npm run schema:check` compares `schema.prisma` against committed SQL, and CI
 *   replays migrations against an empty database, but neither one inspects the database
 *   a deploy will actually use. Vercel's build (`prisma generate && next build`) never
 *   runs `prisma migrate deploy`, so code can — and did, on 2026-10-20 — reach
 *   production ahead of its schema. See `src/server/schema-readiness.ts`.
 *
 * USAGE
 *   npm run preflight:schema          # against $DATABASE_URL
 *   EXIT 0 = ready, 1 = not ready, 2 = could not determine (treat as not ready)
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { compareMigrations, formatReadinessReport } from "../src/server/schema-readiness";
import { describeSchemaSkew } from "../src/server/schema-skew";

const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");

/** Directory names only: `prisma/migrations/migration_lock.toml` is skipped. */
function committedMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Sanitised one-line description of a failure.
 *
 * A driver error's message can embed the connection string, so the message is only
 * surfaced for the two cases where it is provably structural (a missing table or a
 * missing column, whose text we already reduce to an identifier). Anything else is
 * reported by class name and error code only.
 */
function describeFailure(error: unknown): string {
  const skew = describeSchemaSkew(error);
  if (skew) {
    return `database schema skew (${skew.kind}${skew.object ? `: ${skew.object}` : ""}${
      skew.pgCode ? `, SQLSTATE ${skew.pgCode}` : ""
    })`;
  }
  const code = (error as { code?: unknown } | null)?.code;
  const name = error instanceof Error ? error.name : typeof error;
  return `${name}${typeof code === "string" && /^[A-Z0-9]{4,6}$/.test(code) ? ` (code ${code})` : ""}`;
}

async function main(): Promise<number> {
  let committed: string[];
  try {
    committed = committedMigrations();
  } catch {
    console.error(`[preflight:schema] Could not read ${MIGRATIONS_DIR}. Run from the repository root.`);
    return 2;
  }

  if (committed.length === 0) {
    console.error("[preflight:schema] No committed migrations found. Refusing to report readiness.");
    return 2;
  }

  // Minimal structural view of the client we use. It keeps this script independent of
  // the generated types (which is what makes it runnable before generation) while
  // still type-checking against the real client at the call site.
  interface RawClient {
    $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
    $disconnect: () => Promise<void>;
  }

  let prisma: RawClient;
  try {
    const mod = (await import("@prisma/client")) as unknown as {
      PrismaClient: new (options?: unknown) => RawClient;
    };
    prisma = new mod.PrismaClient({ log: [] });
  } catch {
    console.error(
      "[preflight:schema] Prisma Client is not generated. Run `npx prisma generate` first."
    );
    return 2;
  }

  let applied: string[] = [];
  try {
    const rows = (await prisma.$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `) as Array<{ migration_name?: unknown }>;

    applied = rows
      .map((row) => (typeof row?.migration_name === "string" ? row.migration_name : ""))
      .filter(Boolean);
  } catch (error) {
    const skew = describeSchemaSkew(error);
    // `_prisma_migrations` itself missing means migrations have never been applied
    // here. That is a *readiness* answer (nothing applied), not an execution failure.
    // Accept an optional schema qualifier (`public._prisma_migrations`).
    if (skew?.kind === "missing-table" && skew.object?.endsWith("_prisma_migrations")) {
      applied = [];
    } else {
      console.error(`[preflight:schema] Could not read migration history: ${describeFailure(error)}.`);
      console.error("[preflight:schema] Readiness is unknown; treat as NOT ready.");
      // `finally` below still disconnects.
      return 2;
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }

  const readiness = compareMigrations(committed, applied);
  const report = formatReadinessReport(readiness, committed.length);
  if (readiness.ok) {
    console.log(`[preflight:schema] ${report}`);
    return 0;
  }
  console.error(`[preflight:schema] ${report}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch(() => {
    // Never let an unexpected throw print a stack that could include a connection
    // string from the driver.
    console.error("[preflight:schema] Unexpected failure; readiness unknown. Treat as NOT ready.");
    process.exit(2);
  });
