# XeroxEase — API Reference

Base URL: `/api`. All responses are JSON unless streaming (files/invoices/QR image).
Errors: `{ "error": string, "code"?: string }` with appropriate HTTP status. Internal details are never leaked in production.

**Authentication** uses an HTTP-only session cookie (`xe_session`) set by login endpoints. Roles are always derived server-side from the session.

Rate limits (per IP, per bucket): login 10/5min · register 5/h · forgot 3/15min · upload 30/10min · analyze 60/10min · payment submit 10/10min · feedback 10/h · order create 20/h · cancel 10/h · admin 120/min.

---

## Auth

| Method | Path | Auth | Body | Notes |
|---|---|---|---|---|
| POST | `/auth/register` | — | name, email, phone, regNo, branch, section, year, password, confirmPassword | Creates STUDENT only. 409 on duplicate email/phone/regNo. |
| POST | `/auth/login` | — | identifier (email **or** regNo), password | Students only; admins rejected. Lockout after 8 failures. |
| POST | `/auth/admin-login` | — | email, password | ADMIN/SUPER_ADMIN only. Lockout after 5 failures. Audited. |
| POST | `/auth/logout` | session | — | Revokes session, clears cookie. |
| GET | `/auth/me` | session | — | `{ user }` or `{ user: null }`. |
| POST | `/auth/forgot-password` | — | email | Anti-enumeration; single-use token valid 30 min. Dev returns `devResetToken` when email delivery disabled. |
| POST | `/auth/reset-password` | — | token, password | Consumes token, rehashes password, revokes all sessions. |

## Orders

| Method | Path | Auth | Body/Query | Notes |
|---|---|---|---|---|
| GET | `/orders` | STUDENT | `?q=&status=&page=&pageSize=` | Own orders only, paginated. |
| POST | `/orders` | STUDENT | fileIds[], paperSize, colorMode (required), sides, copies, pageSelection, customPages?, finishing[] | **Server recalculates price** from verified page counts. Transactional. Returns `XE-…` order number. |
| GET | `/orders/:id` | owner or ADMIN | — | Full detail incl. events, files, feedback. IDOR-guarded. |
| POST | `/orders/:id/cancel` | owner | reason? | Server checks configured cancellable statuses. Transactional + audited. |
| POST | `/orders/:id/feedback` | owner | rating 1–5, comment? | Only after `COMPLETED`; one per order. |
| GET | `/orders/:id/collection-token` | owner | — | Only when `READY_FOR_COLLECTION`; returns signed single-use token. |

## Files & documents

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/uploads` | session | multipart `file`. Validates extension + MIME + magic bytes + size (≤100 MB) + filename. Stored privately. |
| POST | `/documents/analyze` | owner | `{ fileId }`. Runs server-side page/slide-count analysis; stores `pageCount`, `pageCountSource`, `analysisStatus`. |
| GET | `/files/:id/download` | owner / ADMIN | IDOR-guarded stream; audited. |

## Payment (QR workflow)

| Method | Path | Auth | Body | Notes |
|---|---|---|---|---|
| GET | `/payment/qr` | session | — | `{ enabled, qrUrl?, instructions, accountDisplay }`. |
| GET | `/payment/qr/image` | session | — | Streams the private QR image. |
| POST | `/payment/submit/:id` | owner | reference (UTR) | Moves to `PAYMENT_UNDER_REVIEW`. Duplicate/idempotent-safe. Notifies admins. **Does NOT confirm payment.** |

## Admin

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/admin/orders` | ADMIN+ | `?q=&status=&paymentStatus=&sort=&dir=&page=` server-side pagination. |
| PATCH | `/admin/orders/:id/status` | ADMIN+ | `{ status, note? }` — validates legal transitions; audited; generates collection token on READY. |
| PATCH | `/admin/orders/:id/files/:fileId/pagecount` | ADMIN+ | `{ pageCount }` — sets `ADMIN_VERIFIED`; audited. |
| GET | `/admin/payments?state=` | ADMIN+ | Queue: PENDING_REVIEW / CONFIRMED / REJECTED. |
| PATCH | `/admin/payments/:id/verify` | ADMIN+ | Marks `PAYMENT_CONFIRMED`; audited; notifies student. |
| PATCH | `/admin/payments/:id/reject` | ADMIN+ | `{ note }` required; back to pending; audited. |
| GET | `/admin/analytics` | ADMIN+ | Cards (revenue, pages today, ratings…), status distribution, recent feedback. |
| GET | `/admin/feedback` | ADMIN+ | Ratings + distribution + list. |
| PATCH | `/admin/feedback` | SUPER_ADMIN | `{ id, moderation: HIDDEN\|SHOWN }`; audited. |
| GET | `/admin/users` | ADMIN+ | Search/filter/paginate. |
| POST | `/admin/users` | SUPER_ADMIN | Provision ADMIN/SUPER_ADMIN (no public signup); audited. |
| PATCH | `/admin/users/:id` | SUPER_ADMIN | `{ isActive }`; disabling revokes sessions; audited. |
| GET/PATCH | `/admin/pricing` | ADMIN+ / SUPER_ADMIN | List rates / update rates; audited. |
| GET/POST/PATCH/DELETE | `/admin/payment-qr` | SUPER_ADMIN | Get config / upload image / enable-disable / remove; stored privately; audited. |
| GET/PATCH | `/admin/settings` | SUPER_ADMIN | Instructions, retention, queue capacity; audited. |
| GET | `/admin/audit-logs` | SUPER_ADMIN | Filter by action, search, paginate. |
| POST | `/admin/collection` | ADMIN+ | `{ token, consume }` — verify or consume collection QR (consume completes the order). |

## Public

| Method | Path | Notes |
|---|---|---|
| GET | `/pricing` | Active price table (display only; server remains authoritative). |
| GET | `/invoices/:id` | Owner/ADMIN; printable HTML invoice (print to PDF). |
| GET | `/notifications` · PATCH | Own notifications; mark read. |

## Added / changed endpoints

### `PATCH /api/documents/:id/pagecount` 🔒

Confirm the page count of one of **your own** documents when automatic analysis was
inconclusive (`NEEDS_REVIEW`) or failed. Records `USER_CONFIRMED`, sets
`analysisStatus` to `COMPLETED`, and writes an audit entry.

Body: `{ "pageCount": 1..10000 }`

Rejected when the document is not yours (404), is already attached to an order (409),
or is still being analyzed (409).

### `POST /api/auth/reset-password` 🌐

Rate limited (5 / 15 min per IP). Redemption is atomic and single-use. Unknown,
expired, malformed and already-used tokens all return the **same** `400
RESET_TOKEN_INVALID` response so the endpoint cannot be used to probe live tokens.
A successful reset revokes every session for that user.
