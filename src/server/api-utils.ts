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

/** Errors the application raises deliberately; `status` is trusted for 4xx only. */
interface HttpErrorLike {
  status?: number;
  message?: string;
}

/**
 * Wraps a handler with safe error handling. Never leaks internals in production.
 *
 * Client-safe statuses: any 4xx the handler raises explicitly (validation,
 * ownership, state-machine conflicts) is surfaced with its real message so the UI
 * can act on it. 5xx and unexpected errors are replaced with a generic message and
 * logged server-side under a correlation id.
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

    const id = randomUUID();
    console.error("[api]", { requestId: id }, err);
    return apiError(GENERIC_ERROR, 500, "INTERNAL_ERROR");
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
  const hops = env.TRUSTED_PROXY_COUNT;
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
  const ip = getClientIp(req);
  const key = identity ? `${scope}:${identity}:${ip}` : `${scope}:${ip}`;
  const r = await rateLimitAsync(key, bucket.limit, bucket.windowMs);
  if (!r.ok) {
    return NextResponse.json(
      { error: `Too many requests. Please try again in ${r.retryAfterSec}s.` },
      { status: 429, headers: { "Retry-After": String(r.retryAfterSec) } }
    );
  }
  return null;
}

/**
 * Read and JSON-parse a request body **exactly once**.
 *
 * A `Request` body is a one-shot stream: after `req.json()` the body is
 * disturbed and any further read — including `req.clone()`, which undici
 * refuses with a synchronous `TypeError: unusable` — fails. Handlers that need
 * both a validated subset and extra raw fields (`fileIds`, …) must read the
 * body once through this helper and derive everything else from that single
 * parsed value.
 */
export async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { status: 400 });
  }
}

export async function parseBody<T>(req: Request, schema: ZodSchema<T>): Promise<T> {
  return schema.parse(await parseJsonBody(req));
}
