import { NextResponse } from "next/server";
import { ZodError, type ZodSchema } from "zod";
import { rateLimit } from "./rate-limit";

export function json<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function apiError(message: string, status = 400, code?: string) {
  return NextResponse.json({ error: message, code }, { status });
}

const GENERIC_ERROR = "Something went wrong. Please try again.";

/** Wraps a handler with safe error handling. Never leaks internals in production. */
export function withErrorHandling(
  handler: () => Promise<Response>
): Promise<Response> {
  return handler().catch((err: unknown) => {
    const status = (err as { status?: number }).status;
    const knownMessages = ["UNAUTHENTICATED", "FORBIDDEN"];
    if (status === 401) return apiError("Please sign in to continue.", 401, "UNAUTHENTICATED");
    if (status === 403) return apiError("You do not have permission to perform this action.", 403, "FORBIDDEN");
    if (err instanceof ZodError) {
      const first = err.errors[0];
      return apiError(first?.message || "Invalid input.", 422, "VALIDATION_ERROR");
    }
    console.error("[api]", err);
    if (knownMessages.includes((err as Error).message)) {
      return apiError("Something went wrong. Please try again.", 500);
    }
    return apiError(GENERIC_ERROR, 500);
  });
}

export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

export function enforceRateLimit(
  req: Request,
  bucket: { limit: number; windowMs: number },
  scope: string
): NextResponse | null {
  const ip = getClientIp(req);
  const r = rateLimit(`${scope}:${ip}`, bucket.limit, bucket.windowMs);
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
