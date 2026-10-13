# XeroxEase — Setup Guide

From zero to running with a **fresh Supabase project**. No source-code edits required — everything is configured via environment variables.

---

## 1. Prerequisites

- Node.js 20+ and npm 10+
- A [Supabase](https://supabase.com) account (free tier works)

---

## 2. Create a Supabase project

1. Go to https://supabase.com/dashboard → **New project**
2. Choose a name (e.g., `xeroxease`), a strong database password, and a region near your users
3. Wait for provisioning (~2 minutes)

---

## 3. Collect connection details

In the Supabase dashboard: **Project Settings → Database → Connection string → URI**

- **Direct connection** (port `5432`) — used for migrations. Also set as `DIRECT_URL`.
- **Connection pooler** (port `6543`, pgbouncer) — recommended for `DATABASE_URL`on serverless deployments. Append `?pgbouncer=true&connection_limit=1`.

You also need:

- **Settings → API** → Project URL (`NEXT_PUBLIC_SUPABASE_URL`), anon key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`), service-role key (`SUPABASE_SERVICE_ROLE_KEY` ").

---

## 4. Configure environment

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```env
# --- Database ---
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@db.YOUR_PROJECT_REF.supabase.co:6543/postgres"
DIRECT_URL="postgresql://postgres:YOUR_PASSWORD@db.YOUR_PROJECT_REF.supabase.co:5432/postgres"

# --- Supabase (needed only when STORAGE_BACKEND=supabase) ---
NEXT_PUBLIC_SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="<anon-key>"
SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"   # server only!

# --- Auth / Session ---
SESSION_SECRET="<run: openssl rand -base64 32>"  # minimum 32 characters
SESSION_TTL_HOURS="24"

# --- App ---
NEXT_PUBLIC_APP_URL="http://localhost:3000"      # https URL in production

# --- Storage ---
STORAGE_BACKEND="local"                          # use "supabase" in production
STORAGE_BUCKET="documents"
LOCAL_STORAGE_DIR=".data/uploads"
```

> Generate `SESSION_SECRET` with `openssl rand -base64 32` (or any long random string). Never commit `.env.local` — it is gitignored.
> Validate the whole file at any time with `npm run config:check`.

> Generate `SESSION_SECRET` with `openssl rand -base64 32` (or any long random string). Never commit `.env.local` — it is gitignored.

---

## 5. Apply the database schema

```bash
npm install
npx prisma migrate deploy     # applies the committed migrations in prisma/migrations/
npx prisma generate           # regenerates Prisma Client (no database changes)
```

This creates all tables (users, sessions, orders, files, pricing, payments, feedback, notifications, audit logs, settings) with constraints and indexes. **No manual table creation in the Supabase dashboard is needed.**

> **Existing database?** If the schema was previously created with `prisma db push`, the tables already exist but there is no migration history. Baseline it once (this only writes a history row — it does **not** modify data):
>
> ```bash
> npx prisma migrate resolve --applied 20261013000000_init
> npx prisma migrate status
> ```
>
> Use `npx prisma migrate dev` only for local schema changes; it creates a new migration file that you then commit.

---

## 6. (Optional) Configure Supabase Storage buckets

If you switch `STORAGE_BACKEND=supabase`, create **private** buckets (no public access):

| Bucket | Purpose |
|---|---|
| `documents` | Everything the app stores: uploaded documents and the admin-managed payment QR (private) |

Earlier revisions of this guide listed three buckets (`student-documents`, `payment-qr`, `invoices`). **The code has always used a single bucket**, so those extra buckets are not needed and were never read. The bucket name is configurable with `STORAGE_BUCKET` and defaults to `documents`, so an existing deployment keeps working unchanged.

1. Create **one** private bucket named `documents` (disable public access).
2. Do **not** add permissive RLS/Storage policies — the app reads and writes with the service-role key from the server only.
3. Keep `SUPABASE_SERVICE_ROLE_KEY` server-side. It is read only from `src/server/storage.ts`.

If you already created objects in a different bucket name, set `STORAGE_BUCKET` to that name instead of moving files.

The default `STORAGE_BACKEND=local` stores files in the private `.data/uploads` directory (gitignored) with authorization-gated streaming — suitable for single-server deployments.

---

## 7. Seed development data

```bash
npm run db:seed
```

This is **development-only**. In production the seed refuses to create accounts with the documented default passwords; supply `SEED_STUDENT_PASSWORD` / `SEED_ADMIN_PASSWORD` (12+ characters) or create administrators through the Super Admin console. Seeded demo orders are skipped in production.

Creates: default pricing (A4/Legal × B&W/Colour + finishing), a student, an admin, a Super Admin, two demo orders, one feedback record, and default system settings. See [`SEED.md`](SEED.md) for credentials.

---

## 8. Run

```bash
npm run dev        # development
npm run build && npm start   # production
```

---

## 9. Post-setup checklist (admin)

1. Sign in at `/admin/login` as the Super Admin
2. **Settings → Payment QR**: upload your UPI QR image, enable it, set payment instructions
3. **Pricing**: adjust rates for your print desk
4. **Users → Create admin**: provision desk staff accounts
5. Verify a test order end-to-end (upload → analyze → order → QR → submit reference → verify → print → ready → collect)

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `P1001: can't reach database` | Check the connection string; if using the pooler for migrations, use the direct URL for `DIRECT_URL` |
| `P1012` schema validation | Ensure both `DATABASE_URL` and `DIRECT_URL` are set |
| `Missing required environment variable: SESSION_SECRET` | Add `SESSION_SECRET` to `.env.local` |
| Upload fails with 500 | Ensure `LOCAL_STORAGE_DIR` is writable by the server process |
| Payments show "QR not configured" | Upload + enable the QR in Admin → Settings |


