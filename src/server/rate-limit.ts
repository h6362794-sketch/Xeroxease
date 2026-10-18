// Rate limiting.
//
// The in-memory store only protects a single process. Serverless/multi-instance
// deployments run many isolated processes, so an attacker can multiply the effective
// limit by the number of instances. Set RATE_LIMIT_STORAGE=redis (with
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) to share counters across
// instances; it degrades to the in-memory store in development when unconfigured.

import { env } from "./env";

type Bucket = { count: number; resetAt: number };

const store = new Map<string, Bucket>();

let lastSweep = Date.now();
function sweep() {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, v] of store) {
    if (v.resetAt < now) store.delete(k);
  }
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

// ---------- Redis (HTTP) store ----------

const REDIS_TIMEOUT_MS = 2_000;

/**
 * Any failure of the shared store: HTTP status, transport, a malformed reply, or an error for
 * any single command. The message never includes the response body.
 */
class RateLimitStoreError extends Error {}

/**
 * Runs commands as one Upstash transaction (POST {base}/multi-exec, a JSON array of commands).
 *
 * The supported endpoint is /multi-exec. A bare POST of nested arrays to the database root is
 * not a supported request form, and /pipeline is not atomic. Upstash reports a per-command
 * failure inside an HTTP 200 as an element with `error`, and reports a discarded transaction as a
 * single `{ error }` object. Both are treated as failures here, so they never read as a count of
 * zero. Throws RateLimitStoreError on any failure; the caller decides fail-open or fail-closed.
 */
async function redisTransaction(commands: Array<Array<string | number>>): Promise<unknown[]> {
  const base = env.UPSTASH_REDIS_REST_URL.replace(/\/+$/, "");
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  let res: Response;
  try {
    res = await fetch(`${base}/multi-exec`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    });
  } catch {
    throw new RateLimitStoreError("transport failure reaching the shared store");
  }
  if (!res.ok) throw new RateLimitStoreError(`shared store returned HTTP ${res.status}`);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new RateLimitStoreError("shared store reply was not JSON");
  }
  if (!Array.isArray(body) || body.length !== commands.length) {
    throw new RateLimitStoreError("shared store reply had an unexpected shape");
  }
  for (const item of body as unknown[]) {
    if (typeof item !== "object" || item === null || "error" in item || !("result" in item)) {
      throw new RateLimitStoreError("shared store reported a failed command");
    }
  }
  return (body as Array<{ result: unknown }>).map((item) => item.result);
}

/**
 * Atomic INCR + EXPIRE NX + TTL in one transaction, so the counter and its TTL are always
 * set together (a non-atomic pair can leave a key without a TTL, a permanent block).
 */
async function redisIncrement(key: string, windowSec: number): Promise<{ count: number; ttl: number }> {
  const [incr, , ttlReply] = await redisTransaction([
    ["INCR", key],
    ["EXPIRE", key, windowSec, "NX"],
    ["TTL", key],
  ]);
  const count = Number(incr);
  if (!Number.isFinite(count)) throw new RateLimitStoreError("shared store returned a non-numeric count");
  const ttl = Number(ttlReply);
  return { count, ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : windowSec };
}

// ---------- Public API ----------

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  if (env.RATE_LIMIT_STORAGE === "redis") {
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
      // Misconfigured shared store: fail closed so the misconfiguration does not
      // silently disable abuse protection (unless the operator opted out).
      if (env.RATE_LIMIT_FAIL_OPEN) {
        console.error("[rate-limit] RATE_LIMIT_STORAGE=redis but Upstash credentials are missing; failing open by configuration.");
        return { ok: true, remaining: limit, retryAfterSec: 0 };
      }
      console.error("[rate-limit] RATE_LIMIT_STORAGE=redis but Upstash credentials are missing; failing closed.");
      return { ok: false, remaining: 0, retryAfterSec: Math.ceil(windowMs / 1000) };
    }
    throw new Error("Use rateLimitAsync when RATE_LIMIT_STORAGE=redis");
  }
  return memoryRateLimit(key, limit, windowMs);
}

function memoryRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  sweep();
  const now = Date.now();
  const b = store.get(key);
  if (!b || b.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterSec: 0 };
  }
  b.count++;
  if (b.count > limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSec: Math.ceil((b.resetAt - now) / 1000),
    };
  }
  return { ok: true, remaining: limit - b.count, retryAfterSec: 0 };
}

/**
 * Async variant used by request handlers. Callers should await this so the shared
 * Redis store is used when configured.
 */
export async function rateLimitAsync(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  if (env.RATE_LIMIT_STORAGE !== "redis") {
    return memoryRateLimit(key, limit, windowMs);
  }
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    if (env.RATE_LIMIT_FAIL_OPEN) {
      console.error("[rate-limit] shared store configured but credentials missing; failing open by configuration.");
      return { ok: true, remaining: limit, retryAfterSec: 0 };
    }
    console.error("[rate-limit] shared store configured but credentials missing; failing closed.");
    return { ok: false, remaining: 0, retryAfterSec: Math.ceil(windowMs / 1000) };
  }

  try {
    const windowSec = Math.max(1, Math.ceil(windowMs / 1000));
    const { count, ttl } = await redisIncrement(`xe:rl:${key}`, windowSec);
    if (count > limit) {
      return { ok: false, remaining: 0, retryAfterSec: ttl };
    }
    return { ok: true, remaining: Math.max(0, limit - count), retryAfterSec: 0 };
  } catch (err) {
    // Store outage, refusal, or bad reply. Fail closed by default so a broken limiter never
    // turns into an open authentication endpoint. Only the error class and message are logged.
    const reason = err instanceof RateLimitStoreError ? err.message : "unexpected error";
    console.error("[rate-limit] store error:", reason);
    if (env.RATE_LIMIT_FAIL_OPEN) {
      return { ok: true, remaining: limit, retryAfterSec: 0 };
    }
    return { ok: false, remaining: 0, retryAfterSec: Math.ceil(windowMs / 1000) };
  }
}

export const RATE_LIMITS = {
  login: { limit: 10, windowMs: 5 * 60_000 },
  register: { limit: 5, windowMs: 60 * 60_000 },
  // Recovery-code redemption: the code space is 160 bits, so this limit is about
  // stopping online guessing and stopping one attacker from burning through many
  // accounts' codes, not about the code space being small.
  recoveryReset: { limit: 5, windowMs: 15 * 60_000 },
  // Generating a code re-hashes the password; cap it so a stolen session cannot
  // churn codes and thereby invalidate the code the real owner stored.
  recoveryGenerate: { limit: 5, windowMs: 60 * 60_000 },
  // Admin-assisted issuance is a sensitive, audited action.
  adminRecoveryCode: { limit: 20, windowMs: 60 * 60_000 },
  upload: { limit: 30, windowMs: 10 * 60_000 },
  // Direct uploads: intent issuance mints one signed URL per document, completion is
  // one verification per document. Both are cheap but must not be enumerable, so the
  // budgets sit just above what the 10-file order flow can legitimately use.
  uploadIntent: { limit: 40, windowMs: 10 * 60_000 },
  uploadComplete: { limit: 40, windowMs: 10 * 60_000 },
  // Per-user budget for obtaining a short-lived read URL.
  download: { limit: 120, windowMs: 10 * 60_000 },
  analyze: { limit: 60, windowMs: 10 * 60_000 },
  paymentSubmit: { limit: 10, windowMs: 10 * 60_000 },
  feedback: { limit: 10, windowMs: 60 * 60_000 },
  admin: { limit: 120, windowMs: 60_000 },
  publicApi: { limit: 60, windowMs: 60_000 },
  orderCreate: { limit: 20, windowMs: 60 * 60_000 },
  cancel: { limit: 10, windowMs: 60 * 60_000 },
} as const;
