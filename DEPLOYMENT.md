# XeroxEase — Deployment Guide

## Option A — Vercel (recommended for the app) + Supabase

1. **Database**: create the Supabase project (SETUP.md §2–3). Use the **pooler** URL (port 6543) as `DATABASE_URL` and the direct URL (5432) as `DIRECT_URL`.
2. **Push code** to GitHub and import the repo in Vercel.
3. **Environment variables** (Project → Settings → Environment Variables): everything from `.env.example`, with production values:
   - `SESSION_SECRET` — a fresh 32+ byte random string (never reuse dev)
   - `NEXT_PUBLIC_APP_URL` — your production URL (used for metadata/sitemap)
   - `STORAGE_BACKEND` — must be `supabase` on Vercel (see warning below), plus `STORAGE_BUCKET` (default `documents`), `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
   - `RATE_LIMIT_STORAGE=redis` with `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` for shared abuse protection across instances
   - `ENABLE_EMAIL_DELIVERY=true` with `EMAIL_API_URL` / `EMAIL_API_KEY` / `EMAIL_FROM` so password-reset links are actually delivered
   - Do **not** set `NODE_ENV`; Vercel manages it
4. **Migrations**: run once from CI or locally against production:
   ```bash
   DATABASE_URL="<pooler-url>" DIRECT_URL="<direct-url>" npx prisma migrate deploy
   ```
   If the production database was previously created with `prisma db push`, baseline it first (writes a history row only, touches no data):
   ```bash
   npx prisma migrate resolve --applied 20261013000000_init
   npx prisma migrate status
   ```
5. **First admin**: do **not** rely on `npm run db:seed` in production (it refuses the documented default passwords). Either run it with `SEED_ADMIN_PASSWORD=<strong unique value>` and rotate immediately, or create the first Super Admin through the Super Admin console.
6. **Deploy**. Build command is `prisma generate && next build` (set in package.json).

> ⚠️ With `STORAGE_BACKEND=local` on Vercel, uploaded files live on ephemeral storage and are lost between invocations while the database still references them — students would see orders whose documents have vanished. The app now **refuses to start writing** with local storage in production and fails with a clear error. Either configure Supabase Storage (`STORAGE_BACKEND=supabase`, one private bucket named by `STORAGE_BUCKET`, default `documents`), or set `ALLOW_EPHEMERAL_LOCAL_STORAGE=true` to explicitly accept possible data loss.
>
> The backend interface (`saveBuffer`, `openStream`, `fileExists`, `deleteFile`, `buildStorageKey`, `readHeader`) is fully implemented for both backends, so switching requires no code change.

### Reverse-proxy / hosting limits (uploads)

The app enforces a 100 MB per-file limit and rejects oversized bodies before parsing. Also configure the platform itself:

- Vercel has a hard request-body limit (~4.5 MB on the default plan); large uploads require a platform that permits larger bodies, or direct-to-storage uploads.
- nginx: `client_max_body_size 110M;`
- Always forward `X-Forwarded-For` so rate limiting keys on the real client IP.

### Rollback

1. Redeploy the previous build (Vercel → Deployments → Promote, or `git checkout <previous-tag>` on a VPS).
2. Migrations are forward-only: rolling back code without rolling back the schema is safe as long as the previous code does not depend on a column the new migration added. If a migration must be undone, write a new migration that reverses it — never edit an applied migration file, and never `prisma migrate reset` a production database.
3. Keep the previous build artifact available until the new release is verified.

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

- [ ] `npm run config:check` passes with `NODE_ENV=production`
- [ ] All env vars set; `.env*` not committed; `SESSION_SECRET` unique and secret (32+ chars)
- [ ] `npx prisma migrate deploy` succeeded; `prisma-studio` not exposed
- [ ] Default/seed credentials rotated or deleted
- [ ] HTTPS enforced; HSTS active (automatic in production middleware)
- [ ] Upload dir (or buckets) **private** and included in backups
- [ ] Admin accounts provisioned via Super Admin only; no shared accounts
- [ ] Payment QR uploaded + enabled in Admin → Settings
- [ ] Super Admin → Audit Logs receiving events (test a login + order)
- [ ] `npm audit` clean or triaged
- [ ] Password-reset email delivery verified end-to-end (see below)
- [ ] Backups scheduled (DB + storage) and a restore tested
- [ ] Retention policy configured (Settings → retention days)

## Monitoring & operations

- Watch server logs for `[api]` errors and `[audit]` failures
- Review `/admin/audit-logs` weekly for `LOGIN_FAILED`, `FILE_ACCESS_DENIED` anomalies
- Reconcile `payment_events` against bank/UPI statements (weekly recommended)
- Keep dependencies current: `npm outdated`, `npm audit fix`


## Verifying password-reset email delivery

Live email delivery is **not enabled by default** and has not been verified against a real provider in this repository. To complete it:

1. Create an account with a Resend-compatible HTTPS email API.
2. Set `ENABLE_EMAIL_DELIVERY=true`, `EMAIL_API_URL`, `EMAIL_API_KEY` and `EMAIL_FROM` (a verified sender on your domain).
3. Confirm `npm run config:check` reports "email delivery configured".
4. Request a reset at `/forgot-password` and confirm the message arrives and the link opens `/reset-password?token=…`.

Until step 4 succeeds, treat password-reset delivery as **unverified**. In development only, the reset link can be surfaced in the API response by setting `EXPOSE_RESET_TOKEN_IN_DEV=true`; this is ignored whenever `NODE_ENV=production` or email delivery is enabled.
