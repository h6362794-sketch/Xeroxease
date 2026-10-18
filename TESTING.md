# XeroxEase — Testing Guide

## Run

```bash
npm test            # full unit suite (Vitest)
npm run test:watch  # watch mode
npm run typecheck   # strict TypeScript
npm run lint        # ESLint (Next.js core-web-vitals)
```

Current suite: **286 tests in 20 files** — 282 pass, 4 skip (the PostgreSQL-only
concurrency file plus its guards, which need a real database). `npm test`.

The suite grew the same way the security surface did: each incident/audit finding that
produced a code change also produced a file that would fail if the change were reverted.
That is why `tests/migration-index.test.ts` and `tests/request-security.test.ts` exist at
all. New tests should follow that rule — a test that cannot fail when the guard is removed
is documentation, not a guard.

## Unit test coverage

| File | Covers |
|---|---|
| `tests/pricing.test.ts` | Price engine: single/double sides, copies, finishing fees, rounding, unknown keys, missing table |
| `tests/page-selection.test.ts` | Custom page ranges: lists, ranges, dedup, out-of-bounds, reversed, injection-style garbage, ALL |
| `tests/file-validation.test.ts` | Upload security: traversal stripping, control chars, double extensions (exe-renamed-to-pdf), MIME mismatch, **magic-byte spoofing rejection**, size limits, octet-stream handling |
| `tests/order-rules.test.ts` | Status machine: legal transitions, skipped stages, terminal states, unknown states, cancellable windows |
| `tests/collection-token.test.ts` | **QR collection atomicity**: single-use, exactly one of 8 concurrent scans wins, not-ready / unknown / replayed tokens, verify-only never mutates |
  | `tests/recovery.test.ts` | **Recovery-code lifecycle** (30): 160-bit entropy, Crockford alphabet, normalisation, hash-only storage, atomic rotation with rollback, single-use under 8 concurrent redemptions **against a mocked in-memory client**, code-to-account binding, expiry, session revocation, lockout clearing, identical failure responses for every failure mode |
  | `tests/recovery-concurrency.pg.test.ts` | **Recovery-code concurrency against real PostgreSQL** (4): 8 **independent database connections** race for one code; asserts exactly one winner, one password change, the code is spent, and all sessions revoked. Skips when `DATABASE_URL` is unset; CI runs it on PostgreSQL 16. **This — not the mocked test — is what proves the database serialises concurrent redemptions.** |
  | `tests/migration-index.test.ts` | **Schema/migration index drift** (4): `RecoveryCode` must not declare a redundant `@@index` over a `@unique` column; re-introducing that exact drift makes `npm run schema:check` fail. Regression guard for the drift the first CI run caught. |
  | `tests/security-headers.test.ts` | **Security-header middleware** (7): the file lives at `src/middleware.ts` (a root-level `middleware.ts` is silently ignored by Next.js), CSP/HSTS/framing headers are set, HSTS is production-only, and `ALLOW_DEV_FRAME_EMBED` cannot weaken production |
| `tests/request-security.test.ts` | **Request-level security** (14): `getClientIp` reads `TRUSTED_PROXY_COUNT` hops from the right so forged `X-Forwarded-For` prefixes cannot pick a rate-limit bucket; the bounded multipart stream rejects an oversized body even when `Content-Length` lies |
| `tests/doc-analysis.test.ts` | **Analysis accuracy**: authoritative `<Pages>`/slide parts, page-break estimate forced to `NEEDS_REVIEW`, malformed/truncated ZIP safety, legacy `.doc` review state |
| `tests/storage-key.test.ts` | **Storage-key safety**: path traversal, absolute paths, control chars, hidden-file prefixes, per-owner scoping, collision-free keys |
| `tests/order-creation.test.ts` | **Order creation**: a `NEEDS_REVIEW` page count is never priced, IDOR on files rejected, already-attached documents refused, **unverified (`PENDING`) upload rows rejected before pricing**, server-side pricing and page-selection maths |
| `tests/direct-upload-policy.test.ts` | **Direct-upload decision layer** (38): declared-size parsing, 50 MiB boundary inclusive, provider cap precedence and its error text, extension/MIME/double-extension rules, per-order quota, HMAC intent-token mint/verify (rotation, tampering, re-signing, expiry, clamped TTL), row binding (`uploadTokenMatchesRow`), **completion verification** (measured-size equality, signature check, missing object, expired window, already-FAILED refusal, idempotent retry), download authorization + cache-header discipline |
| `tests/direct-upload-service.test.ts` | **Direct-upload service** (31) with Prisma and the storage adapter faked: key minted server-side, row created `PENDING`, only the token *digest* persisted, audit entries free of tokens/keys/signed URLs, quota and order-ownership checks, 501/503 capability refusals, completion writing the **measured** size, forged/mismatched/rotated/expired tokens, object deleted on deterministic rejection, **row kept `PENDING` on storage outage**, guarded `updateMany` race, abort rules, bounded sweep |
| `tests/direct-upload-routes.test.ts` | **HTTP contract** (29): 401 before any work on all six routes, SUPER_ADMIN-only sweep, capability payload leaking no secret/bucket/key, zod 422 vs domain 413/409/410/422, **501 `DIRECT_UPLOAD_UNSUPPORTED` kept visible instead of masked as 500**, provider error text never forwarded, download 307 headers (`no-store`, `no-referrer`, `noindex`, **no `Vary`**, empty body), identical 404 for foreign-vs-missing, `COMPLETED`-only serving, 503 instead of buffering on signing failure, local-backend streaming |
| `tests/direct-upload-client.test.ts` | **Browser side** (23): mode selection that can never dead-end the wizard, pre-flight limits, `isUnsupportedDeployment` (only 501/503 deployment codes fall back to proxy — never 401/409/413/5xx faults), bare PUT with no `Authorization` header, progress clamping, 409-vs-other status mapping, abort semantics (including "never send if already aborted"), and intent release **only** when completion proved the object unusable |
| `tests/pricing-boundaries.test.ts` | Money boundaries: double-side rounding, copies, finishing, missing prices, negative/NaN inputs, fractional rates, maximum copies |
| `tests/auth-login.test.ts` | **Student & admin login routes** (mocked Prisma/auth helpers): valid credentials create the right session kind and reset lockout counters; wrong/unknown credentials get the identical generic 401 with **no session and no `Set-Cookie`**; role separation both ways (admin credentials rejected at `/api/auth/login`, student credentials rejected at `/api/auth/admin-login`); disabled accounts (students 403, admins indistinguishable 401); lockout 429 before any password work, retry after expiry; DB failure → generic 500 without internals; IP rate limit 429 + `Retry-After`; malformed JSON 400; zod 422 |
| `tests/auth-register.test.ts` | **Registration route** (mocked Prisma, real rate limiter): 201 with normalised identifiers and `role: "STUDENT"` regardless of client input; preflight duplicates → field-specific 409s; **the preflight/create race — a `P2002` on insert maps to the same 409, never a 500 or database internals**; unknown `P2002` target → safe generic conflict; validation matrix → 422; malformed JSON → 400; **5/hour rate-limit boundary** against the real in-memory limiter; registration never creates a session |
| `tests/auth-sessions.test.ts` | **Session primitives, real `src/server/auth.ts`** (mocked Prisma + cookie store): tokens stored only as SHA-256; cookie attributes (`HttpOnly`, `SameSite=Lax`, `path=/`, `Secure` in production only, expiry mirrors the session); lookup accepts valid sessions and rejects revoked / expired / unknown / disabled-account sessions; logout revokes server-side and clears the cookie; `requireUser`/`requireRole` 401/403 semantics; real argon2id round-trip, legacy bcrypt verification without rehashing, malformed-hash safety; atomic failed-login counter locks exactly at the threshold and keeps counting after expiry |
| `tests/seed-security.test.ts` | **Seed credential policy** (pure + mocked Prisma): production fails closed without `SEED_ADMIN_PASSWORD` (even with `ALLOW_DEV_SEED=true` — no default, no unrecoverable random password); the published development defaults are rejected as explicitly supplied passwords (too weak); supplied passwords are strength-checked; dev seeding keeps documented defaults; **reseed upserts carry an empty `update` clause so an existing password hash is never overwritten, and the seed never deletes, disables or mutates users**; admin and student hashes never match |
| `tests/db-config.test.ts` | **Database connection diagnostics** (pure, no database): sanitised URL parsing that never returns credentials; placeholder detection; transaction-pooler (6543) warnings with and without `pgbouncer=true`; `connection_limit=1` and `DIRECT_URL` misuse warnings; `assertDatabaseConfig` fails fast with an actionable, secret-free message |

## Security test matrix

The suite directly asserts the security behaviors required by the spec:

- ✅ Manipulated **file type**: executable magic bytes renamed `.pdf` → rejected (`validateUpload`)
- ✅ **Oversized file**: >50 MiB → rejected
- ✅ **Malicious filename**: `../../etc/passwd.pdf`, control chars, `invoice.pdf.exe` → sanitized/rejected
- ✅ **Invalid order status transition**: e.g. `ORDER_PLACED → PRINTING` → not allowed
- ✅ **Terminal states**: COMPLETED/CANCELLED/FAILED cannot transition
- ✅ **Price integrity**: server engine is the only calculator; client input absent from `calculatePrice`
- ✅ **Unverified page counts are never priced**: a `NEEDS_REVIEW` document is rejected at order creation even if it carries an estimate
- ✅ **Unverified documents are never orderable or downloadable**: a direct-upload row stays `PENDING` until the *stored object* is measured and signature-checked; completion with a foreign/rotated/forged token is refused, and `/api/files/:id/download` 404s for anything but `COMPLETED` — for an admin too (`tests/direct-upload-service.test.ts`, `tests/direct-upload-routes.test.ts`, `tests/order-creation.test.ts`)
- ✅ **No credential in a cacheable place**: the completion token is returned in a POST body and hashed at rest; the download redirect carries `no-store` and **no `Vary`**, so no intermediary can cache a signed URL (`tests/direct-upload-routes.test.ts`)
  - ✅ **Single-use QR collection**: 8 concurrent scans of the same code produce exactly 1 fulfilled order *(mocked in-memory client — proves the application guard, not database serialisation)*
  - ✅ **Single-use recovery codes (application logic)**: 8 concurrent redemptions produce exactly 1 password change, against a **mocked in-memory client**
  - ✅ **Single-use recovery codes (database, authoritative)**: 8 **independent PostgreSQL 16 connections** racing one code produce exactly 1 winner, 1 password change, a spent code and revoked sessions — `tests/recovery-concurrency.pg.test.ts`, run in the CI `migrations` job
- ✅ **Recovery codes are hash-only**: no test can find the plaintext in the database, the status payload or an audit entry
- ✅ **Atomic rotation**: if storing the new code fails, the previous code is still redeemable — rotation is never left half-done
- ✅ **Forged `X-Forwarded-For` cannot buy a fresh rate-limit bucket** (verified in unit tests and live against the dev server)
- ✅ **Oversized uploads abort mid-stream**: a 5 MB body against a 1 MB cap is rejected even when `Content-Length` claims 42 bytes
- ✅ **Path traversal in storage keys**: `../../etc/passwd` and absolute paths collapse to a per-user scoped key
- ✅ **Truncated/corrupt Office containers** are handled without throwing or inventing a count

### Manual security checks (require a running app + DB)

These are covered by server-side guards; verify with curl/Postman:

| Check | Expected |
|---|---|
| Student GETs another student's `/api/orders/:id` | 403 |
| Student GETs another student's `/api/files/:id/download` | 403 + `FILE_ACCESS_DENIED` audit |
| Student calls `/api/admin/*` | 403 |
| ADMIN calls Super Admin endpoints (pricing PATCH, users POST, settings) | 403 |
| Student POSTs a fabricated `totalAmount` with order | Ignored — server recalculates |
| Student PATCHes own payment to CONFIRMED | No such endpoint; verify-only via admin |
| Duplicate payment submission | Idempotent response, no duplicate events |
| Duplicate feedback | 409 |
| 9 rapid logins | 429 rate limit; account lockout at threshold |
| Rapid `/api/auth/recovery/reset` calls | 429 on the 6th attempt in 15 min (keyed on IP **and** identifier) |
| Same requests with a forged `X-Forwarded-For` prefix | Still 429 — the prefix is ignored, so the bucket is unchanged |
| `/api/auth/recovery/code` without a session | 401 |
| `/api/admin/users/:id/recovery-code` as ADMIN (not SUPER_ADMIN) | 403 |
| Redeeming an already-used recovery code | 400 `RECOVERY_FAILED`, identical to every other failure |
| Oversized upload (Content-Length > 50 MiB) | 413 before the body is parsed |
| Uploading two `file` parts in one request | 400 (one file per request) |
| `.doc` upload then order | Analysis reports `NEEDS_REVIEW`; order blocked until the student confirms the page count |
| Second scan of a used collection QR | 409 `ALREADY_USED`, order unchanged |
| `.exe` renamed to `.pdf` uploaded | 400 (signature mismatch) |
| Unauthenticated `/dashboard` | Redirect to `/login` (server-side) |

## E2E acceptance walkthrough

Run the full flow from the spec's acceptance list:

1. Register a student → login
2. Upload a PDF → analysis shows page count
3. Configure (A4, B&W, double-side, 2 copies, staple) → review shows estimate
4. Place order → `XE-YYYY-NNNNNN` issued; server total in DB matches rate table
5. Submit payment reference → status UNDER_REVIEW
6. Admin → Payments → Verify → student notified, status PAYMENT_CONFIRMED
7. Admin → Orders → PRINTING → QUALITY_CHECK → READY_FOR_COLLECTION
8. Student → reveal collection code; admin verifies via `/api/admin/collection` → order COMPLETED, code single-use (replay rejected)
9. Student rates the order; duplicate rating blocked
10. Invoice printable from order page


## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and on pull requests:

1. `npm ci` (from the committed lockfile) — this also runs `prisma generate` via `postinstall`
2. `npm run typecheck`
3. `npm run lint`
4. `npm test`
5. `npm run build`
6. `npm audit --audit-level=high` (reported, not blocking)

A second job starts a throwaway PostgreSQL 16 service container and runs
`prisma migrate deploy` + `prisma migrate status` against an empty database. That
catches the failure mode where committed migrations no longer reproduce
`prisma/schema.prisma`, and would have caught this project's missing migration
directory before deployment.

## What is and is not covered

Covered by automated tests: pricing, page selection, file validation, status rules,
collection-token concurrency, recovery-code lifecycle (generation, hashing, rotation
atomicity, single-use concurrency, expiry, binding to an account, session revocation),
client-IP resolution, upload size capping, storage-key safety, document-analysis
states and order-creation rules.

**Not** covered automatically, and still requiring manual verification:

- Real Supabase Storage upload/download/delete (tests mock the storage layer)
- Live HTTP routes that require a database row (sign-in, order creation, payment
  verification, and redeeming a real recovery code end to end) — the sandbox has no
  PostgreSQL, so the Prisma client is stubbed for unit tests and returns empty results
  for live route sweeps. See "Where mocks stand in for real infrastructure" below.
- A real PostgreSQL migration run in this environment (see the audit report)
- Browser/responsive checks and the end-to-end walkthrough above

## Where mocks stand in for real infrastructure

Be clear about what a green test run does and does not prove in this environment.

  | What | Mocked? | Consequence |
  |---|---|---|
  | PostgreSQL / Prisma client (unit tests) | **Yes** — an in-memory stand-in | `tests/recovery.test.ts`, `tests/collection-token.test.ts` and friends run against JavaScript arrays. They prove **application logic only**: they exercise no real SQL, no real constraint, no row locking and no MVCC. A "concurrent" test there interleaves promises over an array — it cannot show that a database serialises anything. |
  | PostgreSQL (integration test) | **No** — real PostgreSQL 16 | `tests/recovery-concurrency.pg.test.ts` opens independent `PrismaClient` instances against a real database. **This is the authoritative concurrency proof.** It skips without `DATABASE_URL`, so it needs CI (or a local Postgres) to actually run. |
  | Migration replay / drift | **No** in CI; N/A locally | `npm run schema:check` is a **text** comparison (tables, columns, indexes, unique constraints) and has previously **passed while real drift existed**. The authoritative check is `prisma migrate diff --exit-code` against PostgreSQL 16 in the CI `migrations` job. Only that replays the SQL. |
  | Supabase Storage | **Yes** | Upload/download/delete against real object storage is unverified. `tests/direct-upload-*.test.ts` fake `src/server/storage.ts`, so what they prove is that **we send the right request and trust only the response**: they do not prove Supabase honours `expiresIn`, rejects an existing object at a signed-upload path, returns `metadata.size` in `/object/info`, or that a signed URL is unreachable without the token. Those four properties are the load-bearing assumptions of the whole protocol (see `UPLOADS.md` §8.1) and can only be checked against a real bucket. |
  | Google Fonts at build time | **Yes** in this sandbox (`NEXT_FONT_GOOGLE_MOCKED_RESPONSES`) | The real build needs egress to `fonts.googleapis.com`. CI has normal network access, so the CI build is **not** mocked. |
  | Redis/Upstash rate limiting | No (in-memory in tests) | Shared-counter behaviour across instances is unverified; only the failure modes (fail-closed by default, fail-open on explicit opt-in) are covered. |
  | Email | **N/A** | The app sends no email at all. |

  ### Do not call these "validated" on local evidence alone

  - **`npm run schema:check` passing does NOT mean migrations are validated.** It parses
    `schema.prisma` and the migration SQL as *text*. It cannot verify types, precision,
    defaults, nullability, constraint names, foreign keys, enums or index methods. Only
    `prisma migrate diff --exit-code` against a real database can.
  - **A mocked "concurrent redemption" test does NOT prove database safety.** See the
    PostgreSQL integration test above for what does.

  The Prisma **type** surface used by `tsc` in this sandbox is generated by a gitignored
  scaffold (`.data/gen-prisma-scaffold.cjs`) because `prisma generate` cannot download its
  binaries here. It is never committed and is **not** evidence that the real client works —
  and because it is more permissive than the generated client, `tsc` passing locally does
  **not** guarantee `tsc` passes in CI. The `OrderNumberClient` type error (caught only by
  the first real CI run) is exactly that failure mode: the scaffold accepted a
  hand-written structural delegate type that real Prisma correctly rejects.
  Always treat CI's typecheck as authoritative.
