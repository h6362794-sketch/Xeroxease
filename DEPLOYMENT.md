# XeroxEase — Deployment Guide

## Option A — Vercel (recommended for the app) + Supabase

1. **Database**: create the Supabase project (SETUP.md §2–3). Use the **pooler** URL (port 6543) as `DATABASE_URL` and the direct URL (5432) as `DIRECT_URL`.
2. **Push code** to GitHub and import the repo in Vercel.
3. **Environment variables** (Project → Settings → Environment Variables): everything from `.env.example`, with production values:
   - `SESSION_SECRET` — a fresh 32+ byte random string (never reuse dev)
   - `NEXT_PUBLIC_APP_URL` — your production URL (used for metadata/sitemap)
   - `STORAGE_BACKEND` — `local` works on single-instance hosts only; for Vercel's filesystem, switch to `STORAGE_BACKEND=supabase` with private buckets
   - Do **not** set `NODE_ENV`; Vercel manages it
4. **Migrations**: run once from CI or locally against production:
   ```bash
   DATABASE_URL="<pooler-url>" DIRECT_URL="<direct-url>" npx prisma migrate deploy
   ```
5. **Seed / first admin**: run `npm run db:seed` against production only if acceptable, or create the first Super Admin via a one-off script — then **immediately change the password**.
6. **Deploy**. Build command is `prisma generate && next build` (set in package.json).

> ⚠️ With `STORAGE_BACKEND=local` on Vercel, uploaded files live on ephemeral storage and are lost between invocations. For production on Vercel, use Supabase Storage (private buckets) and adapt `src/server/storage.ts`'s backend functions to Supabase Storage — the interface (`saveBuffer`, `openStream`, `fileExists`, `deleteFile`, `buildStorageKey`) is intentionally small.

## Option B — VPS / Docker (full control, local storage OK)

```bash
# Node 20+, process manager (pm2/systemd), reverse proxy (nginx/caddy) with TLS
git clone <repo> && cd xeroxease
cp .env.example .env.local        # fill production values
npm ci
npx prisma migrate deploy
npm run build
pm2 start npm --name xeroxease -- start   # or systemd unit
```

Reverse proxy requirements:
- Terminate TLS (e.g., Let's Encrypt via Caddy or certbot)
- `client_max_body_size 110M;` (nginx) for 100 MB uploads
- Forward `X-Forwarded-For` so rate limiting sees real client IPs

Persistent storage: point `LOCAL_STORAGE_DIR` at a durable volume and back it up.

## Post-deploy security checklist

- [ ] All env vars set; `.env*` not committed; `SESSION_SECRET` unique and secret
- [ ] `npx prisma migrate deploy` succeeded; `prisma-studio` not exposed
- [ ] Default/seed credentials rotated or deleted
- [ ] HTTPS enforced; HSTS active (automatic in production middleware)
- [ ] Upload dir (or buckets) **private** and included in backups
- [ ] Admin accounts provisioned via Super Admin only; no shared accounts
- [ ] Payment QR uploaded + enabled in Admin → Settings
- [ ] Super Admin → Audit Logs receiving events (test a login + order)
- [ ] `npm audit` clean or triaged
- [ ] Backups scheduled (DB + storage) and a restore tested
- [ ] Retention policy configured (Settings → retention days)

## Monitoring & operations

- Watch server logs for `[api]` errors and `[audit]` failures
- Review `/admin/audit-logs` weekly for `LOGIN_FAILED`, `FILE_ACCESS_DENIED` anomalies
- Reconcile `payment_events` against bank/UPI statements (weekly recommended)
- Keep dependencies current: `npm outdated`, `npm audit fix`
