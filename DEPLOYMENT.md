# XeroxEase — Deployment Guide

## Option A — Vercel (recommended for the app) + Supabase

1. **Database**: create the Supabase project (SETUP.md §2–3). Use the **pooler** URL (port 6543) as `DATABASE_URL` and the direct URL (5432) as `DIRECT_URL`.
2. **Push code** to GitHub and import the repo in Vercel.
3. **Environment variables** (Project → Settings → Environment Variables): everything from `.env.example`, with production values:
   - `SESSION_SECRET` — a fresh 32+ byte random string (never reuse dev)
   - `NEXT_PUBLIC_APP_URL` — your production URL (used for metadata/sitemap)
   - `STORAGE_BACKEND` — must be `supabase` on Vercel (see warning below), plus `STORAGE_BUCKET` (default `documents`), `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
   - `RATE_LIMIT_STORAGE=redis` with `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` for shared abuse protection across instances
   - `TRUSTED_PROXY_COUNT` — number of reverse-proxy hops in front of the app (Vercel: `1`). Set `0` only if the app is directly exposed; see SECURITY.md
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

> ⚠️ With `STORAGE_BACKEND=local` on Vercel, uploaded files live on ephemeral storage and are lost between invocations while the database still references them — students would see orders whose documents have vanished. The app now **refuses to start writing** with local storage in production and fails with a clear error. Either configure Supabase Storage (`STORAGE_BACKEND=supabase`, one private bucket named by `STORAGE_BUCKET`, default `documents`), or set `ALLOW_EPHEMERAL_LOCAL_STORAGE=true` to explicitly accept possible data loss.
>
> The backend interface (`saveBuffer`, `openStream`, `fileExists`, `deleteFile`, `buildStorageKey`, `readHeader`) is fully implemented for both backends, so switching requires no code change.

### Reverse-proxy / hosting limits (uploads)

The app enforces a 100 MB per-file limit and rejects oversized bodies before parsing. Also configure the platform itself:

- Vercel has a hard request-body limit (~4.5 MB on the default plan); large uploads require a platform that permits larger bodies, or direct-to-storage uploads.
- nginx: `client_max_body_size 110M;`
- Always forward `X-Forwarded-For` so rate limiting keys on the real client IP.

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
3. Migrations are forward-only: rolling back code without rolling back the schema is safe as long as the previous code does not depend on a column the new migration added. If a migration must be undone, write a new migration that reverses it — never edit an applied migration file, and never `prisma migrate reset` a production database.
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
