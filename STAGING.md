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
| `DEPLOY_TARGET`, `EXPECTED_SUPABASE_PROJECT_REF` | Staging pin. `DEPLOY_TARGET=staging` and the project ref (not secret). The config check, `guard:target` and the seed refuse any URL not belonging to that project. Preview scope only. |
| `SEED_STUDENT_EMAIL`, `SEED_STUDENT_PASSWORD` | Optional. The smoke test registers a fresh student. |

Must **not** be set in staging: `ALLOW_DEV_SEED`, `ALLOW_EPHEMERAL_LOCAL_STORAGE`, `NODE_ENV`
(set by the host). `ENABLE_*` and `AI_DOCS_*` flags have no effect in the app.
`NEXT_PUBLIC_SUPABASE_ANON_KEY` is not read by the app.

---

## 4. Smoke test (manual, step by step)

Use a fresh browser profile for each role. Use a test email that you control.
For curl steps, copy the `xe_session` cookie value from browser devtools. Never paste it
into chat, a commit, or a ticket.

**S1 — Student registration.** Open `/register`. Fields: name (2–80), email, phone
(8–15 digits, `+`, `-`, spaces), regNo (3–32), branch (2–60), section (1–8), year (1–6),
password (8–128 with lower, upper and digit), confirm password.
- Expect: account created. Note whether registration signs you in; if not, sign in at `/login`.
- Negative: reuse the email → "An account with this email already exists." Weak password → rejected.
- Note: this message reveals whether an email, phone or regNo is taken (known, low-medium; see section 6).

**S2 — Login and access control.** Sign in at `/login` as the student. Wrong password →
generic error. Correct → `/dashboard`. Open `/admin` as the student → must be refused.
Sign in at `/admin/login` as the Super Admin → `/admin`.

**S3 — Document upload.** Open `/orders/new`.
- Valid one-page PDF → upload completes; page count appears.
- A file over the limit → refused with a clear message. Record the size.
- A `.txt` renamed to `.pdf` → refused (content check).
- Confirm in devtools that the file bytes go to the storage host, not `/api/uploads`
  (direct path). Record the largest size that succeeded.
- Download your own file from the order page → works. Another student's file ID → 404.

**S4 — Order and payment submission.** Complete the wizard and create an order. Step 5
asks for a payment reference. Enter a test reference (for example `TEST-S4-0001`).
- Expect: a success confirmation and the order showing payment under review. (The exact
  success text was not checked in code review; record what you see.)
- Negative: the same reference on a second order → refused (409, reference already used).
- Negative: `<script>` in the reference → refused.
- **Known blocker:** if you leave at step 5, you cannot resume payment from the order page
  (see section 6, B1).

**S5 — Admin verification and rejection.** Open `/admin/payments`.
- Verify the S4 order (note optional) → order moves to `PAYMENT_CONFIRMED` (check
  `/admin/orders`). The student sees the confirmed payment status.
- Create a second order and reject its payment with a note of at least 3 characters.
  Expect: status rejected; student sees the rejection.
- Then try to resubmit a reference from the student side. **Expected to fail** today (B1);
  record the result.

**S6 — Cancellation.** As the student, place an order at `PAYMENT_PENDING` and cancel it
with a reason. Expect `CANCELLED`.
- Admin tries to verify that order → refused (cancelled orders cannot be verified).
- Student tries to submit a reference on the cancelled order (browser console `fetch` to
  `/api/payment/submit/<id>`) → refused.
- Note: the cancelled order keeps its payment reference (section 5, item 3).

**S7 — Collection.** Admin moves a paid order through `PRINTING` → `QUALITY_CHECK` →
`READY_FOR_COLLECTION` in `/admin/orders`. Student opens the order and clicks
"Reveal collection code" (this is owner-only and requires `READY_FOR_COLLECTION`).
Desk consumes the code through the API (there is **no admin screen** for this; B2):

```
curl -sS -X POST "https://<staging-host>/api/admin/collection" \
  -H "Content-Type: application/json" \
  -H "Origin: https://<staging-host>" \
  -H "Cookie: xe_session=<admin session value>" \
  -d '{"token":"<code from student>","consume":true}'
```

- Expect: order becomes `COMPLETED`.
- Re-run with the same token → refused (single use).
- Note: `READY_FOR_COLLECTION → COMPLETED` can also be set from the status control with no
  code (B3).

**S8 — Role gating (curl).** Unauthenticated `GET /api/admin/orders` → 401/403. The same with
a student cookie → 403. `POST` with `-H "Origin: https://evil.example"` → 403
`CROSS_SITE_REFUSED`.

**S9 — Audit trail.** `/admin/audit-logs` should show `LOGIN`, order, payment and
collection events from S2–S7. Check that a failed login is recorded.

**S10 — Headers.** `curl -sI https://<staging-host>/` should show the security headers
(HSTS on https, CSP, no-sniff, frame and referrer policies).

**S11 — Provider checks.** Run `UPLOADS.md` §8.1 checks 1–9 against the staging bucket.
Record the results and the sizes used.

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

## 6. Blockers and known gaps found during preparation

| # | Gap | Effect on staging smoke test | Status |
|---|---|---|---|
| B1 | Order page "Open payment QR" links to `/orders/new?pay=<id>`. The wizard never reads `pay`, and the reference form lives only in wizard step 5. | Students cannot submit or resubmit a payment reference after leaving step 5 or after a rejection. S5 resubmission fails. | **Not fixed.** Staging prep only. Proposed fix: show the reference form on the order page for `PAYMENT_PENDING`, `PAYMENT_REJECTED` and `PAYMENT_FAILED`, posting to the existing `/api/payment/submit/:id`. Needs approval. |
| B2 | No admin UI consumes collection codes. Only `POST /api/admin/collection`. | The desk must use the API (S7). | Addressed in code (readiness step C): Admin → Collection page (check, then confirm). Not yet tested in a browser. |
| B3 | The status control offers `READY_FOR_COLLECTION → COMPLETED` with no collection code. | Bypasses the code check. | Addressed in code (readiness step C): the status route refuses this transition (409) and the table no longer offers it. A collected order that the student cannot show a code for has no completion path; this is an open decision. |
| B4 | Staging has no Super Admin until the seed runs. | S2 cannot start. | Solved by the seed step (section 2, step 8). |
| B5 | Dependency audit fails (`braces`, GHSA-vfj7-8cjw-p6xm, no patched version). | CI stays red. | Reported, not suppressed. See section 7. |
| B6 | Supabase bucket privacy, signed URLs, direct upload end to end, Upstash, and the Free-plan byte limit. | Not verified in this sandbox. | Needs staging run (S3, S11). |
| B7 | Remaining hardening: login reveals disabled accounts and timing; registration duplicate check reveals email, phone and regNo; CSP allows `unsafe-inline` scripts; an oversize direct object can briefly exist before deletion; no rate limit on upload-intent creation; the Origin check refuses future `/api/` webhooks unless exempted. | Not part of the smoke test. | Open. Low to medium. |

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

## 8. Go / no-go for staging (today)

- **Go** for a staging deployment to exercise sections 2–4 and the provider checks, once
  the [USER] steps are done.
- **No-go** for production until: B1 is fixed; the audit decision in section 7 is made; the
  privacy retention promise (section 5, item 4) is implemented in code and its scheduled run is seen working on staging; the
  nine provider checks and S1–S11 are recorded as passing.
