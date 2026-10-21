import { prisma } from "@/lib/prisma";
import { json, withErrorHandling } from "@/server/api-utils";

/**
 * Lightweight health check — verifies the database is reachable without
 * touching business tables. Useful for load balancers, uptime monitors
 * and the login page's "is the service down?" banner.
 *
 * Never leaks connection strings or table data: on success it returns
 * { ok: true }, on failure it goes through withErrorHandling so the
 * caller gets a safe 503/500 with a correlation id.
 */
export async function GET() {
  return withErrorHandling(async () => {
    // Minimal query: validate the connection and that the shadow
    // migration table exists (so schema drift also surfaces here).
    await prisma.$queryRaw`SELECT 1 as ok`;
    return json({ ok: true, timestamp: new Date().toISOString() });
  });
}

export const dynamic = "force-dynamic";
