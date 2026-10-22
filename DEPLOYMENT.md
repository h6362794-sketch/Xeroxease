# XeroxEase — Deployment Guide

## Option A — Vercel (recommended for the app) + Supabase

1. **Database**: create the Supabase project (SETUP.md §2–3). Use the **transaction-mode pooler** URL (port 6543, with `?pgbouncer=true` — transaction pooling cannot carry Prisma's prepared statements) as `DATABASE_URL`, and the direct URL (5432) as `DIRECT_URL`. Do **not** add `connection_limit=1`: with the singleton Prisma client it leaves one pooled connection and makes concurrent queries time out with `P2024` (see SETUP.md §3). `npm run config:check` prints sanitised diagnostics if the configuration is ambiguous.
2. **Push code** to GitHub and import the repo in Vercel.
3. **Environment variables** (Project → Settings → Environment Variables): everything from `.env.example`, with production values:
   - `SESSION_SECRET` — a fresh 32+ byte random string (never reuse dev)
   - `NEXT_PUBLIC_APP_URL` — your production URL (used for metadata/sitemap)
   - `STORAGE_BACKEND` — must be `supabase` on Vercel (see warning below), plus `STORAGE_BUCKET` (default `documents`), `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
   - `RATE_LIMIT_STORAGE=redis` with `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` for shared abuse protection across instances
   - `TRUSTED_PROXY_COUNT` — number of reverse-proxy hops in front of the app (Vercel: `1`). Set `0` only if the app is directly exposed; see SECURITY.md
   - `DIRECT_UPLOADS_ENABLED=true` (default), `UPLOAD_INTENT_TTL_SECONDS=600`, `SIGNED_DOWNLOAD_URL_TTL_SECONDS=60` and, **for Supabase Free-tier deployments, `STORAGE_PROVIDER_MAX_FILE_BYTES=52428800`** (50 MB). See [`UPLOADS.md`](UPLOADS.md).
   - Do **not** set `NODE_ENV`; Vercel manages it

   There is **no email/SMS configuration**: password recovery is email-free (recovery
   codes). Do not add `EMAIL_*`, `SMTP_*` or an SMS provider without also adding the
   integration that uses them.
4. **Migrations**: run once from CI or locally against production:
   ```bash
   DATABASE_URL="<pooler-url>" DIRECT_URL="<direct-url>" npx prisma migrate deploy
   ```
   **If the production database was previously created with `prisma db push`, you must
   baseline it — but verify first.** `--applied` only writes a history row; it does not
   check anything. Marking a migration applied when the schema does not actually match
   it is the single easiest way to corrupt a future migration run.

   Step 1 — prove the live schema matches the migrations, using a throwaway shadow
   database (it is created, diffed and dropped; your data is never touched):

   ```bash
   # Create an empty database the diff can use as scratch space.
   createdb xeroxease_shadow   # or create it in your provider's dashboard

   # Exits non-zero if the committed migrations do not reproduce schema.prisma.
   npx prisma migrate diff \
     --from-migrations prisma/migrations \
     --to-schema-datamodel prisma/schema.prisma \
     --shadow-database-url "<postgres-url-for-xeroxease_shadow>" \
     --exit-code

   # And prove the LIVE database already matches schema.prisma.
   npx prisma migrate diff \
     --from-url "$DATABASE_URL" \
     --to-schema-datamodel prisma/schema.prisma \
     --exit-code
   ```

   Both must exit 0. If the second one reports differences, **stop** — your production
   schema and your code disagree. Resolve that (usually with a new migration that
   reconciles them) before continuing. Do not baseline over a difference.

   Step 2 — only now record the baseline:

   ```bash
   npx prisma migrate resolve --applied 20261013000000_init
   npx prisma migrate resolve --applied 20261014000000_recovery_codes   # only if the table already exists
   npx prisma migrate status
   ```

   A fast text-level consistency check that needs no database at all is also available:
   `npm run schema:check`. CI runs it on every push, and also runs the authoritative
   `migrate diff` above against a real PostgreSQL 16 container.
5. **First admin**: do **not** rely on `npm run db:seed` in production (it refuses the documented default passwords). Either run it with `SEED_ADMIN_PASSWORD=<strong unique value>` and rotate immediately, or create the first Super Admin through the Super Admin console.
6. **Deploy**. Build command is `prisma generate && next build` (set in package.json).

> ⚠️ With `STORAGE_BACKEND=local` on Vercel, uploaded files live on ephemeral storage and are lost between invocations while the database still references them — students would see orders whose documents have vanished. The write guard (`assertDurableBackend`, `src/server/storage.ts`) refuses such a write with a `StorageError`, and `npm run config:check` fails the deploy for the same configuration with an explicit message.
>
> **Be precise about how the guard behaves:** it is a **write-time** check on the paths that save bytes, not a boot-time check, and `withErrorHandling` renders any 5xx to the browser as "Something went wrong. Please try again." — the actionable text is in the **server log**, not the user's screen. So `config:check` in the pipeline (not the runtime guard) is what stops a misconfigured deploy. There is no automatic fallback to local storage; direct uploads simply return 501 with the reason.
>
> Backend interface (`src/server/storage.ts`): `saveBuffer`, `openStream`, `readBuffer`, `fileExists`, `deleteFile`, `buildStorageKey`, `readHeader`, plus the direct-upload set `createSignedUploadTarget`, `getStoredObjectInfo`, `createSignedDownloadUrl` and the `assertDirectUploadBackend()` probe. Swapping `STORAGE_BACKEND` needs no code change; `local` additionally keeps the proxy upload path and loses the direct one (501 by design).

### Reverse-proxy / hosting limits (uploads)

The app enforces a 50 MiB (52,428,800 bytes) per-file limit (inclusive) and rejects oversized bodies before parsing. Two independent ceilings apply to a deployment:

| Ceiling | Value | Who enforces it | What happens when it is smaller than 50 MiB |
|---|---|---|---|
| Vercel Function request **and** response body | 4.5 MB, not raisable | Vercel, at the edge | **Avoided, not raised:** with direct uploads the bytes go browser → Supabase Storage and the answer to a download is a 307 to a signed URL, so no 50 MB body ever crosses a function. Only the legacy proxy path (`STORAGE_BACKEND=local`, dev) and the ≤5 MB payment QR still cross it. |
| Supabase per-file limit | **50 MB on Free**, up to 500 GB on Pro+ | Supabase Storage, mid-transfer | Mirror the provider cap in `STORAGE_PROVIDER_MAX_FILE_BYTES` to fail fast at intent time. The Free-tier cap matches the application limit. |
| nginx / your proxy | `client_max_body_size` (you set it) | the proxy | Only relevant if you keep the proxy path: set `client_max_body_size 55M;`. With direct uploads, nothing but the small JSON intent calls reaches the app. |

- Always forward `X-Forwarded-For` so rate limiting keys on the real client IP, and set `TRUSTED_PROXY_COUNT` to the true hop count.
- Keep the app on **one origin**: sessions are first-party cookies and CORS is not configured (`CSP: connect-src 'self'`).
- `maxDuration` on `/api/uploads` is 60 s; direct uploads do not depend on it because the function never handles the body.

### Backup

Before any migration:

```bash
pg_dump "$DATABASE_URL" --format=custom --file=xeroxease-$(date +%F).dump
```

Test that you can restore it into a scratch database before you trust it. Also snapshot
your storage bucket (uploaded documents) — the database references files by key, so a
database restore without a matching storage restore leaves orders pointing at nothing.

Retention and scheduling are your responsibility; nothing in the app does this for you.
Never run `prisma migrate reset` or `prisma db push --force-reset` against production.

### Rollback

1. Redeploy the previous build (Vercel → Deployments → Promote, or `git checkout <previous-tag>` on a VPS).
2. The `20261014000000_recovery_codes` migration is additive only, so rolling back the
   *code* while leaving the new table in place is safe: previous releases simply never
   read it. If you must undo it, write a new migration that drops it.
3. Migrations are forward-only: rolling back code without rolling back the schema is only safe if the target build understands every enum label already written to the database (for example, once `ORDER_RECEIVED` / `DELIVERED` orders exist after the October 20 migrations, never promote a pre-PR-#13 build without restoring the pre-migration `pg_dump -Fc` backup — see [`DATABASE.md`](DATABASE.md) §*Production Migration & Recovery Runbook*). Never edit an applied migration file, and never `prisma migrate reset` a production database.
4. Keep the previous build artifact and verified pre-migration `pg_dump -Fc` backup available until the new release is verified.

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
- `client_max_body_size 55M;` (nginx) for 50 MB uploads
- Forward `X-Forwarded-For` so rate limiting sees real client IPs

Persistent storage: point `LOCAL_STORAGE_DIR` at a durable volume and back it up.

With `STORAGE_BACKEND=local` there is **no direct upload path** (`/api/uploads/intent`
answers 501): documents go through the app and are bounded by your proxy's body limit,
which is fine at 110 MB on nginx. `config:check` fails a *production* `local` deployment
on exactly this point — if you run a durable VPS with local storage deliberately, either
switch to Supabase Storage or accept the warning path consciously rather than silencing
the check.

## Post-deploy security checklist

- [ ] `npm run config:check` passes with `NODE_ENV=production`
- [ ] All env vars set; `.env*` not committed; `SESSION_SECRET` unique and secret (32+ chars)
- [ ] `npx prisma migrate deploy` succeeded; `prisma-studio` not exposed
- [ ] Default/seed credentials rotated or deleted
- [ ] HTTPS enforced; HSTS active (automatic in production middleware)
- [ ] Upload dir (or buckets) **private** and included in backups
- [ ] `STORAGE_BUCKET` exists as a **private** bucket; per-file provider limit ≥ 50 MiB (or `STORAGE_PROVIDER_MAX_FILE_BYTES` mirrors the lower cap on purpose)
- [ ] Direct-upload round trip exercised end to end at the **largest size the provider actually allows** — verify against a real Supabase bucket. The test has **not** been run by this repository's CI. Work through the nine manual
  provider checks in [`UPLOADS.md`](UPLOADS.md) §8.1 — the app returns 2xx against a bucket
  that fails check 1, because it never looks at the public URL. Record the exact size you tested; do not report "50 MB verified" without it.
- [ ] `POST /api/admin/uploads/sweep` scheduled somewhere (cron / Vercel Cron / a reminder), since there is no in-app scheduler for abandoned uploads
- [ ] Admin accounts provisioned via Super Admin only; no shared accounts
- [ ] Payment QR uploaded + enabled in Admin → Settings
- [ ] Super Admin → Audit Logs receiving events (test a login + order)
- [ ] `npm audit` clean or triaged
- [ ] Account recovery understood by staff: users self-serve at **Profile → Security**; users with no code are handled by a Super Admin issuing one from **Admin → Users** after in-person ID verification
- [ ] Backups scheduled (DB + storage) and a restore tested
- [ ] Retention policy configured (Settings → retention days)

## Monitoring & operations

- Watch server logs for `[api]` errors and `[audit]` failures
- Review `/admin/audit-logs` weekly for `LOGIN_FAILED`, `FILE_ACCESS_DENIED` anomalies
- Reconcile `payment_events` against bank/UPI statements (weekly recommended)
- Keep dependencies current: `npm outdated`, `npm audit fix`


## Verifying account recovery

Recovery is email-free, so there is no mail transport to verify. Verify these four
behaviours instead, against staging first:

1. **Self-service setup** — sign in, open **Profile → Security**, generate a code, copy
   it, sign out.
2. **Self-service reset** — at `/forgot-password`, submit the identifier + code + a new
   password. Expect redirect to `/login?reset=1` and a successful sign-in with the new
   password.
3. **Single use** — repeat step 2 with the same code. It must fail with the generic
   `RECOVERY_FAILED` message.
4. **Admin fallback** — as Super Admin, open **Admin → Users → Recovery code**, give a
   reason, and hand the returned code to the user. Confirm the audit log records
   `RECOVERY_CODE_ADMIN_ISSUED` with the reason, and that the code works once at
   `/forgot-password` and expires after 24 h.

Confirm no plaintext code ever appears in the database, server logs or audit metadata:

```sql
-- must return 0 rows for a code you just issued
SELECT count(*) FROM recovery_codes WHERE code_hash !~ '^[0-9a-f]{64}$';
```
