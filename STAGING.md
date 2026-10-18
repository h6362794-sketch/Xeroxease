# Staging runbook (preparation)

Status of this document: **preparation only.** Nothing in it has been executed against a
real staging environment. Every step marked **[USER]** must be done by the operator with
their own accounts. No secret values belong in this file, in commits, or in chat.

Branch: `arena/89406898-xeroxease` (PR #9). Scope: the staging environment, its variables,
the bootstrap of the first Super Admin, and a manual smoke test.

---

## 1. Current state (verified from the sandbox)

| Item | Result |
|---|---|
| Existing Supabase project | **One project exists** in the connected `xeroxease` organisation (Supabase connector now enabled). Region ap-northeast-1, status active. Not confirmed as a designated test project; its name is generic. Read-only inspection only: nothing written, created or spent. |
| Schema on that project | XeroxEase schema is applied (all 14 Prisma tables, plus `_prisma_migrations`). Applied migrations: `20261013000000_init`, `20261014000000_recovery_codes`, `20261015000000_direct_upload_intents`. **Missing:** `20261018000000_payment_reference_unique`. |
| Data on that project (counts only) | 4 users, 2 orders, 0 payment events, 22 audit-log rows. This looks like test activity, but it has existing data, so it is not a clean staging database. |
| Normalised duplicate check on that project | Zero rows (read-only SELECT, from the migration header). The unique-index migration can apply once you approve. |
| Sandbox env | No Supabase or database variables are set in the sandbox. Sandbox egress does not reach `supabase.co`. |
| Sandbox egress to `supabase.co` / `vercel.com` | **Not reachable** (allowlist is GitHub, npm and PyPI only). The staging run must happen outside this sandbox. |
| Repo config check (`npm run config:check`) | Exits 1 with no env (4 missing). With a production-profile dummy env it fails on `NEXT_PUBLIC_APP_URL` not being `https`. Config checks are therefore active; the real values still need supplying. |

---

## 2. [USER] Setup steps

Costs are at the stated list prices (checked 2026-10; re-check before purchase). Budget is $0 unless you approve otherwise.

1. **[USER] Choose the staging Supabase project.** Either:
   - **(a)** Reuse the existing project in the `xeroxease` organisation, **only** if you
     confirm it is a designated test environment and not production. It already has the
     schema and some test data, so the migration and seed steps write into it. Apply
     `20261018000000_payment_reference_unique` first, after the normalised check passes.
   - **(b)** Create a new project. The Free plan is $0 with a 50 MB per-file limit and
     pauses after inactivity. Pro is $25/month.
   Record the project URL and keys only in your secret manager, never here.
2. **[USER] Create a private storage bucket** named to match `STORAGE_BUCKET` (default
   `documents`). Keep it private. Set the bucket's global per-file limit to match
   `STORAGE_PROVIDER_MAX_FILE_BYTES`. Do **not** enable public access.
3. **[USER] Get the two database connection strings** from the project: the transaction
   pooler (port 6543) for `DATABASE_URL`, and the direct connection (port 5432) for
   `DIRECT_URL`, which migrations need.
4. **[USER] Choose a host** for the staging app. `DEPLOYMENT.md` assumes Vercel
   (Hobby is $0 for personal, non-commercial use; Pro is $20/month per deploying seat).
   Staging is a preview of the `arena/89406898-xeroxease` branch, not production.
5. **[USER] Set the environment variables** (section 3) on the **Preview** scope only.
   Do not set them on Production.
6. **[USER] Pin the staging target, then run the checks** locally with the staging values
   loaded from your secret manager into the shell, not typed into a file. Set
   `DEPLOY_TARGET=staging` and `EXPECTED_SUPABASE_PROJECT_REF=<the staging project's ref>`
   (the 20-letter ref in the project URL; not a secret). Then run `npm run guard:target`,
   which must print that the URLs belong to the pinned project, and `npm run config:check`,
   which should pass for the production profile. Do not continue past this step on a failure:
   the guard means a copied production URL cannot be used by mistake.
7. **[USER] Apply migrations** to the staging database with the direct URL. Run
   `npm run guard:target` again first; it must pass in the same shell. Then
   `npx prisma migrate deploy`. Do **not** use `npm run db:migrate`
   (that is `prisma migrate dev`, which is for local development).
   Before the unique payment-reference migration runs, check the normalised duplicate
   query in its header against the database. It must return zero rows. A fresh staging
   database trivially passes; a restored copy must be checked.
8. **[USER] Bootstrap the first Super Admin.** The Super Admin console needs an existing
   Super Admin, so the seed is the only bootstrap path. Run it with `NODE_ENV=production`
   so the seed refuses the published default passwords and skips demo orders:
   `NODE_ENV=production SEED_ADMIN_EMAIL=<email> SEED_ADMIN_PASSWORD=<strong, ≥12 chars, upper, lower, digit> npm run db:seed`
   With the target pinned, the seed runs the same guard first and refuses to write on a mismatch.
   Enter the password from your secret manager. Do not put it in shell history.
   After first sign-in, create named admins through the Super Admin console and retire the
   seed account.
9. **[USER] Deploy the preview** of `arena/89406898-xeroxease`. Vercel (or your host) sets
   `NODE_ENV` for deployed builds; do not set it manually (`DEPLOYMENT.md`).
10. **[USER] Enable the payment QR** as Super Admin: Admin → Settings → upload QR. Until
    this is set, `GET /api/payment/qr` returns `enabled: false` and students cannot see a QR.
11. **[USER] Run the nine provider checks** in `UPLOADS.md` §8.1 against the staging bucket.
    Record the exact file size you tested. Do not report "50 MB verified" without a size.
    The app returns success even when check 1 (the bucket is private) fails.
12. **[USER] Run the smoke test** in section 4 and record each result.

---

## 3. Environment variables (names only; values are never recorded here)

Required in staging unless marked optional.

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Pooler, port 6543. |
| `DIRECT_URL` | Direct, port 5432. Migrations only. |
| `SESSION_SECRET` | ≥32 characters, unique to staging. |
| `SESSION_TTL_HOURS` | Session lifetime. |
| `NEXT_PUBLIC_APP_URL` | `https://` staging origin. Build-time: **rebuild** if it changes. |
| `NEXT_PUBLIC_SUPABASE_URL` | Staging project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only. Never expose to the browser. |
| `STORAGE_BACKEND` | Must be `supabase` on Vercel. |
| `STORAGE_BUCKET` | Default `documents`. Must be **private**. |
| `DIRECT_UPLOADS_ENABLED` | `true` to exercise the browser → storage path. |
| `UPLOAD_INTENT_TTL_SECONDS` | 60–3600, default 600. |
| `SIGNED_DOWNLOAD_URL_TTL_SECONDS` | 10–900, default 60. |
| `STORAGE_PROVIDER_MAX_FILE_BYTES` | Must match the bucket's real limit. Confirm the exact Free-plan byte value before setting it; this is not verified. |
| `TRUSTED_PROXY_COUNT` | `1` on Vercel. |
| `RATE_LIMIT_STORAGE` | `memory` or `redis`. Use `redis` if preview runs more than one instance. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Only with `redis`. Upstash pricing not verified. |
| `RATE_LIMIT_FAIL_OPEN` | Keep `false`. |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Seed only. Password mandatory with `NODE_ENV=production`. |
| `CRON_SECRET` | Scheduler bearer, at least 32 characters. Staging Preview only. The same value must be the GitHub `staging` environment secret. Never set on Production by this change. |
| `DEPLOY_TARGET`, `EXPECTED_SUPABASE_PROJECT_REF` | Staging pin. `DEPLOY_TARGET=staging` and the project ref (not secret). The config check, `guard:target` and the seed refuse any URL not belonging to that project. Preview scope only. |
| `SEED_STUDENT_EMAIL`, `SEED_STUDENT_PASSWORD` | Optional. The smoke test registers a fresh student. |

Must **not** be set in staging: `ALLOW_DEV_SEED`, `ALLOW_EPHEMERAL_LOCAL_STORAGE`, `NODE_ENV`
(set by the host). `ENABLE_*` and `AI_DOCS_*` flags have no effect in the app.
`NEXT_PUBLIC_SUPABASE_ANON_KEY` is not read by the app.

---

## 4. Smoke test (manual, step by step)

Run this only against the **staging** deployment, with the staging Supabase project, after
section 2 steps 1–8 and `npm run guard:target` passed in the shell you run from. Stop at the
first unexpected result and record it in section 6.

**Rules for this test**

- Use a fresh browser profile for each role. Use test emails you control. Use only the
  test data in this section. Never a real student's documents or payment reference.
- Payment references: use `TEST-<yyyymmdd>-<n>` (for example `TEST-20261018-01`). Never a real UPI reference.
- Curl steps: copy the `xe_session` cookie value from devtools into a shell variable that
  you clear afterwards. Never paste it into chat, a commit, or a ticket. Secrets such as
  `CRON_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` come from the secret manager into the
  environment, never typed into a file.
- Cost: Free plan. Keep test uploads small except where a check says otherwise.
  Record the result, and do not upload repeatedly to chase a number.

### 4A. Supabase storage checks (UPLOADS.md §8.1)

Run these first, because the rest of the workflow depends on the bucket behaving correctly.
Record the exact file size used for each.

| Check | Procedure | Expected |
|---|---|---|
| 1. Bucket is private | `curl -sS -o /dev/null -w '%{http_code}\n' "$SUPABASE_URL/storage/v1/object/public/$STORAGE_BUCKET/<a key you uploaded>"` with no credentials | Not `200`. Record the code. |
| 2. Signed upload URL writes only its own path | Mint an intent (S3). Take its signed URL. `PUT` the bytes to that URL. Then `PUT` the same bytes to the same URL with the object name changed to a different key. | First `2xx`. Second refused (`4xx`). |
| 3. Existing object is not overwritten | `PUT` the same key a second time through a fresh signed URL for that key. | Refused. The first object is unchanged. |
| 4. `expiresIn` is honoured | Mint an intent. Wait longer than `UPLOAD_INTENT_TTL_SECONDS` (the staging value). `PUT`. | Refused after expiry. |
| 5. Size is exact | Upload a file of a known size (for example 1 234 567 bytes). Open the object in the Supabase Storage browser and read its size. | The size matches the file, and the size the app shows for it. |
| 6. Download URL needs its token | Download a file through the app (S3). Copy the redirect. Remove `?token=` and request it. | Refused. |
| 7. Range reads on large objects | Upload a file over 4.5 MB through the browser (direct path). Complete the upload. | Completion succeeds (the signature probe reads the first 16 bytes). |
| 8. Global limit matches the app | Upload one byte over `STORAGE_PROVIDER_MAX_FILE_BYTES`, then exactly the limit. | One byte over: refused with a clear message. The limit itself: accepted. Record both sizes. |
| 9. CORS allows the direct PUT | Upload through the browser with devtools open. | The PUT to the storage host succeeds. No fallback to `/api/uploads`. |

Only after 1–9 pass is direct upload considered live on staging. If any check fails, stop
and record it in section 6.

### 4B. Full payment workflow (the path students and staff actually use)

**S1 — Student registration.** Open `/register`. Fields: name (2–80), email, phone
(8–15 digits, `+`, `-`, spaces), regNo (3–32), branch (2–60), section (1–8), year (1–6),
password (8–128 with lower, upper and digit), confirm password.
- Expect: account created. If registration does not sign you in, sign in at `/login`.
- Negative: reuse the email → "An account with this email already exists." Weak password → rejected.
- Note: that message reveals whether an email, phone or regNo is taken (section 6, B7).

**S2 — Login and access control.** Sign in at `/login` as the student. Wrong password →
generic error. Correct → `/dashboard`. Open `/admin` as the student → refused. Sign in at
`/admin/login` as the Super Admin → `/admin`.

**S3 — Document upload.** Open `/orders/new`.
- Valid one-page PDF → upload completes; page count appears.
- A file over the limit → refused with a clear message. Record the size.
- A `.txt` renamed to `.pdf` → refused (content check).
- In devtools, the file bytes go to the storage host, not `/api/uploads` (direct path).
- Download your own file from the order page → works. Another student's file ID → 404.

**S4 — Order and payment submission.** Complete the wizard and create an order. Step 5
asks for a payment reference. Enter `TEST-<date>-01`.
- Expect: the order shows payment under review. Record the exact wording you see.
- Negative: the same reference on a second order → refused (409, reference already used).
- Negative: `<script>` in the reference → refused.
- Leave step 5 once and come back through the order page: the payment form is there
  (section 6, B1 is fixed in code; record the result).

**S5 — Admin verification and rejection.** Open `/admin/payments`.
- Order A (from S4): verify, with a note. Expect `PAYMENT_CONFIRMED` in `/admin/orders`.
  The student sees the confirmed payment status.
- Order B (create it now, with `TEST-<date>-02`): reject with a note of at least 3 characters.
  Expect: the student's order page shows the rejection reason in a banner.
- Student: correct the reference on order B to `TEST-<date>-03` and submit. Expect: the
  order returns to review. Admin verifies it. (This is the resubmission path, fixed in code.
  Record the result.)

**S6 — Cancellation.** As the student, place an order at `PAYMENT_PENDING` and cancel it
with a reason. Expect `CANCELLED`.
- Admin tries to verify it → refused (cancelled orders cannot be verified).
- Student submits a reference on it (browser console `fetch` to
  `/api/payment/submit/<id>`) → refused.
- The cancelled order keeps its payment reference (section 5, item 3). This is by design.

**S7 — Collection (normal path).** Admin moves a paid order `PRINTING` →
`QUALITY_CHECK` → `READY_FOR_COLLECTION` in `/admin/orders`. The student opens the order and
reveals the collection code (owner only; requires `READY_FOR_COLLECTION`). The student
shows the code to the desk.
- Desk: open **Admin → Collection**. Paste the code. Check it. Expect the order number and
  student name. Confirm collected. Expect `COMPLETED` in `/admin/orders`.
- Expect: the status control does **not** offer `COMPLETED` from `READY_FOR_COLLECTION`
  (B3 is fixed in code). Try the API directly if you want proof: a status `PATCH` to
  `COMPLETED` for a ready order → `409`.
- Re-check the same code on Admin → Collection → Check code → refused (already used).

**S8 — Lost-code override (Super Admin only).** Use a second test order at
`READY_FOR_COLLECTION`. Do not reveal its code.
- As an ADMIN (not Super Admin), the override section is not shown, and the API
  (`POST /api/admin/collection/override`) returns 403.
- As the Super Admin: enter the order number, type it again, write a reason of at least
  20 characters, tick "identity checked", submit. Expect the order to be `COMPLETED`.
- Check Audit Logs: `COLLECTION_OVERRIDE` with your reason.
- Check the student's order (as the student): the timeline shows the generic message and
  not the reason. The student's collection code now reads as used.
- Negative: type a different order number the second time → refused, nothing changes.

**S9 — Role gating (curl).** Unauthenticated `GET /api/admin/orders` → 401/403. The same with
a student cookie → 403. `POST` with `-H "Origin: https://evil.example"` → 403
`CROSS_SITE_REFUSED`.

**S10 — Audit trail.** `/admin/audit-logs` (Super Admin) should show `LOGIN`, order, payment,
collection and override events from S2–S8. A failed login is recorded.

**S11 — Headers.** `curl -sI https://<staging-host>/` should show the security headers
(HSTS on https, CSP, no-sniff, frame and referrer policies).

### 4C. Scheduler and cleanup checks

**C1 — Scheduler refuses the wrong target (safe, no data changes).** From a shell with the
staging `CRON_SECRET` loaded (not typed):

```
printf 'Authorization: Bearer %s\nX-Deploy-Target: production\n' "$CRON_SECRET" \
  | curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H @- \
    "https://<staging-host>/api/admin/uploads/sweep?limit=1"
```

Expect `403`. This proves a production-targeted scheduler cannot run against staging.

**C2 — Scheduled run succeeds.** GitHub → Actions → "Upload sweep (scheduled cleanup)" →
Run workflow. Expect a green run with `upload-sweep: HTTP 200`, and an audit entry
`UPLOAD_INTENTS_SWEEP` with `trigger: schedule` and `deployTarget: staging`. The app records
every call made with the scheduler credential as `schedule`, whether the workflow was started by
the timer or by hand.

**C3 — Abandoned upload is removed (needs 24 hours).** Upload a test file, do not order it,
and wait at least 24 hours. Run the sweep (C2). Expect: the file row is gone, and the object
is no longer listed in the Storage browser. Record the times.

**C4 — Student delete (safe, now).** Upload a test file and delete it from the wizard.
Expect: the file disappears, and the object is removed (same storage check as C3). Audit
entry `UPLOAD_REMOVED` with `by: student`.

**C5 — Retention (needs 24 hours or more).** In Settings, set `retentionDays` to `1`
(staging only). Complete a test order. After at least one day, run the sweep. Expect the
order's document download to return `410` with the retention message, and the object to be
gone. Set `retentionDays` back to `30`.

---

## 5. Policy issues to decide before any real launch

1. **Payment-confirmation reason visibility.** The reason an admin enters on the status
   control is stored as an order event (`STATUS_CHANGE`) and returned to the owning
   student by `GET /api/orders/[id]`. The student page does not render events today, so
   the reason is visible through the API, not the screen. Decide: keep it internal (filter
   admin-only event messages for students), or keep it visible as a deliberate
   student-facing note.
2. **Refunds.** No refund workflow exists in the code. The server's cancel list
   (`CANCELLABLE_STATUSES`) also allows `PAYMENT_CONFIRMED`, `DOCUMENTS_RECEIVED` and
   `PROCESSING`, but the student's cancel button appears only for `ORDER_PLACED`,
   `PAYMENT_PENDING` and `PAYMENT_UNDER_REVIEW`. An order cancelled after payment keeps
   `paymentStatus = CONFIRMED` with no refund record. The student page says "the desk will handle the
   refund manually"; the terms page limits liability to reprinting or refunding the order
   amount. Decide the desk procedure and whether the app should record refunds.
3. **Cancelled-order payment references.** Cancelling does not clear `paymentRef`. The
   reference stays bound to the cancelled order and blocks reuse on other orders. This is
   the conservative choice (it stops double use). Decide whether unpaid cancellations should
   release the reference; the release rule is a policy choice.
4. **Abandoned uploads, and the retention promise.** *Addressed in code (readiness step B),
   not yet verified on staging.* Students can delete an unordered upload
   (`DELETE /api/uploads/:id`). Unordered uploads are purged 24 hours after upload. Order
   documents are purged `retentionDays` after the order completes, is cancelled or fails.
   Purges claim the row before deleting the object, and a failed object delete keeps the row.
   `POST /api/admin/uploads/sweep` runs all of this and needs a scheduler that sends
   `Authorization: Bearer $CRON_SECRET`. Nothing in the app schedules it. Until a scheduler
   is set up and a run is seen, the privacy promise is still not being kept on staging.

---

## 6. Blockers and known gaps (status as of readiness round 2)

"In code" means implemented and covered by tests in this sandbox. It does not mean verified on
staging or in a browser. The staging run in section 4 is the verification.

| # | Gap | Status |
|---|---|---|
| B1 | Students could not correct and resubmit a rejected payment reference; the rejection reason was hidden. | **Fixed in code** (`18e753b`). Browser check: S4 and S5 in section 4. |
| B2 | No admin screen for collection codes. | **Fixed in code** (`84f4870`): Admin → Collection. Browser check: S7. |
| B3 | The status control could complete a ready order without its code. | **Fixed in code** (`84f4870`): refused with 409. Check: S7. |
| B4 | Staging has no Super Admin until the seed runs. | Solved by the seed step (section 2, step 8). |
| B5 | Dependency audit fails (`braces`, GHSA-vfj7-8cjw-p6xm, no patched version). | **Open, kept visible.** Owner decision. Section 7. |
| B6 | Supabase bucket privacy, signed URLs, direct upload end to end, and the Free-plan byte limit. | **Not verified.** Needs the staging run in section 4A. |
| B7 | Login reveals disabled accounts and timing; registration duplicate check reveals email, phone and regNo; CSP allows `unsafe-inline` scripts; an oversize direct object can briefly exist before deletion; no rate limit on upload-intent issuance. | Open, low to medium. Accepted for staging; to review before production. |
| B8 | Retention and abandoned-upload cleanup need a scheduler. | **Code in place** (`7075fd1`, readiness round 2). Not configured anywhere. Setup: DEPLOYMENT.md, "Scheduled upload cleanup". Checks: C1–C5. |
| B9 | A collected order whose student cannot present the code had no completion path. | **Fixed in code** (readiness round 2): Super Admin override with reason, identity check, typed order number, and audit in the same transaction. Procedure: SECURITY.md §6.1. Check: S8. |
| B10 | Scheduled cleanup could delete a row whose object still existed (after a crash between claim and delete). | **Fixed in code** (readiness round 2). Covered by a unit test. Not seen on a real database. |
| B11 | Retention and cleanup were only partly tested against real time (24 h and 1 day). | Deferred. C3 and C5 need real elapsed time. |

---

## 7. Dependency audit (kept visible; not fixed)

`npm audit`: 7 high findings, all `braces`, GHSA-vfj7-8cjw-p6xm, no patched version
(as of this writing). The production tree (`npm ls braces --omit=dev`) contains no
`braces`. It is reached through `tailwindcss` (build) and `eslint-config-next` (lint).
Exploitability in this application is not verified. `npm audit fix --force` to
tailwindcss@4 still reaches `braces` and was rejected.

Decision for the user before launch:
- **A.** Block launch until upstream publishes a fix. No date is known.
- **B.** Owner-signed risk acceptance in `SECURITY.md` (named owner, expiry date), plus a
  CI policy change to audit production dependencies only (`--omit=dev`). This turns the job
  green without a fix, so it needs explicit approval. **Recommended**, and not done.
- **C.** Toolchain migration: not viable now.

---

## 8. Go / no-go

- **Go for staging** once the [USER] steps in section 2 are done and `npm run guard:target`
  passes. Staging is then the place to run sections 4A, 4B and 4C.
- **No-go for production** until all of these are true, each with its evidence recorded:
  1. Section 4A checks 1–9 pass on the staging bucket (sizes recorded).
  2. Section 4B S1–S11 pass on staging, including the resubmission (S5) and the lost-code
     override (S8).
  3. The scheduler is configured for staging and a run is seen (C1 refused, C2 succeeded).
     Retention is then checked over real time (C3, C5).
  4. The audit decision in section 7 is made (accept with a signed risk note and a policy
     change, or block). Without it the audit job stays red and the branch is not
     launch-ready.
  5. The open decisions in PR #9 are answered (see section 5 and the PR description).
  6. Production has its own `DEPLOY_TARGET=production` and, only if you choose to run
     retention there, its own scheduler environment. None of that is set by this change.
