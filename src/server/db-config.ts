// Database connection-string diagnostics.
//
// Pure helpers: no I/O, no secrets. Every function accepts the raw URL as an
// argument and returns only sanitised facts (host, port, parameter names) —
// never the password, and never the full URL, so results can be logged or
// shown in a pre-deploy check without leaking credentials.
//
// Why this exists: Prisma uses PostgreSQL prepared statements. Behind a
// transaction-mode pooler (Supabase Supavisor on port 6543) those statements
// can be routed to a different backend connection than the one they were
// prepared on, which surfaces as `prepared statement "..." does not exist`
// (SQLSTATE 26000). The fix depends on the pooler, so the configuration must
// be *diagnosed*, not blindly rewritten:
//
//   * PgBouncer / Supavisor < 1.21 (no max_prepared_statements support):
//     the pooled URL needs ?pgbouncer=true, which makes Prisma skip named
//     prepared statements.
//   * PgBouncer >= 1.21 / current Supavisor with max_prepared_statements > 0:
//     named statements are pooled correctly, and setting pgbouncer=true is
//     not only unnecessary but can itself cause
//     `prepared statement "PGBOUNCER_..." does not exist` (prisma/prisma#21799).
//
// The runtime URL is therefore left exactly as the operator wrote it; these
// helpers only validate it and explain the trade-offs.

export interface DatabaseUrlInfo {
  /** Normalised scheme, e.g. "postgresql". */
  protocol: string;
  host: string;
  port: number | null;
  database: string;
  sslMode: string | null;
  /** True when the URL already carries ?pgbouncer=true. */
  pgbouncer: boolean;
  /** Explicit ?connection_limit=N, when present. */
  connectionLimit: number | null;
  /** Query-parameter names only (values are never collected). */
  paramKeys: string[];
  hasUsername: boolean;
  hasPassword: boolean;
}

export type ParseDatabaseUrlResult =
  | { ok: true; info: DatabaseUrlInfo }
  | { ok: false; reason: string };

const PLACEHOLDER_MARKERS = ["YOUR_PASSWORD", "YOUR_PROJECT_REF", "CHANGEME", "REPLACE_ME"];

/**
 * Parse a PostgreSQL connection URL without ever returning its credentials.
 * Existing query parameters are preserved in `paramKeys` so operators can see
 * what is already configured before adding anything by hand.
 */
export function parseDatabaseUrl(raw: string): ParseDatabaseUrlResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a parseable URL" };
  }

  const protocol = url.protocol.replace(":", "").toLowerCase();
  if (protocol !== "postgresql" && protocol !== "postgres") {
    return { ok: false, reason: `scheme "${protocol}" is not postgresql://` };
  }

  const params = url.searchParams;
  const paramKeys = Array.from(params.keys()).sort();
  const sslMode = params.get("sslmode");

  const connectionLimitRaw = params.get("connection_limit");
  const connectionLimit =
    connectionLimitRaw !== null && /^\d+$/.test(connectionLimitRaw)
      ? Number(connectionLimitRaw)
      : null;

  return {
    ok: true,
    info: {
      protocol,
      host: url.hostname,
      port: url.port ? Number(url.port) : null,
      database: url.pathname.replace(/^\//, ""),
      sslMode: sslMode ? sslMode.toLowerCase() : null,
      pgbouncer: params.get("pgbouncer") === "true",
      connectionLimit,
      paramKeys,
      hasUsername: url.username.length > 0,
      hasPassword: url.password.length > 0,
    },
  };
}

export interface DatabaseConfigInput {
  databaseUrl?: string;
  directUrl?: string;
  nodeEnv?: string;
}

export interface DatabaseConfigDiagnostic {
  /** Must be fixed before the app serves traffic. */
  errors: string[];
  /** Informational; the app may still run, but the operator should read them. */
  warnings: string[];
}

const POOLER_TRANSACTION_PORT = 6543;
const POSTGRES_DEFAULT_PORT = 5432;

/**
 * Validate the runtime database configuration. Never includes connection
 * strings, hosts-with-credentials or any secret in its output.
 */
export function diagnoseDatabaseConfig(input: DatabaseConfigInput): DatabaseConfigDiagnostic {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { databaseUrl, directUrl, nodeEnv } = input;

  if (!databaseUrl || databaseUrl.trim() === "") {
    errors.push("DATABASE_URL is not set.");
    return { errors, warnings };
  }

  const parsed = parseDatabaseUrl(databaseUrl);
  if (!parsed.ok) {
    errors.push(`DATABASE_URL is invalid: ${parsed.reason}.`);
    return { errors, warnings };
  }
  const info = parsed.info;

  // Case-insensitive, restoring the behaviour of the check this module
  // replaced (the old scripts/check-env.ts matched placeholders with a
  // /i regex). Only these exact marker strings are matched — a real
  // credential that merely resembles a word (e.g. "yourPass123") is
  // never rejected.
  const databaseUrlUpper = databaseUrl.toUpperCase();
  for (const marker of PLACEHOLDER_MARKERS) {
    if (databaseUrlUpper.includes(marker)) {
      errors.push(`DATABASE_URL still contains the placeholder "${marker}". Replace it with real values.`);
      break;
    }
  }
  if (!info.hasPassword) {
    warnings.push("DATABASE_URL has no password component; hosted PostgreSQL services reject passwordless connections.");
  }

  // Transaction-mode pooler detection (Supabase Supavisor uses 6543).
  if (info.port === POOLER_TRANSACTION_PORT) {
    if (info.pgbouncer) {
      warnings.push(
        "DATABASE_URL uses the transaction-mode pooler (port 6543) with pgbouncer=true. " +
          "That flag is only needed for poolers without named-prepared-statement support " +
          "(PgBouncer < 1.21). On PgBouncer >= 1.21 / current Supavisor it is unnecessary and can itself " +
          'produce `prepared statement "PGBOUNCER_..." does not exist` errors — remove it there.'
      );
    } else {
      warnings.push(
        "DATABASE_URL uses the transaction-mode pooler (port 6543) without pgbouncer=true. " +
          "Prisma uses prepared statements, which need pooler support (PgBouncer >= 1.21 with " +
          "max_prepared_statements > 0, as on current Supabase). If you see `prepared statement " +
          '"..." does not exist` (SQLSTATE 26000), either add ?pgbouncer=true (older poolers only) ' +
          "or switch DATABASE_URL to the session pooler / direct connection (port 5432)."
      );
    }
  }

  if (info.connectionLimit === 1) {
    warnings.push(
      "DATABASE_URL sets connection_limit=1. That serialises every query through this process's " +
        "singleton Prisma client; it only makes sense for per-request serverless clients. Raise it " +
        "(or drop it) unless a platform constraint requires 1."
    );
  }

  if (directUrl !== undefined && directUrl.trim() !== "") {
    const direct = parseDatabaseUrl(directUrl);
    if (!direct.ok) {
      warnings.push(`DIRECT_URL is invalid: ${direct.reason}. Migrations need it.`);
    } else {
      if (direct.info.port === POOLER_TRANSACTION_PORT) {
        warnings.push(
          "DIRECT_URL points at the transaction-mode pooler (port 6543). Migrations use advisory locks " +
            "and must run over a direct or session connection (port 5432)."
        );
      }
      if (direct.info.pgbouncer) {
        warnings.push("DIRECT_URL carries pgbouncer=true; migrations should use a direct connection without it.");
      }
    }
  } else {
    warnings.push(
      "DIRECT_URL is not set. The runtime works without it, but `prisma migrate deploy` needs a direct " +
        "connection and will fail without it."
    );
  }

  if (nodeEnv === "production" && info.protocol === "postgres") {
    warnings.push('DATABASE_URL uses the "postgres://" scheme; prefer "postgresql://" for new deployments.');
  }

  return { errors, warnings };
}

/**
 * Fail fast on invalid database configuration. Throws an Error whose message
 * names the variable and the problem — never the URL itself.
 */
export function assertDatabaseConfig(input: DatabaseConfigInput): void {
  const { errors } = diagnoseDatabaseConfig(input);
  if (errors.length > 0) {
    throw new Error(`Database configuration error: ${errors.join(" ")}`);
  }
}

/**
 * Print sanitised startup diagnostics (warnings only; errors are the caller's
 * to fail on). Safe to call at boot: nothing that could contain a credential
 * is ever printed.
 */
export function logDatabaseConfigDiagnostics(input: DatabaseConfigInput): void {
  const { warnings } = diagnoseDatabaseConfig(input);
  for (const warning of warnings) {
    console.warn(`[db-config] ${warning}`);
  }
}
