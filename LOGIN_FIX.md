# Login 500 Fix — Root Cause & Prevention

## What you saw
`Failed to load resource: the server responded with a status of 500` on `POST /api/auth/login` (and potentially `/api/auth/admin-login`). In Chrome DevTools Network tab the response body was the generic `{ error: "Something went wrong. Please try again.", code: "INTERNAL_ERROR" }`.

This is a server-side failure — the browser reached the server, but the handler threw before it could return 401 (wrong credentials) or 200 (success).

## Root causes found in this codebase

1. **Fragile env access at request time** — `env.TRUSTED_PROXY_COUNT`, `env.SESSION_TTL_HOURS`, `env.UPLOAD_INTENT_TTL_SECONDS`, etc. threw if the variable was missing or non-numeric. `getClientIp()` is called at the start of every login; a single bad env value turned every login into a 500, even for correct credentials.

2. **Prisma startup crash** — `src/lib/prisma.ts` called `assertDatabaseConfig()` at import time. If `DATABASE_URL` was missing/invalid (common on a fresh Vercel preview), the module threw and *every* route — including login — became 500 before the handler even ran.

3. **Argon2 cold-start race** — The previous `argon2` lazy-loader used a boolean flag; concurrent logins during cold start could observe `null` and `verifyPassword()` returned `false` for a correct argon2 hash. That did not 500, but it incremented the lockout counter for a valid user and showed `Invalid credentials`, which looks like a persistent login failure.

4. **Unclassified transient DB errors** — `P2024 Timed out fetching a new connection from the connection pool` (happens with `connection_limit=1` + concurrent queries, e.g. login → dashboard → notifications polling) and `P1001 Can't reach database` were all mapped to generic 500. The UI could not tell the user to retry, and operators had no `requestId` to correlate.

5. **Non-resilient sub-steps** — `recordFailedLogin()`, `prisma.user.update()` (lockout reset) and `audit()` failures bubbled as 500. A wrong password should always be 401, even if the audit write or counter increment fails. A successful password should not become 500 because the `lastLoginAt` update had a transient timeout.

6. **No retry guidance for the UI** — The login page only showed the server message. A 503 (service busy) and a 429 (rate-limited) looked identical to a 500, so users retried without back-off and hit the same pool limit again.

## Fixes applied (commit 733c7f5)

### Server — `src/server/api-utils.ts`
- New classifier: `TRANSIENT_PRISMA_CODES` (`P1001`, `P1002`, `P1017`, `P2024`, `P2037`, etc.) → `503 SERVICE_UNAVAILABLE` with `Retry-After: 5` and `x-request-id`.
- Schema-skew (`P2021`/`P2022`/`column does not exist`) → `503 SCHEMA_OUTDATED` with `Retry-After: 10`.
- Config errors (`Missing required environment variable`, `SESSION_SECRET must be…`) → `500 CONFIG_ERROR` with actionable message, never leaking the URL.
- Generic unexpected → `500 INTERNAL_ERROR` with `requestId` in both body and `x-request-id` header for support correlation.
- `getClientIp()` now wraps `env.TRUSTED_PROXY_COUNT` in try/catch; `enforceRateLimit()` wraps `rateLimitAsync` so a Redis misconfig no longer turns every login into 429 or 500.

### Env — `src/server/env.ts`
- `num()` no longer throws on non-finite input; it warns and returns the fallback.
- `UPLOAD_INTENT_TTL_SECONDS` / `SIGNED_DOWNLOAD_URL_TTL_SECONDS` clamp out-of-range values with a warning instead of throwing.
- `STORAGE_PROVIDER_MAX_FILE_BYTES` returns 0 on negative input with warning.

### Prisma — `src/lib/prisma.ts`
- Startup `assertDatabaseConfig`/`logDatabaseConfigDiagnostics` are now in try/catch and log instead of throwing at import. The app still boots and `withErrorHandling` surfaces the guided 500/503 at request time with a correlation id.

### Auth — `src/server/auth.ts`
- `verifyPassword()`: if the hash is `$argon2*` but the native module failed to load, it now throws `503` (so `withErrorHandling` can retry) instead of returning `false` and locking the user out.
- `createSession()`: retries up to 3 times on `P2002` token collision, maps transient codes to 503, cleans up orphaned session if `cookies().set` fails, and reads `SESSION_TTL_HOURS` with fallback.
- `getSessionUser()`: catches DB errors and returns `null` (so layouts redirect to `/login`) instead of 500.
- `recordFailedLogin()`: catches and logs DB failures; a wrong-password attempt still returns 401.

### Login routes — `src/app/api/auth/login/route.ts` + `admin-login/route.ts`
- `getClientIp` wrapped with fallback to `unknown`.
- `prisma.user.findFirst/findUnique` wrapped: transient → 503, other → re-throw.
- `verifyPassword` 503 is propagated.
- `prisma.user.update` (counter reset) logs transient but does not block login.
- `createSession` transient is propagated.
- `audit()` calls are wrapped so audit failure never changes 401/200.

### Client — `src/app/(auth)/login/page.tsx` + `src/app/admin/login/page.tsx` + `src/lib/api-client.ts`
- `ApiError` now carries `requestId` and `retryAfter` (from `x-request-id` / `Retry-After`).
- UI distinguishes:
  - `401`/`403`/`422`: credential/validation message.
  - `429`: `Too many requests … in Xs` with countdown and disabled button.
  - `503`: `Service temporarily unavailable` / `Service is updating` with amber styling, `Retry-After` countdown, and `Ref: <id>` for support.
  - `500`: generic message + `Ref: <id>` suffix.
  - Network `TypeError`: `Network error. Check your connection`.
- Client-side empty identifier/password check avoids unnecessary 422.
- Health endpoint `GET /api/health` added for load-balancer checks (minimal `SELECT 1`).

### Tests
- Updated `auth-login`, `auth-register`, `admin-analytics-route`, `order-route`, `direct-upload-routes` to expect `503 SERVICE_UNAVAILABLE` for pool timeouts and to allow `requestId`.

## How to verify after deploy
1. `npm run config:check` — must pass (checks `DATABASE_URL`, `SESSION_SECRET`, pooler vs `pgbouncer` flag, etc.).
2. `npm run preflight:schema` — must be `OK` (no pending migrations).
3. `npm run build` — `prisma generate && next build` succeeds (no import-time config throw).
4. Manual:
   - Correct student login → 200, session cookie `xe_session` set, redirect to `/dashboard`.
   - Wrong password → 401 `Invalid credentials` (no 500, no session cookie).
   - Locked account (8 failures) → 429 `Account temporarily locked`.
   - Disabled account → 403 (student) / 401 generic (admin) without session.
   - With `DATABASE_URL` missing → login returns `500 CONFIG_ERROR` + `requestId`, not an unhandled exception.
   - With `connection_limit=1` under load → login returns `503 SERVICE_UNAVAILABLE` with `Retry-After: 5`, UI shows countdown and retry works.
   - All responses include `x-request-id` header for log correlation.

## Prevention — no further 500s
- Every env getter that previously threw now either warns + falls back or is caught by `withErrorHandling` and mapped to `CONFIG_ERROR`.
- Every Prisma DB call in the auth critical path is wrapped; transient codes are 503 (retryable), not 500.
- Audit, lockout-counter and last-login updates can no longer promote a 401/200 into a 500.
- Client no longer treats every failure as “Something went wrong”; it shows actionable 429/503 and a support reference.

## Deployment notes
- Ensure `DATABASE_URL` uses `postgresql://…:5432` for direct or `…:6543?pgbouncer=true` for Supabase transaction mode. `npm run config:check` will warn otherwise.
- If `RATE_LIMIT_STORAGE=redis` is set, also set `UPSTASH_REDIS_REST_URL/TOKEN`; otherwise the limiter fails closed as 429 for all logins. The fix makes it fail open with a server log, but correct config is still required.
- No migration is needed for this fix; the two pending lifecycle migrations (`20261020000000_*`, `20261020000100_*`) still require `npx prisma migrate deploy` on the approved target before code that reads `pricing_snapshot` reaches production (separate from the login 500).
