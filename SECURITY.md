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
| File upload attacks | Extension allow-list, MIME validation, magic-byte signature checks, double-extension rejection, filename sanitization, path-traversal-safe storage keys (server-generated), declared `Content-Length` checked **before** parsing plus an authoritative check on the received bytes, one-file-per-request, 100 MB cap, orphaned objects cleaned up if the database write fails, private storage |
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

## 3. Authorization model

- Roles: `STUDENT` < `ADMIN` < `SUPER_ADMIN`, stored server-side, resolved from the session on every request.
- Students: own orders/files/invoices/feedback/notifications only.
- Admins: order management, payment verification, file access for fulfillment, analytics.
- Super Admin: pricing, settings, payment QR, user provisioning/disable, feedback moderation, audit logs.
- Route guards live in **server layouts** (redirect) **and** every API handler (401/403) — the client is never trusted.

## 4. File security model

- Uploaded documents are written to **private storage**. `STORAGE_BACKEND=local` (default, development only) writes to `.data/uploads`, outside any public web root; `STORAGE_BACKEND=supabase` writes to a single **private** bucket named by `STORAGE_BUCKET` (default `documents`).
- In production, local storage is **refused** unless `ALLOW_EPHEMERAL_LOCAL_STORAGE=true`. Ephemeral/serverless filesystems lose files between invocations, which would leave orders referencing documents that no longer exist.
- Storage keys are `sanitizeKeySegment(ownerId)/<timestamp>-<random>-<sanitised name>`: no user-controlled path component, no `..`, no absolute paths, no hidden-file prefixes.
- Downloads stream through `/api/files/:id/download` after ownership/role verification; every access is audited. There are **no permanent public URLs**.
- Filenames are sanitized for display; storage names are server-generated.
- Malware scanning hook: set `ENABLE_MALWARE_SCAN=true` and wire a scanning vendor into the upload pipeline (see `src/app/api/uploads/route.ts`) when infrastructure permits.

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
- `SESSION_SECRET` signs collection tokens; rotate via env change (invalidates outstanding collection codes — acceptable, they're re-issued per order).
- The Supabase **service-role key must never** be exposed to the client or committed. Only the anon key may reach the browser, and the current architecture doesn't require it there.

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
- Storage bucket sync for uploaded documents; retention per configured policy.
- Reconciliation: `payment_events` against bank/UPI statements.

## 11. Remaining risks / operator responsibilities

Honest list — these remain after deploying this codebase:

- **Malware scanning is not active by default.** Enable `ENABLE_MALWARE_SCAN` with a scanning vendor for production.
- **Rate limiting is in-memory** — fine for a single instance; use Redis (e.g., Upstash) for multi-instance deployments.
- **2FA/OTP flags exist but are not implemented** (`ENABLE_2FA`, `ENABLE_OTP_VERIFICATION`) — do not enable the flags expecting behavior.
- **Payments remain manually verified** — the desk must actually check bank/UPI statements; the app cannot detect forged references.
- **HTTPS/TLS** termination is your deployment platform's responsibility; HSTS is set in production but only matters behind TLS.
- **Dependency auditing**: run `npm audit` regularly and keep dependencies patched.
- **Database access**: the app uses a privileged Postgres role; apply least-privilege per your Supabase setup and rely on application-layer authorization (row-level security is not used because Prisma connects as a trusted server-side principal).


## 9. Residual risks and operator responsibilities

These are **not** fixed by the code and must be handled by whoever deploys the app:

1. **`TRUSTED_PROXY_COUNT` must match your deployment.** Client IP is read `TRUSTED_PROXY_COUNT` hops from the right of `X-Forwarded-For`, which is only correct if exactly that many trusted proxies sit in front of the app (Vercel: 1). Getting it wrong does more than mis-attribute IPs: too high a value reads a client-forged entry and lets an attacker pick their own rate-limit bucket; too low a value buckets every client behind the proxy together. Set it deliberately and re-check after any infrastructure change.
2. **Recovery codes are bearer credentials.** Anyone holding a user's code *and* their identifier can take over the account. The code is single-use and never emailed, but it is only as safe as wherever the user stored it. Encourage a password manager, and treat a report of a lost code as an incident.
3. **The admin-assisted fallback depends on human identity verification.** The code cannot enforce it — an administrator who issues a code without checking ID defeats the control. Every issuance is audited with a mandatory reason; review `RECOVERY_CODE_ADMIN_ISSUED` entries.
4. **Rate limiting is per-IP.** Users behind one NAT share a bucket; a determined distributed attack is not stopped by these limits alone. Use the shared Redis store and consider a WAF.
5. **`next/font/google` requires build-time network access.** The build fetches Inter from Google Fonts. In an air-gapped or egress-restricted CI runner the build fails; either allow egress to `fonts.googleapis.com` or self-host the font.
6. **No malware scanning.** `ENABLE_MALWARE_SCAN` exists as a hook but no scanner is wired in. Uploaded documents are parsed server-side (pdf-lib / zlib inflate), so a scanning vendor is recommended before processing untrusted documents at scale.
7. **Reverse-proxy body limits.** The app rejects oversized uploads, but the platform and proxy must be configured to match (nginx `client_max_body_size 110M`; note that some serverless platforms cap request bodies far below 100 MB).
8. **Backups and retention** are the operator's responsibility. Never run `prisma migrate reset` or `prisma db push --force-reset` against production data.
9. **CSRF** relies on `SameSite=Lax` cookies plus JSON-only state-changing endpoints. If a future endpoint accepts cross-origin form posts or `text/plain` bodies, add an explicit CSRF token.

Run `npm run config:check` with `NODE_ENV=production` before every deploy to catch missing or obviously invalid configuration.
