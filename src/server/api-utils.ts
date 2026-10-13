import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { ZodError, type ZodSchema } from "zod";
import { rateLimitAsync } from "./rate-limit";

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

export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
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

export async function parseBody<T>(req: Request, schema: ZodSchema<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { status: 400 });
  }
  return schema.parse(body);
}
