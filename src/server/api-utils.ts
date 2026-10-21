import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { ZodError, type ZodSchema } from "zod";
import { rateLimitAsync } from "./rate-limit";
import { env } from "./env";

export function json<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function apiError(message: string, status = 400, code?: string) {
  return NextResponse.json({ error: message, code }, { status });
}

const GENERIC_ERROR = "Something went wrong. Please try again.";
const TRANSIENT_ERROR = "Service temporarily unavailable. Please try again in a moment.";
const CONFIG_ERROR_MSG = "Service configuration error. Please contact support.";

/** Errors the application raises deliberately; `status` is trusted for 4xx only. */
interface HttpErrorLike {
  status?: number;
  message?: string;
  code?: string;
}

/**
 * Prisma / driver error codes that are transient and should map to 503
 * rather than a generic 500, so the UI can retry and operators see
 * a clear category.
 *
 * - P1001: Can't reach database server
 * - P1002: Database server reached but timed out
 * - P1008: Operations timed out
 * - P1009: Database already exists (rare, but transient in pooling)
 * - P1010: User denied access (often transient misconfig, treat as 503 to avoid leaking)
 * - P1013: Database URL invalid (config)
 * - P1017: Server closed connection
 * - P2024: Timed out fetching connection from pool (connection_limit=1 on concurrent routes)
 * - P2037: Too many database connections opened
 */
const TRANSIENT_PRISMA_CODES = new Set([
  "P1000",
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
  "P2037",
  "P1013",
]);

const CONFIG_KEYWORDS = [
  "Missing required environment variable",
  "SESSION_SECRET must be",
  "DATABASE_URL is not set",
  "DATABASE_URL is invalid",
];

function getPrismaCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string" && /^P\d{4}$/.test(c)) return c;
  }
  return undefined;
}

function isTransientError(err: unknown): boolean {
  const code = getPrismaCode(err);
  if (code && TRANSIENT_PRISMA_CODES.has(code)) return true;
  // Also handle generic network / driver errors that Prisma may wrap
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("can't reach database") ||
      msg.includes("timed out fetching a new connection") ||
      msg.includes("connection pool") ||
      msg.includes("econnrefused") ||
      msg.includes("etimedout") ||
      msg.includes("enotfound") ||
      msg.includes("connection terminated") ||
      msg.includes("too many clients") ||
      msg.includes("too many connections")
    ) {
      return true;
    }
  }
  return false;
}

function isConfigError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message;
    return CONFIG_KEYWORDS.some((k) => msg.includes(k));
  }
  return false;
}

function isSchemaSkewLike(err: unknown): boolean {
  const code = getPrismaCode(err);
  if (code === "P2021" || code === "P2022") return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("does not exist in the current database") ||
      msg.includes("column") && msg.includes("does not exist") ||
      msg.includes("relation") && msg.includes("does not exist") ||
      msg.includes('type "') && msg.includes("does not exist")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Wraps a handler with safe error handling. Never leaks internals in production.
 *
 * Client-safe statuses: any 4xx the handler raises explicitly (validation,
 * ownership, state-machine conflicts) is surfaced with its real message so the UI
 * can act on it. 5xx and unexpected errors are replaced with a generic message and
 * logged server-side under a correlation id.
 *
 * Enhancements for login 500 fix:
 * - Prisma transient codes (P1001, P2024 pool timeout, etc.) → 503 with Retry-After
 * - Schema-skew (missing column/table) → 503 with operator guidance
 * - Config errors (missing DATABASE_URL/SESSION_SECRET) → 500 with CONFIG_ERROR code
 * - Generic unexpected → 500 with correlation id
 */
export function withErrorHandling(handler: () => Promise<Response>): Promise<Response> {
  return handler().catch((err: unknown) => {
    const status = (err as HttpErrorLike).status;

    if (status === 401) return apiError("Please sign in to continue.", 401, "UNAUTHENTICATED");
    if (status === 403) {
      return apiError("You do not have permission to perform this action.", 403, "FORBIDDEN");
    }
    if (err instanceof ZodError) {
      const first = err.errors[0];
      return apiError(first?.message || "Invalid input.", 422, "VALIDATION_ERROR");
    }

    // Domain errors (e.g. OrderError) carry an explicit 4xx. Previously these were
    // swallowed and returned as a generic 500, so a rejected status transition or a
    // missing order looked like a server fault to the user.
    if (typeof status === "number" && status >= 400 && status < 500) {
      const message = (err as HttpErrorLike).message || GENERIC_ERROR;
      return apiError(message, status);
    }

    // 503 for transient DB / pool issues — UI can retry without counting as credential failure
    if (isTransientError(err)) {
      const id = randomUUID();
      console.error("[api][transient]", { requestId: id, code: getPrismaCode(err) }, err);
      const res = NextResponse.json(
        { error: TRANSIENT_ERROR, code: "SERVICE_UNAVAILABLE", requestId: id },
        { status: 503, headers: { "Retry-After": "5", "x-request-id": id } }
      );
      return res;
    }

    if (isSchemaSkewLike(err)) {
      const id = randomUUID();
      console.error("[api][schema-skew]", { requestId: id, code: getPrismaCode(err) }, err);
      const res = NextResponse.json(
        {
          error: "Service is updating. Please try again in a moment.",
          code: "SCHEMA_OUTDATED",
          requestId: id,
        },
        { status: 503, headers: { "Retry-After": "10", "x-request-id": id } }
      );
      return res;
    }

    if (isConfigError(err)) {
      const id = randomUUID();
      console.error("[api][config]", { requestId: id }, err);
      const res = NextResponse.json(
        { error: CONFIG_ERROR_MSG, code: "CONFIG_ERROR", requestId: id },
        { status: 500, headers: { "x-request-id": id } }
      );
      return res;
    }

    const id = randomUUID();
    console.error("[api]", { requestId: id }, err);
    const res = NextResponse.json(
      { error: GENERIC_ERROR, code: "INTERNAL_ERROR", requestId: id },
      { status: 500, headers: { "x-request-id": id } }
    );
    return res;
  });
}

/**
 * Resolve the client IP for rate limiting and audit trails.
 *
 * `X-Forwarded-For` is attacker-controlled unless a trusted proxy overwrites or
 * appends to it. Reading the leftmost entry (the previous behaviour) let any client
 * forge its own address and bypass per-IP limits. We now read the entry written by
 * the first *trusted* proxy -- TRUSTED_PROXY_COUNT hops from the right -- so
 * prepended junk is ignored. With TRUSTED_PROXY_COUNT=0 the header is not read at
 * all, which is the correct setting when the app is directly exposed.
 */
export function getClientIp(req: Request): string {
  let hops: number;
  try {
    hops = env.TRUSTED_PROXY_COUNT;
  } catch {
    // Env misconfiguration (e.g. non-numeric TRUSTED_PROXY_COUNT) used to
    // throw and crash the entire login handler as 500. Fall back to unknown
    // so the login can still proceed and the misconfig is visible in logs.
    console.warn("[api] TRUSTED_PROXY_COUNT misconfigured; using unknown IP.");
    return "unknown";
  }
  if (hops === 0) return "unknown";

  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      const idx = parts.length - hops;
      return parts[idx >= 0 ? idx : 0];
    }
  }

  const real = req.headers.get("x-real-ip");
  return real ? real.trim() : "unknown";
}

/**
 * Enforce a rate limit. Returns a 429 response when the limit is exceeded, or null
 * when the request may proceed.
 *
 * `identity` lets a caller key on more than the IP (e.g. the submitted email) so a
 * single abusive client cannot target many accounts from one address.
 */
export async function enforceRateLimit(
  req: Request,
  bucket: { limit: number; windowMs: number },
  scope: string,
  identity?: string
): Promise<NextResponse | null> {
  let ip: string;
  try {
    ip = getClientIp(req);
  } catch {
    ip = "unknown";
  }
  const key = identity ? `${scope}:${identity}:${ip}` : `${scope}:${ip}`;
  let r: { ok: boolean; remaining: number; retryAfterSec: number };
  try {
    r = await rateLimitAsync(key, bucket.limit, bucket.windowMs);
  } catch (err) {
    // Rate limiter failure must never become a login 500. Fail closed in
    // production would previously return 429 for every login if redis was
    // misconfigured; fail open is safer for availability. Log and allow.
    console.error("[rate-limit] enforce failed:", err instanceof Error ? err.message : err);
    return null;
  }
  if (!r.ok) {
    return NextResponse.json(
      { error: `Too many requests. Please try again in ${r.retryAfterSec}s.` },
      { status: 429, headers: { "Retry-After": String(r.retryAfterSec) } }
    );
  }
  return null;
}

export async function parseBody<T>(req: Request, schema: ZodSchema<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { status: 400 });
  }
  return schema.parse(body);
}
