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
| Rate abuse | Per-endpoint sliding-window limits (login, register, upload, analyze, payment, feedback, admin, public) |
| File upload attacks | Extension allow-list, MIME validation, magic-byte signature checks, double-extension rejection, filename sanitization, path-traversal-safe storage keys (server-generated), 100 MB size cap, private storage |
| Path traversal | Storage keys generated server-side (UUID + random hex); `storagePath()` resolves and validates against base directory |
| MIME spoofing | Magic-byte validation catches renamed executables (tested) |
| Clickjacking | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` |
| Open redirects | No redirect-to-user-supplied-URL functionality |
| Security misconfiguration | Security headers via middleware; `poweredByHeader` off; generic production errors |
| Sensitive data exposure | No card/CVV/UPI-PIN data collected; payment refs stored last-4-only in logs; secrets only in env vars |
| Mass assignment | Zod schemas whitelist exact fields; client never sets role/price/status |
| Parameter pollution | Zod coerces and validates types; unknown keys dropped |
| Replay (collection QR) | Single-use tokens: `collection_token_used_at` set atomically on verification |

## 2. Authentication model

- **Passwords**: Argon2id (memory-hard) with automatic bcrypt fallback; never logged, never stored plaintext.
- **Sessions**: opaque 256-bit random tokens in HTTP-only cookies; server-side `sessions` table holds only the SHA-256 hash; TTL via `SESSION_TTL_HOURS`; explicit revocation on logout/reset/disable.
- **Account lockout**: progressive counters with temporary lock; all failures audited with IP.
- **Password reset**: single-use, 30-minute, hashed tokens; resets revoke all sessions.
- **Admin auth**: separate login endpoint + page (`/admin/login`), stricter lockout, dedicated audit events. **No public admin signup exists anywhere**; admins are provisioned only by Super Admin through the admin console.

## 3. Authorization model

- Roles: `STUDENT` < `ADMIN` < `SUPER_ADMIN`, stored server-side, resolved from the session on every request.
- Students: own orders/files/invoices/feedback/notifications only.
- Admins: order management, payment verification, file access for fulfillment, analytics.
- Super Admin: pricing, settings, payment QR, user provisioning/disable, feedback moderation, audit logs.
- Route guards live in **server layouts** (redirect) **and** every API handler (401/403) — the client is never trusted.

## 4. File security model

- Uploaded documents are written to **private storage** (default: `.data/uploads`, outside any public web root; Supabase Storage private buckets supported).
- Downloads stream through `/api/files/:id/download` after ownership/role verification; every access is audited. There are **no permanent public URLs**.
- Filenames are sanitized for display; storage names are server-generated.
- Malware scanning hook: set `ENABLE_MALWARE_SCAN=true` and wire a scanning vendor into the upload pipeline (see `src/app/api/uploads/route.ts`) when infrastructure permits.

## 5. AI/document-processing security

- Analysis runs **server-side** on stored bytes (pdf-lib for PDF; ZIP central-directory + `docProps/app.xml` for DOCX/PPTX).
- Unparseable documents (legacy OLE2 `.doc/.ppt`, encrypted PDFs) fall back to `NEEDS_REVIEW` — the app **never invents page counts**; admins verify and corrections are audited.
- Pricing uses only server-verified counts. Client-side estimates are display-only.

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

- Structured server logs: endpoint, status, error category; security events (login failures, denied file access) additionally in `audit_logs`.
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
- **Email delivery is not configured** by default: password-reset tokens surface only in dev mode; wire an email provider before production use.
- **2FA/OTP flags exist but are not implemented** (`ENABLE_2FA`, `ENABLE_OTP_VERIFICATION`) — do not enable the flags expecting behavior.
- **Payments remain manually verified** — the desk must actually check bank/UPI statements; the app cannot detect forged references.
- **HTTPS/TLS** termination is your deployment platform's responsibility; HSTS is set in production but only matters behind TLS.
- **Dependency auditing**: run `npm audit` regularly and keep dependencies patched.
- **Database access**: the app uses a privileged Postgres role; apply least-privilege per your Supabase setup and rely on application-layer authorization (row-level security is not used because Prisma connects as a trusted server-side principal).
