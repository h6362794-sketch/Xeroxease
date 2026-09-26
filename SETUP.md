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
DATABASE_URL=t=1"
DIRECT_URL="

NEXT_PUBLIC_SUPABASE_URL="
NEXT_PUBLIC_SUPABASE_ANON_KEY="<anon-key>"
SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"   # server only!

SESSION_SECRET="<run: openssl rand -base64 32>"
SESSION_TTL_HOURS="24"
NEXT_PUBLIC_APP_URL="http://localhost:3000"

STORAGE_BACKEND="local"
LOCAL_STORAGE_DIR=".data/uploads"
```

> Generate `SESSION_SECRET` with `openssl rand -base64 32` (or any long random string). Never commit `.env.local` — it is gitignored.

---

## 5. Apply the database schema

```bash
npm install
npx prisma migrate dev --name init
npx prisma generate
```

This creates all tables (users, sessions, orders, files, pricing, payments, feedback, notifications, audit logs, settings) with constraints and indexes. **No manual table creation in the Supabase dashboard is needed.**

---

## 6. (Optional) Configure Supabase Storage buckets

If you switch `STORAGE_BACKEND=supabase`, create **private** buckets (no public access):

| Bucket | Purpose |
|---|---|
| `student-documents` | Uploaded documents (private) |
| `payment-qr` | Admin-managed payment QR images (private) |
| `invoices` | Generated invoices (private) |

Policies: keep buckets fully private and access files only through the app's authorized API routes. Never expose the service-role key client-side.

The default `STORAGE_BACKEND=local` stores files in the private `.data/uploads` directory (gitignored) with authorization-gated streaming — suitable for single-server deployments.

---

## 7. Seed development data

```bash
npm run db:seed
```

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


