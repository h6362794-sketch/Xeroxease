// Database connection-string diagnostics.
//
// Pure helpers: no I/O, no secrets. Every function accepts the raw URL as an
// argument and returns only sanitised facts (host, port, parameter names) —
// never the password, and never the full URL, so results can be logged or
// shown in a pre-deploy check without leaking credentials.
//
// Why this exists: Prisma uses named PostgreSQL prepared statements. A
// transaction-mode pooler hands each transaction a different backend
// connection, so a statement prepared on one backend is not visible on the
// next, which surfaces as `prepared statement "..." does not exist` /
// `already exists` (SQLSTATE 26000 / 42P05). The right setting depends on the
// pooler, so the configuration must be *diagnosed*, not blindly rewritten:
//
//   * Supabase shared pooler, transaction mode (port 6543): Supavisor does not
//     support prepared statements in this mode, so Prisma needs
//     ?pgbouncer=true, which makes it skip them. This is the documented
//     setting for Supabase + Prisma and must be kept on that endpoint.
//   * PgBouncer >= 1.21 with max_prepared_statements > 0: the pooler can track
//     named statements itself, so ?pgbouncer=true merely disables a feature
//     that would work.
//   * Direct / session connections (port 5432): prepared statements work;
//     ?pgbouncer=true only turns them off.
//
// The pooler implementation and version cannot be inferred from a URL, so the
// rules below are deliberately conservative: on the transaction-mode port the
// flag is expected (and its absence is warned about), and on any other port
// its presence is warned about. The URL is never rewritten here; these helpers
// only validate it and explain the trade-offs.

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
  //
  // Do NOT warn about pgbouncer=true here. On this endpoint it is the
  // documented, required Prisma setting: Supavisor in transaction mode does not
  // support prepared statements, and Prisma prepares every query by default.
  // Suggesting its removal is what produces intermittent 26000/42P05 errors.
  if (info.port === POOLER_TRANSACTION_PORT) {
    if (!info.pgbouncer) {
      warnings.push(
        "DATABASE_URL uses the transaction-mode pooler (port 6543) without pgbouncer=true. " +
          "Transaction pooling does not preserve session state, so Prisma's named prepared " +
          "statements cannot be reused across transactions and queries fail with `prepared " +
          'statement "..." does not exist` (SQLSTATE 26000) or `already exists` (SQLSTATE 42P05). ' +
          "Append ?pgbouncer=true — the documented Prisma setting for Supabase transaction mode — " +
          "or point DATABASE_URL at the session pooler / direct connection (port 5432)."
      );
    }
  } else if (info.pgbouncer) {
    warnings.push(
      "DATABASE_URL sets pgbouncer=true but is not on the transaction-mode pooler port (6543). " +
        "The flag disables Prisma's named prepared statements; it is only needed behind a " +
        "transaction-mode pooler. On a direct or session connection (port 5432) it needlessly " +
        "slows queries down — remove it there."
    );
  }

  if (info.connectionLimit === 1) {
    warnings.push(
      "DATABASE_URL sets connection_limit=1. A singleton Prisma client then owns exactly one " +
        "pooled connection, so every concurrent query in a request queues behind it; a waiter that " +
        "is not served within pool_timeout (default 10 s) fails with P2024 `Timed out fetching a " +
        "new connection from the connection pool`. Routes that fire many queries at once (e.g. the " +
        "admin analytics dashboard) are the first to hit this. Raise it (3–5 is a common serverless " +
        "value) or drop it, unless the platform genuinely requires 1."
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
