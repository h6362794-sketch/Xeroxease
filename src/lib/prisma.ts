import { PrismaClient } from "@prisma/client";
import { assertDatabaseConfig, logDatabaseConfigDiagnostics } from "@/server/db-config";

// Validate configuration at import, but do not crash the module on
// misconfiguration — that would turn every API route into an unhandled
// 500 without a correlation id or safe message. Instead log the problem
// and let withErrorHandling surface a guided 500/503 at request time.
try {
  assertDatabaseConfig({
    databaseUrl: process.env.DATABASE_URL,
    directUrl: process.env.DIRECT_URL,
    nodeEnv: process.env.NODE_ENV,
  });
} catch (err) {
  console.error("[db-config] Startup database check failed:", err instanceof Error ? err.message : err);
}
try {
  logDatabaseConfigDiagnostics({
    databaseUrl: process.env.DATABASE_URL,
    directUrl: process.env.DIRECT_URL,
    nodeEnv: process.env.NODE_ENV,
  });
} catch (err) {
  console.warn("[db-config] Diagnostics failed:", err instanceof Error ? err.message : err);
}

// Singleton to avoid exhausting connections in dev (HMR) and serverless.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
