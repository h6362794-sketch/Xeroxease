// Classification of database schema-version skew ("the code is newer than the
// database").
//
// WHY THIS EXISTS
// ---------------
// Prisma's client is compiled from `prisma/schema.prisma`, so it describes the
// schema the *code* expects — not the schema the *database* actually has. When a
// deploy ships ahead of its migration, every query that Prisma cannot narrow to the
// columns that happen to exist fails at the wire protocol:
//
//   PostgreSQL 42703  column "pricing_snapshot" does not exist        -> Prisma P2022
//   PostgreSQL 42P01  relation "orders" does not exist               -> Prisma P2021
//   PostgreSQL 22P02  invalid input value for enum "OrderStatus": …  -> Prisma P2023
//   PostgreSQL 3F000  type "PaymentMethod" does not exist
//
// This is not hypothetical. The 2026-10-20 `/dashboard` incident was exactly this:
// `order.findFirst` issues no `select`, so Prisma reads *every* column its generated
// client knows about, and the production database was two migrations behind. The
// dashboard then threw inside the Server Component render and the browser only got a
// numeric digest, because the instrumentation deliberately logs no message text.
//
// That omission is correct — Prisma messages can embed SQL parameters and student
// data — but it also made the incident hard to attribute. This module recovers the
// one genuinely safe part of the message: the *schema identifier* (column, table,
// enum type or enum label) plus the two error codes. Those are structural metadata,
// never data. Everything else is discarded.
//
// CONTRACT
// --------
//   * Pure and total: never touches I/O, never throws, never logs.
//   * Returns only allowlisted identifiers; free-form message text never escapes.
//   * Unknown/ambiguous shapes return `undefined` rather than a guess.

/** What kind of schema object the database is missing. */
export type SchemaSkewKind =
  | "missing-column"
  | "missing-table"
  | "missing-enum-type"
  | "missing-enum-value";

export interface SchemaSkewDescription {
  kind: SchemaSkewKind;
  /** Prisma error code, when the client supplied one (P2021/P2022/P2023). */
  prismaCode?: string;
  /** PostgreSQL SQLSTATE, when it could be recovered from the message. */
  pgCode?: string;
  /**
   * Sanitised schema identifier, e.g. `orders.pricing_snapshot` or
   * `OrderStatus.DELIVERED`. Never a value, a row id or a SQL parameter.
   */
  object?: string;
}

/**
 * Column/table/type identifiers we are willing to repeat in a log: a plain SQL name,
 * optionally schema-qualified. Deliberately strict — it rejects `@`, `/`, spaces,
 * quotes, newlines and anything else that could smuggle message text, email
 * addresses, URLs or credentials into an operator log.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** Upper bound on any identifier we echo. PostgreSQL's own limit is 63 bytes. */
const MAX_IDENTIFIER_LENGTH = 96;

/** SQLSTATEs that mean "this object is not in the database". */
const KNOWN_PG_CODES = new Set(["42703", "42P01", "22P02", "3F000", "42704"]);

/** Prisma codes that can indicate a code/database version mismatch. */
const PRISMA_CODE_KINDS: Record<string, SchemaSkewKind> = {
  P2021: "missing-table", // "The table ... does not exist in the current database"
  P2022: "missing-column", // "The column ... does not exist in the current database"
};

interface MessageMatch {
  kind: SchemaSkewKind;
  object?: string;
  pgCode: string;
}

/**
 * Message shapes, most specific first.
 *
 * Every capture is bounded and excluded from matching newlines, because a Prisma
 * message can be multi-line and a stack can be forged from a continuation line.
 * Only the first match wins, so one maliciously-crafted message cannot produce a
 * second, different identifier.
 */
const MESSAGE_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  kind: SchemaSkewKind;
  pgCode: string;
  /** Builds the sanitised object from the capture groups. */
  object: (m: RegExpMatchArray) => string | undefined;
}> = [
  // 22P02 — an enum label the database does not have. Both parts are identifiers.
  {
    pattern: /invalid input value for enum\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*:?\s*"?([A-Za-z0-9_]+)"?/i,
    kind: "missing-enum-value",
    pgCode: "22P02",
    object: (m) => `${m[1]}.${m[2]}`,
  },
  // 42703 — column. Prisma quotes it with backticks; PostgreSQL with double quotes.
  {
    pattern: /column\s+`([^`\n]{1,200})`\s+does not exist/i,
    kind: "missing-column",
    pgCode: "42703",
    object: (m) => m[1],
  },
  {
    pattern: /column\s+"([^"\n]{1,200})"\s+does not exist/i,
    kind: "missing-column",
    pgCode: "42703",
    object: (m) => m[1],
  },
  {
    pattern: /column\s+([A-Za-z_][A-Za-z0-9_.]{0,200})\s+does not exist/i,
    kind: "missing-column",
    pgCode: "42703",
    object: (m) => m[1],
  },
  // 42P01 — table.
  {
    pattern: /relation\s+"([^"\n]{1,200})"\s+does not exist/i,
    kind: "missing-table",
    pgCode: "42P01",
    object: (m) => m[1],
  },
  {
    pattern: /relation\s+([A-Za-z_][A-Za-z0-9_.]{0,200})\s+does not exist/i,
    kind: "missing-table",
    pgCode: "42P01",
    object: (m) => m[1],
  },
  // 3F000 — enum *type* itself (e.g. PaymentMethod) was never created.
  {
    pattern: /type\s+"([^"\n]{1,200})"\s+does not exist/i,
    kind: "missing-enum-type",
    pgCode: "3F000",
    object: (m) => m[1],
  },
];

/** Accept a captured identifier only if it looks like a SQL name and is bounded. */
function sanitiseObject(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value || value.length > MAX_IDENTIFIER_LENGTH) return undefined;
  return IDENTIFIER.test(value) ? value : undefined;
}

/** Recover a known SQLSTATE from phrasing like `Code: \`42703\``. */
function pgCodeFromMessage(message: string): string | undefined {
  const match = message.match(/\bcode\b\s*[:=]\s*`?([0-9A-Z]{5})`?/i);
  if (!match) return undefined;
  const code = match[1].toUpperCase();
  return KNOWN_PG_CODES.has(code) ? code : undefined;
}

/**
 * Describe schema skew, or return `undefined` when the error is something else.
 *
 * Safe to call with anything: a non-Error, a thrown string, `null`, or an Error whose
 * message getter throws all yield `undefined` instead of propagating.
 */
export function describeSchemaSkew(error: unknown): SchemaSkewDescription | undefined {
  try {
    if (typeof error !== "object" || error === null) return undefined;

    const record = error as { code?: unknown; message?: unknown };
    const prismaCode =
      typeof record.code === "string" && /^P\d{4}$/.test(record.code) ? record.code : undefined;
    const message = typeof record.message === "string" ? record.message : "";

    for (const candidate of MESSAGE_PATTERNS) {
      const match = message.match(candidate.pattern);
      if (!match) continue;
      const description: SchemaSkewDescription = {
        kind: candidate.kind,
        pgCode: pgCodeFromMessage(message) ?? candidate.pgCode,
      };
      const object = sanitiseObject(candidate.object(match));
      if (object) description.object = object;
      if (prismaCode) description.prismaCode = prismaCode;
      return description;
    }

    // No recognisable message. Fall back to the Prisma code alone, but only for the
    // two codes that unambiguously mean "the database is missing an object".
    // P2023 is deliberately excluded here: it also covers ordinary conversion
    // failures, and guessing would create false schema-drift alarms.
    if (prismaCode && PRISMA_CODE_KINDS[prismaCode]) {
      return { kind: PRISMA_CODE_KINDS[prismaCode], prismaCode };
    }

    return undefined;
  } catch {
    // Diagnostics must never become the incident.
    return undefined;
  }
}

/** Convenience predicate for callers that only need a yes/no answer. */
export function isSchemaSkewError(error: unknown): boolean {
  return describeSchemaSkew(error) !== undefined;
}
