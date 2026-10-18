# XeroxEase — Security Documentation

Security is a first-class requirement, prioritized above visual effects and convenience. This document describes the security architecture, the threat model it addresses, and — honestly — the risks that remain the operator's responsibility after deployment. **No system is 100% secure.**

---

## 1. Threat model (OWASP-aligned)

| Threat | Mitigation |
|---|---|
| SQL injection | Prisma ORM with parameterized queries exclusively; no raw SQL string building |
| XSS | React auto-escaping; no `dangerouslySetInnerHTML` on user data; strict CSP; invoice HTML escapes all dynamic values |
| CSRF | `SameSite=Lax` HTTP-only session cookies; JSON-only APIs with `Content-Type` enforcement; state-changing endpoints require the session cookie (cross-site form posts cannot set JSON headers) |
| SSRF | No server-side URL fetching of user input |
| IDOR / BOLA | Every order/file/invoice/payment request verifies `userId` ownership or privileged role **server-side**; sequential order numbers are never an authorization key |
| Broken access control | RBAC checks (`requireUser` / `requireRole`) at every protected endpoint; admin pages server-guarded in layouts, not just client-side |
| Auth attacks | Argon2id hashing, per-IP rate limits, per-account lockout (8 student / 5 admin failures → 15-min lock), generic "Invalid credentials" (no enumeration), timing-safe comparisons |
| Session hijacking | 256-bit random tokens, stored only as SHA-256 hashes, HTTP-only + SameSite + Secure (prod) cookies, server-side expiry/revocation, revocation on password reset and account disable |
| Brute force / credential stuffing | Rate limiting + lockout + audit logging of failures |
| Rate abuse | Per-endpoint sliding-window limits (login, register, upload, analyze, payment, feedback, admin, public, **reset**) with an optional **shared Redis store** (`RATE_LIMIT_STORAGE=redis`) because an in-memory limiter does not protect multi-instance deployments. Store outages **fail closed** unless `RATE_LIMIT_FAIL_OPEN=true` |
| File upload attacks | Extension allow-list, MIME validation, magic-byte signature checks, double-extension rejection, filename sanitization, path-traversal-safe storage keys (server-generated), declared `Content-Length` checked **before** parsing plus an authoritative check on the received bytes, one-file-per-request, 50 MiB cap, orphaned objects cleaned up if the database write fails, private storage |
| Path traversal | Storage keys generated server-side (UUID + random hex); `storagePath()` resolves and validates against base directory |
| MIME spoofing | Magic-byte validation catches renamed executables (tested) |
| Clickjacking | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` |
| Open redirects | No redirect-to-user-supplied-URL functionality |
| Security misconfiguration | Security headers via middleware; `poweredByHeader` off; generic production errors |
| Sensitive data exposure | No card/CVV/UPI-PIN data collected; payment refs stored last-4-only in logs; secrets only in env vars |
| Mass assignment | Zod schemas whitelist exact fields; client never sets role/price/status |
| Parameter pollution | Zod coerces and validates types; unknown keys dropped |
| Replay (collection QR) | Single-use tokens: consumption is a **guarded conditional UPDATE** (`collection_token_used_at IS NULL` + status) inside one transaction, so exactly one of N concurrent scans can complete the order |
| Replay (recovery code) | Redemption is a **guarded conditional UPDATE** (`used_at IS NULL` and expiry not passed) inside one transaction, so exactly one of N concurrent redemptions can win; the password change **and** full session revocation happen in that same transaction |
| Account takeover via a lost recovery code | The code alone is not sufficient — it must be paired with the account identifier, and it is single-use. Stolen session cookies cannot mint a new code: generation requires the **current password** |
| Recovery-code disclosure | Only a SHA-256 hash is stored. The plaintext is returned exactly once and is never logged, and never appears in audit metadata, analytics or error reports |
| Account enumeration via recovery | Every failure mode (no account, no code, wrong, expired, already-used, malformed, disabled) returns one identical response, and the endpoint is rate limited per IP **and** per identifier |
| Rate-limit bypass by IP spoofing | Client IP is taken `TRUSTED_PROXY_COUNT` hops from the **right** of `X-Forwarded-For`, so a client that prepends forged entries cannot choose its own bucket; `TRUSTED_PROXY_COUNT=0` ignores the header entirely |
| Oversized upload exhausting memory | The multipart body is parsed through a stream that errors the moment a hard byte cap is crossed, so a lying `Content-Length` cannot make the server buffer an unbounded payload |
| Storage data loss | `STORAGE_BACKEND=local` is **refused in production** unless `ALLOW_EPHEMERAL_LOCAL_STORAGE=true`, so uploads cannot silently disappear from an ephemeral filesystem while the database still references them |
| Unreliable page counts being priced | Heuristic counts (raw-byte PDF `/Type /Page` counting, DOCX page-break counting) return `NEEDS_REVIEW`, never `COMPLETED`; ordering stays blocked until the student or an administrator confirms the count |

## 2. Authentication model

- **Passwords**: Argon2id (memory-hard) with automatic bcrypt fallback; never logged, never stored plaintext.
- **Sessions**: opaque 256-bit random tokens in HTTP-only cookies; server-side `sessions` table holds only the SHA-256 hash; TTL via `SESSION_TTL_HOURS`; explicit revocation on logout/reset/disable.
- **Account lockout**: progressive counters with temporary lock; all failures audited with IP.
- **Account recovery (email-free)**: a 160-bit single-use **recovery code** the user generates in advance. Only its SHA-256 is stored; the plaintext is shown once and never persisted, logged or audited. Generating one requires the current password and atomically replaces any previous code, so there is never more than one live code per account and a user is never stranded with none. Redemption is atomic (conditional UPDATE), requires the matching identifier, revokes **all** sessions and clears lockout. Self-generated codes do not expire; administrator-issued codes expire in 24 h.
- **Admin-assisted recovery fallback**: for a user with no code, a Super Admin can issue a single-use 24 h code from **Admin → Users** after verifying identity in person. It is audited with a mandatory free-text reason, never reveals or sets a password, and never signs anyone in.
- **No email or SMS in the recovery path.** The app sends no mail at all; there is no `EMAIL_*`/SMTP/SMS configuration and no paid third-party recovery dependency.
- **Admin auth**: separate login endpoint + page (`/admin/login`), stricter lockout, dedicated audit events. **No public admin signup exists anywhere**; admins are provisioned only by Super Admin through the admin console.
- **Registration**: creates the account only — **no session is issued**, so the user must sign in afterwards (the login page says so explicitly). Email, phone and registration number are unique, enforced by the database, and a concurrent duplicate (the preflight/insert race) is answered with the same 409 the preflight returns — never a raw database error.
- **Email verification is not implemented** (and there is no mail transport to implement it with). `users.email_verified` exists for future use; seeded demo accounts are the only rows with it set. Security consequence, stated plainly: email is an identifier, not an authentication factor — it plays no part in login, recovery-code issuance or redemption, so an unverified address cannot be used to take over or recover an account. The unique constraints on email/phone/registration number also prevent registering *as* an existing user. If verified contact channels ever become a requirement, that is a product decision needing a mail provider, not a code tweak.

## 3. Authorization model

- Roles: `STUDENT` < `ADMIN` < `SUPER_ADMIN`, stored server-side, resolved from the session on every request.
- Students: own orders/files/invoices/feedback/notifications only.
- Admins: order management, payment verification, file access for fulfillment, analytics.
- Super Admin: pricing, settings, payment QR, user provisioning/disable, feedback moderation, audit logs.
- Route guards live in **server layouts** (redirect) **and** every API handler (401/403) — the client is never trusted.

## 4. File security model

Two upload transports exist, and the security properties differ, so each is stated separately.

### 4.1 Proxy upload (development, `STORAGE_BACKEND=local`)

`POST /api/uploads` accepts the whole file (bounded stream, `parseBoundedFormData`),
validates extension + declared MIME + magic bytes + size **on the actual bytes**, writes
it, and only then creates the row. Bounded by the platform's request-body limit (4.5 MB
on Vercel), which is why it is not the production path for documents.

### 4.2 Direct upload (production, `STORAGE_BACKEND=supabase`)

Because a function host cannot carry a 50 MB body, the browser writes to storage itself
under an authorization the server mints. The security property that replaces "we saw the
bytes" is "**we re-read the object afterwards and it matches what we authorized**":

- Uploaded documents live in **private storage** only. `local` writes to `.data/uploads`
  outside any web root; `supabase` writes to a single **private** bucket named by
  `STORAGE_BUCKET` (default `documents`). No public bucket, no public object URL, no
  permanent link is ever produced.
- In production, `local` is **refused at write time** (`assertDurableBackend`) unless
  `ALLOW_EPHEMERAL_LOCAL_STORAGE=true`; `config:check` fails the deploy outright. The
  direct protocol is *unsupported* (not downgraded) on `local`: `/api/uploads/intent`
  returns 501 with the reason.
- Storage keys are `sanitizeKeySegment(ownerId)/<timestamp>-<random>-<sanitised name>`:
  no user-controlled path component, no `..`, no absolute paths, no hidden prefixes. The
  key is generated **before** the row exists and the client is never asked to supply one,
  so "guess a key" and "supply your own key" are not inputs at all.
- The upload authorization is bound to exactly **one path**, is time-limited
  (`UPLOAD_INTENT_TTL_SECONDS`, default 600 s), and the provider rejects an existing
  object at that path (no silent overwrite, no `x-upsert`).
- Completion requires an HMAC token bound to `(document row, owner, key, claimed size,
  expiry, nonce)`; the row keeps only `SHA-256(token)` under a **unique** constraint, so a
  token cannot be replayed, swapped for another document, or reused after a new intent.
- Verification reads **measured size** (object metadata) and the **first 16 bytes**
  (signature) from storage. Client claims are never trusted; a mismatch deletes the object
  and fails the row. `status` only reaches `COMPLETED` after that check, and
  `createOrder` selects `status = "COMPLETED"` — an unverified document cannot be ordered,
  priced, printed or downloaded (even by an admin).
- Abandoned/expired intents, unordered documents and retained order documents are cleaned
  up by `POST /api/admin/uploads/sweep` (SUPER_ADMIN session or the `CRON_SECRET` bearer for
  a scheduler). The app has **no scheduler**, so until something calls it, un-reaped rows and
  their objects persist.
- `maxSize`/MIME are **not** enforceable inside a Supabase signed upload URL, so the
  bucket's own file-size/MIME settings are defence in depth, not the primary control.

### 4.3 Downloads

`GET /api/files/:id/download` authorizes from the **database row** (owner or ADMIN/
SUPER_ADMIN), returns an identical 404 for "not yours" and "does not exist", refuses
non-`COMPLETED` rows, then either redirects (307) to a short-lived signed URL
(`supabase`) or streams (`local`). Redirect responses are `Cache-Control: private,
no-store, must-revalidate` + `no-referrer` + `noindex`, and carry **no `Vary`** — a cached
redirect would cache the credential. Rate limited per user. There are **no permanent
public URLs**; a signed URL is a 60-second bearer token, so it must never be logged,
stored or embedded (see `UPLOADS.md` §3).

### 4.4 Still not implemented

- Filenames are sanitized for display; storage names are server-generated.
- **No malware scanning.** `ENABLE_MALWARE_SCAN` is a flag with no code behind it; wiring a
  vendor into the upload pipeline is an open item. No scan is claimed anywhere, and a
  passing signature check is not a safety claim about file contents.

## 5. AI/document-processing security

- Analysis runs **server-side** on stored bytes (pdf-lib for PDF; ZIP central-directory + `docProps/app.xml` for DOCX/PPTX).
- Authoritative sources are used where they exist: pdf-lib's page tree for PDFs and `ppt/slides/slideN.xml` part counting for PPTX. `docProps/app.xml` (`<Pages>`/`<Slides>`) is used as a secondary source.
- Heuristic sources are returned as **estimates with `NEEDS_REVIEW`**, never as verified counts: raw-byte `/Type /Page` counting for PDFs that cannot be parsed, and rendered/explicit page-break counting for DOCX with no stored page count.
- Legacy OLE2 `.doc`/`.ppt` cannot be parsed reliably and always return `NEEDS_REVIEW`.
- `NEEDS_REVIEW` is not a dead end: the document owner can confirm the count (`PATCH /api/documents/:id/pagecount` → `USER_CONFIRMED`), and administrators can correct it (`PATCH /api/admin/orders/:id/files/:fileId/pagecount` → `ADMIN_VERIFIED`). Both are audited.
- Order creation rejects any document that is not `COMPLETED`, so an estimate can never be priced.
- Pricing uses only server-verified counts and is computed exclusively in `src/server/pricing.ts`. Client-side estimates are display-only and the client never submits a price.

## 6. QR payment security

- The QR image is a **display asset only**; scanning it does not confirm anything.
- Payment states advance only through authorized flows: student submits a reference → admin verifies/rejects. Students can never self-confirm.
- All payment-state changes are transactional, transition-validated, and audited (`payment_events` + `audit_logs`).
- Anti-abuse: duplicate-submission protection, reference validation, per-IP limits, last-4-only in logs.
- If a real payment provider is added later, plug it in at the verify step — the order model does not need redesign.

## 7. Secrets management

- All secrets via environment variables (`.env.local`, gitignored; `.env.example` documents placeholders).
- `SESSION_SECRET` signs **collection tokens and direct-upload intent tokens**. Rotating it invalidates outstanding collection codes (acceptable, they're re-issued per order) *and* every in-flight upload intent, whose browser will then fail completion — so rotate when no uploads are in progress, or expect users to retry.
- The one-time completion credential returned by `/api/uploads/intent` is a bearer token. It is never written to the database (only its SHA-256 digest), never placed in a URL, and never included in audit metadata, error bodies or logs.
- The Supabase **service-role key must never** be exposed to the client or committed. It is used server-side only, including to mint the browser's signed upload/download URLs — the browser receives the *resulting short-lived URL*, never the key. No `NEXT_PUBLIC_*` value reaches a client bundle in this app; the anon key is unused (see `.env.example`) and the browser is only ever given the storage URL from the intent response.

## 8. Logging & monitoring

- Structured server logs: endpoint, status, error category; unhandled API errors are logged with a generated `requestId` for correlation. Deliberate 4xx errors (validation, ownership, state conflicts) are returned to the client with their real message; unexpected errors are replaced with a generic message so internals are never leaked.
- Security events (login failures, denied file access, privileged actions) additionally in `audit_logs`.
- **Never logged**: passwords, tokens, API keys, UPI PINs, banking credentials, document contents.
- Audit log records: actor, action, target, metadata, IP, timestamp — written best-effort (audit failure never breaks request flow) and viewable by Super Admin.

## 9. Incident response

1. Contain: disable the affected account(s) (Super Admin → Users) or rotate `SESSION_SECRET` to invalidate all sessions/collection codes.
2. Assess: review `/admin/audit-logs` and server logs for scope.
3. Remediate: patch, rotate credentials (database password, service-role key), redeploy.
4. Notify affected users if their data was involved; document the timeline.

## 10. Backup strategy

- Supabase managed backups (verify schedule under Database → Backups) or scheduled `pg_dump`.
- Storage bucket sync for uploaded documents. Document deletion follows the policy in DATABASE.md ("Data retention"): 24 hours for unordered uploads, `retentionDays` after an order ends. Deletion is a scheduled job, not instant, and a bucket snapshot can still hold deleted objects until the snapshot ages out.
- Reconciliation: `payment_events` against bank/UPI statements.

## 11. Residual risks and operator responsibilities

Honest list — these remain after deploying this codebase. **11.1 is the operative
checklist** (things the code cannot enforce); 11.2 is what is simply not built yet.

### 11.1 Not fixable by application code

1. **`TRUSTED_PROXY_COUNT` must match your deployment.** Client IP is read `TRUSTED_PROXY_COUNT` hops from the right of `X-Forwarded-For`, which is only correct if exactly that many trusted proxies sit in front of the app (Vercel: 1). Getting it wrong does more than mis-attribute IPs: too high a value reads a client-forged entry and lets an attacker pick their own rate-limit bucket; too low a value buckets every client behind the proxy together. Set it deliberately and re-check after any infrastructure change.
2. **Recovery codes are bearer credentials.** Anyone holding a user's code *and* their identifier can take over the account. The code is single-use and never emailed, but it is only as safe as wherever the user stored it. Encourage a password manager, and treat a report of a lost code as an incident.
3. **The admin-assisted fallback depends on human identity verification.** The code cannot enforce it — an administrator who issues a code without checking ID defeats the control. Every issuance is audited with a mandatory reason; review `RECOVERY_CODE_ADMIN_ISSUED` entries.
4. **Rate limiting is per-IP (and per-user where an identity exists).** Users behind one NAT share a bucket; a determined distributed attack is not stopped by these limits alone. Use the shared Redis store and consider a WAF.
5. **`next/font/google` requires build-time network access.** The build fetches Inter from Google Fonts. In an air-gapped or egress-restricted CI runner the build fails; either allow egress to `fonts.googleapis.com` or self-host the font. `prisma generate` needs `binaries.prisma.sh` at build/install time for the same reason.
6. **Reverse-proxy and function body limits.** The app rejects oversized uploads, but the platform must be configured to match. On a function host the ceiling is both ways — Vercel allows 4.5 MB per **request body and per response body** — which is why document bytes now travel browser ↔ storage and `GET /api/files/:id/download` answers with a 307 to a short-lived signed URL instead of streaming through the function. Self-hosted nginx needs `client_max_body_size` ≥ the limit you advertise. A deployment that re-routes downloads back through the app re-introduces the exact failure this exists to avoid.
7. **Bucket-level limits are defence in depth, not the control.** A Supabase signed upload URL cannot carry `maxSize`/MIME restrictions, so the bucket's global file-size limit (Supabase Free: 50 MB) is what actually caps the *provider* side. Set it deliberately and mirror it in `STORAGE_PROVIDER_MAX_FILE_BYTES`; leaving them inconsistent only produces confusing 413s, it does not weaken authorization (the object is measured and signature-checked after every upload).
8. **The application has no internal scheduler.** `POST /api/admin/uploads/sweep` runs the upload cleanup: expired upload intents, unordered documents past 24 hours, and order documents past the retention period. Something outside the app must call it on a schedule, authenticating with `Authorization: Bearer $CRON_SECRET` (a Super Admin session also works for a manual run). If nothing calls it, orphaned objects and retained documents accumulate and the privacy policy is not being honoured. Session cleanup is separate and is not covered by this endpoint.
9. **HTTPS/TLS** termination is your deployment platform's responsibility; HSTS is set in production but only matters behind TLS. There is no in-app force-HTTPS redirect.
10. **Backups and retention** are the operator's responsibility. Never run `prisma migrate reset` or `prisma db push --force-reset` against production data.
11. **CSRF** relies on `SameSite=Lax` cookies plus JSON-only state-changing endpoints. If a future endpoint accepts cross-origin form posts or `text/plain` bodies, add an explicit CSRF token. Note that the direct-upload PUT is *deliberately* cross-origin and is authorized by the provider's signed URL, not by the session cookie.
12. **Dependency auditing**: run `npm audit` regularly and keep dependencies patched.
13. **The database URL must match the pooler in front of it.** Prisma uses prepared statements. A transaction-mode pooler (Supabase port 6543) either supports named prepared statements (Supavisor / PgBouncer ≥ 1.21 — no URL flag needed) or requires `?pgbouncer=true` (pre-1.21 only; on a modern pooler the flag itself can cause `prepared statement "PGBOUNCER_…" does not exist`, prisma/prisma#21799). Getting this wrong surfaces as SQLSTATE 26000. The app validates and diagnoses the URL at startup and in `npm run config:check` — with the URL itself never printed — but choosing the right pooler mode is an operator decision; see SETUP.md §3.

### 11.2 Not implemented (do not assume otherwise)

- **Malware scanning is not active.** `ENABLE_MALWARE_SCAN` is a flag with no code behind
  it. Documents are parsed server-side (pdf-lib / zlib inflate), so wire a scanning vendor
  into the pipeline before processing untrusted documents at scale. A passing signature
  check is not a safety claim about file contents.
- **2FA/OTP are not implemented** (`ENABLE_2FA`, `ENABLE_OTP_VERIFICATION`) — enabling the
  flags changes nothing.
- **Payments are manually verified** — the desk must actually check bank/UPI statements;
  the app cannot detect forged references. If a real provider is added, plug it into the
  verify step; the order model needs no redesign.
- **Resumable/chunked uploads are not implemented** (`UPLOADS.md` §8 explains why TUS was
  rejected for this deployment).
- **Row-level security is not used.** Prisma connects as a trusted server-side principal;
  authorization is enforced in the application layer on every route. If a second consumer
  ever reads this database directly, that assumption must be revisited.

Run `npm run config:check` with `NODE_ENV=production` before every deploy to catch missing
or obviously invalid configuration.

## 12. Dependency vulnerability assessment (audited 2026-10-14)

`npm audit` reported **26** findings. Each was inspected individually rather than
resolved with `npm audit fix --force`. Result: **26 → 17**, with no major-version
upgrade applied anywhere.

> **Updated 2026-10-14 (second pass).** The Next.js/React upgrade described in
> §12.2 has now landed (see §12.4). Current posture: **0 critical, 0 moderate, 0 low,
> 7 high — and all 7 high entries are a single root advisory (`braces`)**. See §12.2.

### 12.1 Fixed (safe, backward-compatible)

| Change | Findings cleared | Why it is safe |
|---|---|---|
| Removed `@auth/core` | 2 **critical** | Declared in the initial commit but **never imported anywhere**. Authentication is entirely custom (`src/server/auth.ts`, node crypto + argon2/bcryptjs). Removing dead code removes the attack surface. |
| Removed `mammoth` | 1 moderate + `argparse` + `sprintf-js` | Also **never imported**. `src/server/doc-analysis.ts` counts `.docx` pages with `zlib.inflateRawSync`; `.pdf` uses `pdf-lib`. |
| `overrides: source-map-js ^1.2.2` | 1 high (GHSA event-loop DoS) | Patch bump within 1.2.x. `postcss` depends on `^1.2.1`, so 1.2.2 satisfies it. |
| `overrides: postcss $postcss` (→ 8.5.30) | 2 high + 2 moderate | `next@14.2.35` pins `postcss@8.4.31`, which is vulnerable. 8.5.x is already the project's own devDependency, so this only dedupes Next's stale nested copy onto the version already in use. |
| `overrides: @next/eslint-plugin-next → glob ^10.5.0` | 1 high (glob CLI command injection) | **Deliberately scoped** to that one package. A global `glob` override would have forced `rimraf`'s `glob@7` onto 10.x — a breaking API change. |

Verification after the change: `tsc --noEmit` clean, `next lint` clean,
**148/148 tests pass**, and `next build` completes (see §12.3 for build caveats; the suite is now 282 passing).

### 12.2 Not fixed — requires a major upgrade (deliberate, not oversight)

*Items marked ✅ RESOLVED were fixed by the Next.js 15 / React 19 upgrade in §12.4.*

- ✅ RESOLVED — **`next` — CRITICAL, 23 advisories.** No patched 14.x exists (`next-14`
  dist-tag is 14.2.35; every advisory is fixed only in ≥15.5.24 or 16.x). Upgrading touches
  React 19, the App Router, and the build pipeline, so it needs its own branch and full
  regression run — it must not be folded into a security pass. **Most of the 23 are gated on
  configuration this app does not use**, verified by inspection:
  - Image Optimization API (4 advisories incl. the AVIF RCE): `next/image` is **not used
    anywhere** in `src/`, and `images.remotePatterns: []` blocks remote sources.
  - Windows-host RCE: deployment target is Vercel (Linux).
  - Rewrites/redirects (2): none configured in `next.config.mjs`.
  - Server Actions (4): no `"use server"` directive exists in the codebase.
  - Custom-server WebSocket SSRF / i18n middleware bypass / CSP-nonce XSS /
    `beforeInteractive` XSS: not applicable (no custom server, no i18n, no nonce, no
    `beforeInteractive`).
  - The middleware advisories no longer apply now that `src/middleware.ts` is loaded
    (it only sets headers; it never issues a redirect).
  - **Still materially applicable:** the App Router / RSC denial-of-service and
    cache-poisoning advisories. These are the real reason to schedule the upgrade.
- ✅ RESOLVED — **`vitest` (critical), `tinypool` (critical), `vite` (high), `@vitest/mocker`,
  `esbuild`, `vite-node`** — dev/test only, never shipped in `next build` output. The
  `vitest` UI server is never started (`npm test` runs `vitest run`). Fixed by `vitest@4.1.11`.
  Note `vitest@5` was **not** chosen: it requires Node `^22.12 || ^24 || >=26`, and the safe
  fix for the `@vitest/mocker` advisory is `>=4.1.11`.
- ✅ MOSTLY RESOLVED — **`tailwindcss` (high), `chokidar`, `micromatch`, `fast-glob`,
  `postcss-nested`, `postcss-selector-parser`** — build-time CSS toolchain. The
  `postcss-selector-parser` root advisory was cleared by a narrow override to `^7.1.6`.
  The rest remain only as propagation of the single `braces` root cause below.
- ⚠️ STILL OPEN — **`braces` (high) has no fix at any version** — 3.0.3 is the latest
  published release and it is still vulnerable (advisory range `<=3.0.3`). Reachable
  only through Tailwind's build-time globbing and `@next/eslint-plugin-next`. The only
  remediation npm offers is `tailwindcss@4`, a different engine and config format.
  **Accepted risk** — see §12.4 for the reachability analysis.
- ✅ RESOLVED — **`prisma` (high), `@prisma/config`, `deepmerge-ts`** — CLI/migrate-time
  only, not the runtime client. Cleared by the narrow `deepmerge-ts → ^8.0.2` override;
  `prisma`/`@prisma/config` were transitive-only entries with no advisory of their own,
  and the `prisma@8` major was therefore **not** needed.

### 12.3 Build caveats (what is proven vs. not)

- `next build` **succeeded** in this environment. Two substitutions were required and are
  **not** evidence that the real integrations work:
  1. **Google Fonts was mocked** (`NEXT_FONT_GOOGLE_MOCKED_RESPONSES`) because
     `fonts.googleapis.com` is unreachable here. A real CI runner must allow egress.
  2. **`prisma generate` never ran** — `binaries.prisma.sh` is blocked here. The build was
     invoked as `npx next build`, bypassing `npm run build` (`prisma generate && next build`).
     Types came from a temporary scaffold inside `node_modules` that is **not committed** and
     must never be relied on. A real deploy must run `prisma generate` successfully.

### 12.4 Next.js 15.5.27 / React 19.3.1 upgrade (landed 2026-10-14)

**Why 15.5.27 and not 16.x.** Every `next` advisory is fixed in `>=15.5.24`, so 15.5.27
clears all 23. Next 16 was rejected for this pass for three concrete reasons: it requires
Node `>=20.9`, it makes Turbopack the default builder (it fails outright if a webpack
config exists unless `--webpack` is passed), and it renames `middleware` → `proxy` — this
repo has `src/middleware.ts`. 15.5.27 is the smallest change that clears the advisories.

**Versions.**

| Package | Before | After |
|---|---|---|
| `next` | 14.2.35 | **15.5.27** |
| `react` / `react-dom` | 18.3.1 | **19.3.1** |
| `eslint-config-next` | 14.2.15 | **15.5.27** |
| `@types/react`, `@types/react-dom` | 18.x | **19.3.0** |
| `next-themes` | 0.3.0 | **0.4.6** (0.3.0 does not peer-support React 19) |
| `vitest` | 2.1.9 | **4.1.11** |
| CI `setup-node` | 20 | **22** (vite 8 needs `^20.19 \|\| >=22.12`) |

**Code changes required by the upgrade.** Next 15 makes the Request APIs async:

- `params` is now a `Promise`. Updated **1 page** and **14 route handlers** to
  `params: Promise<{...}>` + `await params`.
- `cookies()` was **already awaited** in `src/server/auth.ts` — no change needed.
- `headers()` and `draftMode()` are not used anywhere.
- All 23 `searchParams` matches in `src/app` are `url.searchParams` inside route
  handlers, **not** the page prop — unaffected.
- `fetch` is no longer cached by default in Next 15. Every `fetch` here is dynamic
  (`api-client`, `rate-limit`, `storage`), so the new default is the correct one.
- `eslint-config-next` 15 enables `@next/next/no-html-link-for-pages`, which flagged
  three homepage hash anchors in `site-footer.tsx`; converted to `next/link`.

**Narrow overrides added** (both had published patched releases):

- `deepmerge-ts → ^8.0.2` — GHSA-ggr8-5vv4-36mx, stack exhaustion on recursive graphs.
- `postcss-selector-parser → ^7.1.6` — quadratic complexity in flat selector parsing.

These are intentionally **narrow and targeted**, not broad overrides.

**Accepted risk: `braces` (high, GHSA-vfj7-8cjw-p6xm, CWE-674, CVSS 7.5).**

This is the **only remaining root advisory**. It is accepted, not suppressed, because:

1. **No patched version exists.** The advisory range is `<=3.0.3` and 3.0.3 is the latest
   published release. An override cannot fix it. Upstream is dormant — `braces` was last
   published 2024-09-18, so waiting for a fix is not a plan.
2. **The only remediation npm offers is `tailwindcss@4`** — a different engine and a
   CSS-first config format that would touch every template file. That is a UI migration,
   not a security fix, and it directly risks the stability this pass was meant to protect.

**Exposure — verified, not assumed.** "It is only a devDependency" is not by itself an
argument, so the claim was checked against the actual graph and the actual build output:

- **No production dependency reaches it.** Walking the lockfile from every entry in
  `dependencies` (not `devDependencies`), there is no path to `braces`, `micromatch`,
  `fast-glob` or `chokidar`. All four are reachable only via `tailwindcss`,
  `eslint-config-next` and `prisma` — all devDependencies.
- **No application code imports it.** `src/` contains no import of `braces`, `micromatch`
  or `fast-glob`.
- **It is absent from the production bundle.** After a successful webpack compile, the
  453 files under `.next/` contain **zero** occurrences of `braces`, `micromatch`,
  `fast-glob`, `chokidar`, or of braces internals (`expand-range`, `fill-range`,
  `toRegexRange`, `isBrace`). The vulnerable code is not shipped.
- **No attacker-controlled input reaches it.** Stack exhaustion (CWE-674) requires a
  maliciously nested glob pattern. The patterns come from `tailwind.config.js`
  (developer-authored, committed) and Tailwind internals.

**Residual uncertainty.** The bundle inspection above was performed on a build compiled in
a sandbox that could not reach `fonts.googleapis.com` (Google Fonts was mocked) and could
not run `prisma generate` (so type-checking failed). Bundling — which is what determines
whether `braces` is included — completed successfully, so the inclusion result is sound,
but that build did not pass as a whole. The authoritative build is CI's, which passes with
real fonts and a generated client. The exposure argument rests on the dependency-graph and
bundle analysis above, not on a claim that a dev dependency is automatically harmless.

**Practical risk: low.** A successful attack needs (a) a build-time or lint-time context,
(b) an attacker-supplied deeply nested glob, and (c) code that passes that glob to braces.
None of the three holds.

It is recorded here so the `audit` job's failure is explainable at a glance, and so a
future Tailwind 4 migration can close it deliberately.

### 12.5 CI dependency-audit job status

The `audit` job in `.github/workflows/ci.yml` runs `npm audit --audit-level=high`
**without `continue-on-error`**, so its exit status is honest: it fails while any
high or critical finding remains.

That means **this job is expected to fail while any high finding remains**. As of the
2026-10-14 upgrade it fails on exactly one root advisory, `braces` (§12.2), which has
no patched release and no fix short of a `tailwindcss@4` migration.

This is deliberate. The previous arrangement — `npm audit` as the last step of the
`verify` job with `continue-on-error: true` — had two defects: the step never ran at
all once typecheck failed, and even when it did run, its findings could not fail the
job. A green badge obtained by suppressing a critical finding is worth less than a
red one that is accurate.

The `verify` and `migrations` jobs **pass**; only `audit` is red, and for a single
documented, accepted root cause. Reviewers should treat a red `audit` + green
everything-else as the expected state, and should treat any *new* high/critical
finding — other than `braces` — as a regression.

The job always publishes a markdown summary of every critical/high finding and
uploads the full `npm audit --json` as the `npm-audit-json` artifact, so the result
is inspectable without re-running anything.

Do not "fix" a failing audit job by adding broad dependency overrides or by
re-introducing `continue-on-error`. Remediate §12.2 or record an accepted risk here.


## 13. Fixed defect: security headers were never applied

**Found and fixed 2026-10-14.** `middleware.ts` was committed at the *repository root*,
but the App Router directory is `src/app`. Next.js only loads a middleware that is a
**sibling of the `app/` directory**, so the file was silently ignored — no error, no
warning, no build failure.

**Impact:** every response was missing `Content-Security-Policy`, `Strict-Transport-Security`
(HSTS), `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`
and `X-DNS-Prefetch-Control`. Confirmed empirically against a running production server:

```
before: HTTP/1.1 200 OK         -> none of the security headers present
after : content-security-policy: default-src 'self'; ... frame-ancestors 'none'; ...
        strict-transport-security: max-age=63072000; includeSubDomains; preload
        x-frame-options: DENY
        x-content-type-options: nosniff
        referrer-policy: strict-origin-when-cross-origin
        permissions-policy: camera=(), microphone=(), geolocation=(), payment=()
        x-dns-prefetch-control: off
```

**Fix:** `git mv middleware.ts src/middleware.ts`. The build output now includes
`ƒ Middleware 26.8 kB` (previously absent), and the header set was verified on both
`/login` and an API route.

**Regression guard:** `tests/security-headers.test.ts` asserts the file location and the
header values, including that HSTS appears only in production and that `ALLOW_DEV_FRAME_EMBED`
cannot weaken production. Reintroducing the old file location fails 6 of its 7 tests.

## 14. Change record — direct-to-private-storage uploads (2026-10-15)

**Why.** `MAX_FILE_SIZE` is 50 MiB (52,428,800 bytes) with up to 10 files per order (`src/lib/constants.ts`),
but the proxy route has to carry those bytes through the application. On a function host
(Vercel: **4.5 MB request body and 4.5 MB response body**) that is not a tuning problem —
it is unbuildable. §11.1 item 6 recorded this as an operator's problem; it is now a code
problem with a code answer.

**What changed.**

| Area | Change |
|---|---|
| Protocol | `POST /api/uploads/intent` (authorize) → browser PUTs to a scoped, single-path, time-limited storage URL → `POST /api/uploads/complete` (verify). `POST /api/uploads/abort` releases an unused intent; `GET /api/uploads/capability` tells the browser which path to use. |
| Verification | Completion re-reads the **measured size** (object metadata) and the **first 16 bytes** (signature) from storage. Client size/type claims are never trusted, and an object that disagrees is deleted with the row set to `FAILED`. |
| Credential | HMAC-SHA-256 intent token bound to `(row, owner, key, claimed size, expiry, nonce)`, keyed on `SESSION_SECRET`; only its SHA-256 digest is stored, under a unique index, so it is single-use per row and a re-issued intent invalidates the previous token. |
| Order gate | `createOrder` refuses any document whose row is not `COMPLETED` (new explicit 409), independent of `analysisStatus`. |
| Downloads | `GET /api/files/:id/download` authorizes from the row, then answers **307 → short-lived signed URL** on `supabase` or a **stream** on `local`. It never buffers an object into a response body. |
| Schema | Additive migration `20261015000000_direct_upload_intents`: `intent_expires_at`, `intent_token_hash` (unique), `verified_at`, `@@index([status, intent_expires_at])`. No column, row or constraint modified or dropped. |
| Config | `DIRECT_UPLOADS_ENABLED`, `UPLOAD_INTENT_TTL_SECONDS`, `SIGNED_DOWNLOAD_URL_TTL_SECONDS`, `STORAGE_PROVIDER_MAX_FILE_BYTES`; all four validated by `scripts/check-env.ts` (and required on `supabase`). |
| Rate limits | New buckets: upload intent 40/10 min, completion 40/10 min, download 120/10 min, keyed **per user** where an identity exists. |

**Security properties gained** (all asserted in `tests/direct-upload-*.test.ts`, 121 tests):
no writable bucket path from user input; one path per credential; no overwrite of an existing
object; verification before usability; no credential in a URL, log, audit entry or cacheable
response; identical answers for "not yours" and "does not exist".

**Security properties NOT gained — say so plainly:**
- **No content scanning.** A file that begins with `%PDF-1.4` and is 4 KB passes. That is a
  format check, not a safety check. Malware scanning remains unwired (§11.2).
- **No proof about the provider.** Storage is faked in tests. "Supabase enforces `expiresIn`",
  "rejects an existing object at a signed-upload path", "returns a trustworthy `metadata.size`"
  and "a signed URL is useless without its token" are *assumptions we verify manually* against
  a real bucket — see `UPLOADS.md` §8.1 for the checklist.
- **No resumption, and no antivirus quarantine.** A failed PUT is retried by the user, and an
  object that fails verification is deleted rather than held for review.
- **`intent_token_hash` is a digest, not an encryption.** A database dump still reveals who
  uploaded what and when; it just cannot be replayed to complete an upload.

**Operator actions required.** (1) Raise/set the bucket's global per-file limit and mirror it
in `STORAGE_PROVIDER_MAX_FILE_BYTES`. (2) Schedule `POST /api/admin/uploads/sweep` with `CRON_SECRET` — nothing
else reaps abandoned or retained documents. (3) Confirm public access on the bucket stays off
(the bucket must remain private — `UPLOADS.md` §4 and check 1 of §8.1). (4) Re-run the `UPLOADS.md` §8.1 manual checks after any
Supabase plan change. See `DEPLOYMENT.md` §1a and `UPLOADS.md`.
