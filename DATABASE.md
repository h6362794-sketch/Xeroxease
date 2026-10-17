# XeroxEase — Database Guide

Supabase **PostgreSQL** accessed through **Prisma ORM** (`prisma/schema.prisma`).

---

## Entity overview

```
User 1─n Session              (auth sessions; token stored only as SHA-256 hash)
User 1─n Order                (student's orders)
User 1─n UploadedFile         (uploader records)
User 1─n Notification
User 1─n Feedback
User 1─n AuditLog             (actor)
User 1─n RecoveryCode        -- active recovery mechanism (one live code per user)
User 1─n PasswordResetToken   -- DEPRECATED: unused, retained only to avoid a destructive drop

Order 1─n UploadedFile        (files attached to an order)
Order 1─n OrderEvent          (status timeline events)
Order 1─n PaymentEvent        (submitted / verified / rejected audit trail)
Order 1─1 Feedback            (unique per order)
```

## Tables

| Table | Purpose | Notable columns |
|---|---|---|
| `users` | Accounts for all roles | `email_norm` (unique), `phone` (unique), `reg_no` (unique), `password_hash`, `role`, `is_active`, `failed_login_count`, `locked_until` |
| `sessions` | Server-side sessions | `token_hash` (unique), `kind`, `expires_at`, `revoked_at` |
| `recovery_codes` | Email-free account recovery | `user_id` (unique — one live code per account), `code_hash` (unique), `created_by` (null = self, else admin id), `expires_at` (null for self-issued), `used_at` |
| `password_reset_tokens` | **DEPRECATED** — backed the removed email-link reset; no longer read or written | `token_hash`, `expires_at`, `used_at` |
| `orders` | Print orders | `order_number` (unique `XE-YYYY-NNNNNN`), print config, **server-verified** `total_pages` / `billable_pages` / `total_amount`, `status`, `payment_status`, `collection_token_hash`, `collection_token_used_at` |
| `uploaded_files` | Document metadata | `storage_key` (unique), `original_name`, `mime_type`, `size_bytes`, `page_count`, `page_count_source`, `analysis_status`, `analyzed_at` |
| `order_events` | Immutable status timeline | `type`, `from_status`, `to_status`, `actor_id`, `actor_role` |
| `payment_events` | Payment audit trail | `type` (SUBMITTED/VERIFIED/REJECTED), `reference`, `amount`, `note` |
| `feedback` | Ratings (1 per order) | `order_id` (unique), `rating` 1–5, `comment`, `moderation` |
| `notifications` | In-app alerts | `type`, `is_read`, `order_id` |
| `audit_logs` | Privileged-action trail | `action`, `target_type`, `target_id`, `metadata` (JSON), `ip` |
| `pricing_config` | DB-driven rates | `key` (e.g. `A4_BW`), `unit_price`, `category`, `is_active` |
| `settings` | Key/value app settings | Payment QR config, instructions, cancellation rules, retention |

## Enums

- **Role**: `STUDENT` · `ADMIN` · `SUPER_ADMIN`
- **OrderStatus**: `ORDER_PLACED` → `PAYMENT_PENDING` → `PAYMENT_UNDER_REVIEW` → `PAYMENT_CONFIRMED` → `DOCUMENTS_RECEIVED` → `PROCESSING` → `PRINTING` → `QUALITY_CHECK` → `READY_FOR_COLLECTION` → `COMPLETED` (plus `CANCELLED`, `FAILED`); transitions validated server-side (`ORDER_TRANSITIONS` in `src/lib/constants.ts`)
- **PaymentStatus**: `PAYMENT_PENDING` · `PAYMENT_PROOF_SUBMITTED` · `PAYMENT_UNDER_REVIEW` · `PAYMENT_CONFIRMED` · `PAYMENT_REJECTED` · `PAYMENT_FAILED`
- **PageCountSource**: `DOCUMENT_PARSER` · `AI_ANALYSIS` · `ADMIN_VERIFIED` · `USER_CONFIRMED`
- **AnalysisStatus**: `PENDING` · `PROCESSING` · `COMPLETED` · `FAILED` · `NEEDS_REVIEW`

## Integrity & performance

- **Foreign keys** with `ON DELETE CASCADE` for owned records (sessions, files, events, feedback, notifications)
- **Unique constraints**: email, phone, reg no, order number, storage key, session token hash, one feedback per order, one recovery code per user (`recovery_codes.user_id`)
- **Indexes** on: `orders(userId, status)`, `orders(status)`, `orders(paymentStatus)`, `orders(createdAt)`, `orders(orderNumber)`, `sessions(userId, expiresAt)`, `notifications(userId, isRead)`, `audit_logs(action, createdAt)`, and more
- **Transactions** (`prisma.$transaction`) for order creation, status changes, payment verification/rejection, cancellation, recovery-code redemption — no partially-created orders

## Migrations

The migration history is committed in `prisma/migrations/` and is the source of truth for schema changes.

```bash
npx prisma migrate dev --name <name>    # develop (creates migration SQL — commit the generated file)
npx prisma migrate deploy               # production (applies pending migrations only)
npx prisma migrate status               # show which migrations are applied
npx prisma generate                     # regenerate Prisma Client — makes NO database changes
npx prisma studio                       # browse data (never expose publicly)
```

Keep the two steps separate in CI/CD: `prisma generate` is a build step (needs no database), `prisma migrate deploy` is a release step (needs the database).

### Existing databases (no migration history)

If this schema was previously created with `prisma db push`, the tables exist but `_prisma_migrations` is empty. Running `migrate deploy` would try to recreate them and fail. Baseline it once — this **only records the migration as applied** and modifies no data:

```bash
npx prisma migrate resolve --applied 20261013000000_init
npx prisma migrate status     # should report: Database schema is up to date
```

### Initial migration

`prisma/migrations/20261013000000_init/migration.sql` creates every table, enum, index and foreign key declared in `prisma/schema.prisma`.

### Rollback planning

Prisma migrations are forward-only. To reverse a change, write and commit a **new** migration that undoes it. Never edit an already-applied migration file. Never run `prisma migrate reset`, `prisma db push --force-reset` or `DROP TABLE` against production data.

Connection config uses `DATABASE_URL` (runtime, pooler-friendly) and `DIRECT_URL` (migrations) — see `.env.example`.

**Pooler note (Prisma ≥ 6):** Prisma uses prepared statements.
Current Supabase poolers (Supavisor / PgBouncer ≥ 1.21 with
`max_prepared_statements > 0`) pool named prepared statements
correctly, so the transaction-mode pooler URL (port 6543) works
**without any extra query parameter**. Only pre-1.21 poolers need
`?pgbouncer=true`; on a modern pooler that flag is unnecessary and
can itself cause `prepared statement "PGBOUNCER_…" does not exist`
(prisma/prisma#21799). Never put `pgbouncer=true` on `DIRECT_URL`:
migrations use advisory locks and need a direct/session connection.
`src/server/db-config.ts` validates both URLs at startup and in
`npm run config:check`, printing sanitised warnings (never the URL
or password) when the configuration is ambiguous or unsafe.

## Backups & recovery

- **Supabase built-in backups**: daily backups on paid plans; verify under *Database → Backups*. For free tier, schedule `pg_dump` externally (see DEPLOYMENT.md).
- **Recommended cadence**: database daily, storage bucket sync weekly, audit logs retained ≥ 1 year.
- **Recovery**: restore the Postgres dump to a fresh Supabase project, update `DATABASE_URL`/`DIRECT_URL`, re-point storage to the restored bucket, run `npx prisma migrate deploy` to confirm schema state.
- **Payment reconciliation**: `payment_events` + `orders.payment_ref` provide the reference trail to reconcile against bank/UPI statements.

## Data retention

- Configurable via Super Admin → Settings (`retentionDays`, default 30): completed-order files may be purged after N days while order metadata is retained for accounting.
- Sessions expire automatically (`expiresAt`) and can be swept by a periodic job. Recovery codes never expire unless an administrator issued them (`expires_at` is null for self-generated codes); a used code stays in its row with `used_at` set so the account shows "code used" and can be prompted to rotate it.
