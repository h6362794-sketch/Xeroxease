// Simple in-memory sliding-window rate limiter.
// For multi-instance deployments, swap the store for Redis (see SECURITY.md).

type Bucket = { count: number; resetAt: number };

const store = new Map<string, Bucket>();

// periodic cleanup to avoid unbounded growth
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

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
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

export const RATE_LIMITS = {
  login: { limit: 10, windowMs: 5 * 60_000 },
  register: { limit: 5, windowMs: 60 * 60_000 },
  forgotPassword: { limit: 3, windowMs: 15 * 60_000 },
  upload: { limit: 30, windowMs: 10 * 60_000 },
  analyze: { limit: 60, windowMs: 10 * 60_000 },
  paymentSubmit: { limit: 10, windowMs: 10 * 60_000 },
  feedback: { limit: 10, windowMs: 60 * 60_000 },
  admin: { limit: 120, windowMs: 60_000 },
  publicApi: { limit: 60, windowMs: 60_000 },
  orderCreate: { limit: 20, windowMs: 60 * 60_000 },
  cancel: { limit: 10, windowMs: 60 * 60_000 },
} as const;
