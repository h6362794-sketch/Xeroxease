import { PrismaClient } from "@prisma/client";
import { assertDatabaseConfig, logDatabaseConfigDiagnostics } from "@/server/db-config";

// Fail fast on a broken database configuration before any query runs,
// and log sanitised diagnostics (never the connection string itself).
// Both helpers are pure string checks, so they are safe at module load.
assertDatabaseConfig({
  databaseUrl: process.env.DATABASE_URL,
  directUrl: process.env.DIRECT_URL,
  nodeEnv: process.env.NODE_ENV,
});
logDatabaseConfigDiagnostics({
  databaseUrl: process.env.DATABASE_URL,
  directUrl: process.env.DIRECT_URL,
  nodeEnv: process.env.NODE_ENV,
});

// Singleton to avoid exhausting connections in dev (HMR) and serverless.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
