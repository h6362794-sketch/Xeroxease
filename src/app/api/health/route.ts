import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { json, withErrorHandling } from "@/server/api-utils";
import { compareMigrations } from "@/server/schema-readiness";

const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");

function committedMigrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Lightweight health check — verifies the database is reachable AND that all
 * committed Prisma migrations have completed on the target schema so health
 * monitoring never reports healthy while the database schema is behind the
 * deployed build.
 *
 * Never leaks connection strings, migration names, SQL, or table data: on
 * success it returns `{ ok: true }`, and on schema skew or transient failure
 * it returns a safe `503` with a correlation `requestId`.
 */
export async function GET() {
  return withErrorHandling(async () => {
    const appliedRows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL
        AND rolled_back_at IS NULL
    `;

    const committed = committedMigrationNames();
    const readiness = compareMigrations(
      committed,
      appliedRows.map((row) => row.migration_name)
    );

    if (!readiness.ok) {
      const requestId = randomUUID();
      console.error("[health][schema-skew]", {
        requestId,
        pendingCount: readiness.pending.length,
        unknownAppliedCount: readiness.unknownApplied.length,
      });
      return NextResponse.json(
        {
          ok: false,
          error: "Service is updating. Please try again in a moment.",
          code: "SCHEMA_OUTDATED",
          requestId,
        },
        {
          status: 503,
          headers: { "Retry-After": "10", "x-request-id": requestId },
        }
      );
    }

    return json({ ok: true, timestamp: new Date().toISOString() });
  });
}

export const dynamic = "force-dynamic";
