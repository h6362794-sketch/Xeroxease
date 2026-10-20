# XeroxEase — API Reference

Base URL: `/api`. All responses are JSON unless streaming (files/invoices/QR image).
Errors: `{ "error": string, "code"?: string }` with appropriate HTTP status. Internal details are never leaked in production.

**Authentication** uses an HTTP-only session cookie (`xe_session`) set by login endpoints. Roles are always derived server-side from the session.

Rate limits (per IP, and per user where an identity is available; per user is used for upload/download buckets): login 10/5min · register 5/h · forgot 3/15min · upload 30/10min · upload intent 40/10min · upload complete 40/10min · download 120/10min · analyze 60/10min · payment method 20/10min · payment submit 10/10min · feedback 10/h · order create 20/h · cancel 10/h · admin 120/min · admin order search 120/min.

---

## Auth

| Method | Path | Auth | Body | Notes |
|---|---|---|---|---|
| POST | `/auth/register` | — | name, email, phone, regNo, branch, section, year, password, confirmPassword | Creates STUDENT only, **no session** (sign in afterwards). 409 on duplicate email/phone/regNo — both from the preflight check and from the insert-time unique-constraint race (Prisma `P2002`), never a 500. |
| POST | `/auth/login` | — | identifier (email **or** regNo), password | Students only; admins rejected. Lockout after 8 failures. |
| POST | `/auth/admin-login` | — | email, password | ADMIN/SUPER_ADMIN only. Lockout after 5 failures. Audited. |
| POST | `/auth/logout` | session | — | Revokes session, clears cookie. |
| GET | `/auth/me` | session | — | `{ user }` or `{ user: null }`. |
| POST | `/auth/recovery/code` | session | password | Issues/rotates the caller's single-use recovery code. Returns the plaintext **once**. |
| GET | `/auth/recovery/status` | session | — | `{ hasCode, createdAt, expiresAt, usedAt, issuedByAdmin }` — metadata only, never the code. |
| POST | `/auth/recovery/reset` | — | identifier, recoveryCode, password | Email-free password reset. Rate limited 5 / 15 min per IP **and** identifier. |
| POST | `/admin/users/:id/recovery-code` | SUPER_ADMIN | reason | Admin-assisted fallback: issues a single-use 24 h code. Audited. |

## Orders

| Method | Path | Auth | Body/Query | Notes |
|---|---|---|---|---|
| GET | `/orders` | STUDENT | `?q=&status=&page=&pageSize=` | Own orders only, paginated. |
| POST | `/orders` | STUDENT | fileIds[], paperSize, colorMode (required), sides, copies, pageSelection, customPages?, finishing[] | **Server recalculates price** from verified page counts; client-supplied prices/status are ignored. `fileIds` must be 1–10 UUIDs of the caller's **verified** (`COMPLETED`) documents, else `422`/`403`/`409` before anything is written. Transactional. Returns `XE-…` order number. |
| GET | `/orders/:id` | owner or ADMIN | — | Full detail incl. events, files, feedback, `payment`, `paymentControls` (`canSelectMethod`, `canSubmitUpi`, `blockedReason`, `paymentStage`) and `cancellation` (`allowed`, `explanation`). Foreign orders and missing orders both return 404. |
| POST | `/orders/:id/cancel` | owner | reason? | **Pre-acceptance only.** `ORDER_RECEIVED` (and configured-narrowed legacy pre-acceptance states) can be cancelled; accepted/printing/ready orders return `409`. The guarded `UPDATE … WHERE status = <read>` means a simultaneous acceptance cannot produce an accepted + cancelled order: the loser gets `409`. Audited. |
| POST | `/orders/:id/payment-method` | owner | `{ method: "CASH_ON_DELIVERY" \| "UPI" }` | Only after acceptance and only while unpaid. Selecting cash **never** marks the order paid. A repeated/conflicting choice returns `409`. |
| POST | `/orders/:id/feedback` | owner | rating 1–5, comment? | Only after `COMPLETED`; one per order. |
| GET | `/orders/:id/collection-token` | owner | — | Available at `READY_FOR_PICKUP` (and legacy `READY_FOR_COLLECTION`); returns the signed single-use token for the desk. |

## Files & documents

| Method | Path | Auth | Body | Notes |
|---|---|---|---|---|
| GET | `/uploads/capability` | session | — | `{ enabled, maxBytes, providerMaxBytes, resumable, proxyUploadAvailable, code?, reason? }`. Tells the browser whether to use the direct or proxy path. No secrets, no bucket names. |
| POST | `/uploads/intent` | session | `{ filename, mimeType?, sizeBytes, orderId? }` | **Direct upload step 1.** Authorizes one document: validates metadata, creates a `PENDING` row, mints a server-only storage key + a single-path, time-limited signed upload URL. `201 → { mode:"direct", fileId, token, uploadUrl, headers:{}, maxBytes, expiresAt, fileSizeLimitNote }`. 501 on `local` backend, 503 when disabled or misconfigured, 413 over the limit, 409 over quota. The `token` is a one-use completion credential: never store it, log it or put it in a URL. |
| POST | `/uploads/complete` | owner | `{ fileId, token }` | **Direct upload step 3.** Server re-reads the object (measured size + first bytes) and verifies it against the intent, then sets `COMPLETED`. No client size/type claim is accepted. `410` expired · `409` missing object/storage unavailable · `413` oversized · `422` size or signature mismatch (object deleted, row `FAILED`) · `403` forged/replayed token or foreign document. Idempotent: repeating after success re-verifies nothing and returns the same payload. |
| POST | `/uploads/abort` | owner | `{ fileId }` | Releases an unverified intent and deletes its object, returning the per-order file slot. Refused (`409`) once a document is verified. |
| POST | `/uploads` | session | multipart `file` | **Proxy path (development / `local` backend).** Validates extension + MIME + magic bytes + size (≤50 MiB, inclusive) + filename on the real bytes, writes, then creates the row as `COMPLETED`. Bounded by the platform's request-body limit, so unusable for large files on Vercel. |
| POST | `/admin/uploads/sweep?limit=50` | SUPER_ADMIN | — | Reaps expired `PENDING` intents and their objects (limit 1–500). Bounded and re-runnable; the app has no scheduler. Audited. |
| POST | `/documents/analyze` | owner | `{ fileId }` | Runs server-side page/slide-count analysis; stores `pageCount`, `pageCountSource`, `analysisStatus`. Only meaningful once a document is `COMPLETED`. |
| GET | `/files/:id/download` | owner / ADMIN | — | IDOR-guarded. `supabase`: `307` to a short-lived signed URL (`no-store`, `no-referrer`, `noindex`) so bytes never cross a function body. `local`: streamed response. Non-`COMPLETED` documents 404 for everyone, including admins. `?mode=view` requests inline display. |

## Payment (QR workflow)

| Method | Path | Auth | Body | Notes |
|---|---|---|---|---|
| GET | `/payment/qr` | session | — | `{ enabled, qrUrl?, instructions, accountDisplay }`. |
| GET | `/payment/qr/image` | session | — | Streams the private QR image. |
| POST | `/payment/submit/:id` | owner | `{ reference }` | Only after acceptance with `UPI` selected. Normalises (trim/uppercase, 4–64 chars, `A-Z0-9._/-`) and moves to `PAYMENT_UNDER_REVIEW`; stores the reference + timestamp and notifies the desk. Duplicate/conflicting submissions return `409`. **Does NOT confirm payment.** |

## Admin

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/admin/orders` | ADMIN+ | `?q=&status=&paymentStatus=&sort=&dir=&page=` server-side pagination. |
| GET | `/admin/orders/lookup` | ADMIN+ | Dedicated search: `q` (order number/ID, student name/email/regNo, ≤100 chars), `status`, `paymentStatus`, `from`/`to` (`YYYY-MM-DD`, ≤730-day range), `page`, `pageSize` (≤50, default 20). Unknown enums/dates → `422`. Returns summary rows only; full detail needs the per-order route. |
| GET | `/admin/orders/:id` | ADMIN+ | Full authorized record: student, print options, itemised pricing + `pricingSnapshot`, every file (page count + verified flag), status/payment history with actor names, `allowedNextStatuses`, `stageIndex`, cancellation explanation. Never returns `storageKey`, `collectionTokenHash` or password fields. |
| PATCH | `/admin/orders/:id/status` | ADMIN+ | `{ status, note?, confirm? }` — server validates the edge, rejects repeats with `409`, requires a ≥3-char note for `REJECTED` and `confirm: true` for `DELIVERED`/`REJECTED` (`422` otherwise). Conditional update → concurrent writers get `409`. Audited; generates the collection token on READY. |
| GET | `/admin/orders/:id/files/:fileId/download?mode=view\|download` | ADMIN+ | Order-scoped document access. Verifies admin role, file↔order association, order ownership and `COMPLETED` upload; every negative case is an identical `404 FILE_NOT_FOUND`. `supabase` → `307` to a short-lived signed URL; `local` → streamed bytes with `Content-Disposition` built from the stored filename. Storage/signing failures → `503`; never a storage key. |
| PATCH | `/admin/orders/:id/files/:fileId/pagecount` | ADMIN+ | `{ pageCount }` — sets `ADMIN_VERIFIED`; audited. |
| GET | `/admin/payments?state=` | ADMIN+ | Queue: `PENDING_REVIEW` (proof submitted/under review), `AWAITING_CASH`, `CONFIRMED`, `REJECTED`. Unknown state → `400` (previously returned every order). `pageSize` capped at 100. |
| PATCH | `/admin/payments/:id/verify` | ADMIN+ | `{ note?, confirm: true }` — `confirm` is mandatory (`422`). Records method, actor, timestamp and amount; **does not move the printing status**. UPI requires a submitted reference; cash requires a selected cash method. Duplicate/racing confirmations → `409`. Audited + notifies the student. |
| PATCH | `/admin/payments/:id/reject` | ADMIN+ | `{ reason }` (3–500 chars, `422` otherwise); only for submitted/under-review payments. Keeps the reference in history, tells the student why, allows a corrected resubmission. Audited. |
| GET | `/admin/analytics` | ADMIN+ | Cards (revenue, pages today, ratings…), status distribution, recent feedback. |
| GET | `/admin/feedback` | ADMIN+ | Ratings + distribution + list. |
| PATCH | `/admin/feedback` | SUPER_ADMIN | `{ id, moderation: HIDDEN\|SHOWN }`; audited. |
| GET | `/admin/users` | ADMIN+ | Search/filter/paginate. |
| POST | `/admin/users` | SUPER_ADMIN | Provision ADMIN/SUPER_ADMIN (no public signup); audited. |
| PATCH | `/admin/users/:id` | SUPER_ADMIN | `{ isActive }`; disabling revokes sessions; audited. |
| GET/PATCH | `/admin/pricing` | ADMIN+ / SUPER_ADMIN | List active + inactive rates and the last 20 price-change audit rows / update rates. `PATCH` is SUPER_ADMIN only; `unitPrice` must be finite, 0–10000, ≤2 dp; unknown keys → `422`; duplicate keys → `422`; each key may appear once. The conditional write + audit row are one transaction, so a concurrent edit returns `409` and past orders are never touched. |
| GET/POST/PATCH/DELETE | `/admin/payment-qr` | SUPER_ADMIN | Get config / upload image / enable-disable / remove; stored privately; audited. |
| GET/PATCH | `/admin/settings` | SUPER_ADMIN | Instructions, retention, queue capacity; audited. |
| GET | `/admin/audit-logs` | SUPER_ADMIN | Filter by action, search, paginate. |
| POST | `/admin/collection` | ADMIN+ | `{ token, consume }` — verify or consume collection QR (consume completes the order). |

### Lifecycle, payment and pricing semantics (2026-10)

**Canonical status model** (one table: `src/lib/order-status.ts`):

```
ORDER_RECEIVED ──accept──▶ ACCEPTED ──▶ PRINTING ──▶ READY_FOR_PICKUP ──▶ DELIVERED
       │                     │
       └─reject / cancel     └─reject
```

`REJECTED` is an outcome, not a stage; the student timeline always shows five stages.
`CANCELLED`, `DELIVERED`, `REJECTED` and all legacy terminal values are final. Legacy
statuses (`ORDER_PLACED … COMPLETED`) remain readable and keep their old forward edges so
historical orders can still be finished; **no stored status is rewritten**.

**Payment is a separate axis.** Payment controls unlock only at `ACCEPTED`/`PRINTING`/
`READY_FOR_PICKUP`; confirming money never advances the print lifecycle.

| Payment state | Meaning |
|---|---|
| `PAYMENT_PENDING` | No reference submitted. Cash may be selected; still unpaid. |
| `PAYMENT_UNDER_REVIEW` | Student submitted a UPI reference — a **claim**, not proof. |
| `PAYMENT_CONFIRMED` | An administrator checked the money and recorded actor + timestamp. |
| `PAYMENT_REJECTED` | Administrator rejected the claim with a reason; student may resubmit. |

**Pricing history.** A new order stores `pricePerPage`, `finishingFee`, `totalAmount` and a
full `pricingSnapshot` (price table + applied finishing) at creation. `/api/pricing` and
`/api/admin/pricing` read the live table on every request, so new orders use new prices,
but no code path recalculates or overwrites an existing order's total. A future repricing
flow must be a separate, authorized, audited adjustment with a reason and a payment-
difference calculation — never a silent overwrite.

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

### Account recovery (email-free) 🌐

XeroxEase sends **no email** and uses no paid third-party recovery service. A
recovery code is a 160-bit, single-use credential the user generates in advance and
stores themselves.

**`POST /api/auth/recovery/code`** (session required)

Body: `{ "password": "<current password>" }` → `{ "ok": true, "code": "XXXX-XXXX-…", "createdAt": … }`

Re-authenticates with the current password, because the code is an account-takeover
credential. Rate limited 5 / hour per user. Generating a code atomically replaces any
existing one, so there is never more than one live code per account. The plaintext is
returned once and never persisted — only its SHA-256 is stored.

**`GET /api/auth/recovery/status`** (session required)

Returns `{ hasCode, createdAt, expiresAt, usedAt, issuedByAdmin }`. No secret is ever
returned; a code cannot be re-read after issue.

**`POST /api/auth/recovery/reset`** (public)

Body: `{ "identifier", "recoveryCode", "password" }`

Rate limited (5 / 15 min), keyed on IP **and** identifier so one client cannot attack
many accounts from a single address. Redemption is atomic and single-use:

- The code hash must match, must not be `used`, and (for admin-issued codes) must not
  be expired.
- The code must belong to the account named by `identifier`.
- The guarded `UPDATE ... WHERE used_at IS NULL` means concurrent redemptions produce
  exactly one winner.
- On success: password replaced, lockout cleared, **all sessions revoked**.

Every failure — unknown account, no code, wrong code, expired code, already-used code,
malformed code, disabled account — returns the **same** `400 RECOVERY_FAILED` response,
so the endpoint is neither an account-enumeration nor a code-validity oracle. No email
is sent at any point.

**`POST /api/admin/users/:id/recovery-code`** (SUPER_ADMIN, audited)

Body: `{ "reason": "…" }` → `{ "ok": true, "code": "XXXX-XXXX-…", "expiresAt": … }`

The fallback for a user who lost their password and never saved a code. It issues a
single-use code valid for `ADMIN_ISSUED_CODE_TTL_HOURS` (24 h) that the administrator
hands over **after verifying the person's identity in person**. It never reveals or
sets a password, and never signs anyone in. The reason is stored in the audit log; the
code is not stored anywhere in readable form.
