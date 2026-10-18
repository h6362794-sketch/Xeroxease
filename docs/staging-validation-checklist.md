# Staging validation checklist (prepared, NOT executed)

Status: **nothing on this page has been run.** It is a plan for the owner to authorise step by step.
It is written for the confirmed staging project only (Supabase ref `vjwvvoczyuebtowbnuqf`, per the
owner). It is not for production. Each step lists its class, what it touches, and what authorises it.

Section 4 of `STAGING.md` holds the older smoke steps (S1–S11) and scheduler checks (C1–C5). This
page classifies them and adds this round's checks. Where a step matches one there, the ID is given.

## Classes

- **R: read-only.** Reads only. No row, object, setting, schedule or secret is changed. Still needs
  the owner's go-ahead before it touches a live service, because it reads real data.
- **W: non-destructive write.** Creates or changes test data on staging, and deletes nothing. Needs
  separate written authorisation for each step, and must use a test account only.
- **D: destructive.** Deletes or purges objects or rows, runs a sweep, runs a migration or seed, or
  changes a retention setting that deletes data. Needs separate written authorisation and a backup
  or a snapshot first.

Rules that apply to every class:
- Use only the staging project and the staging host. Stop if a host, project ref or database name
  is not the staging one (`scripts/guard-target.ts` refuses wrong targets for the scheduler).
- No secrets are pasted into tickets, logs or chat. Record only the names of variables, never values.
- Do not print response bodies that could hold personal data or signed URLs. Record status codes.

## 1. Preconditions (R)

| ID | Step | Touches | Authorised by |
| --- | --- | --- | --- |
| P1 | Confirm the deployed commit SHA on staging equals the PR head (`c54601c` or later). | Nothing (reads the deployment). | Owner |
| P2 | Confirm migrations recorded on staging: `20261018000000_payment_reference_unique` and `20261019000000_document_purge` are **not recorded** as of the last read. Record the current list with `SELECT migration_name FROM _prisma_migrations ORDER BY finished_at`. | Read of `_prisma_migrations`. | Owner |
| P3 | Confirm the environment variable names present on staging, without values. | Names only. | Owner |

## 2. Read-only checks (R)

| ID | Step | Expected result | Authorised by |
| --- | --- | --- | --- |
| R1 | Payment-reference collision query (normalised), SELECT only, counts only. This is the query in `prisma/migrations/20261018000000_payment_reference_unique/migration.sql`. | 0 groups. Last run on staging (round 5): 0 groups, 2 non-null references. Re-run before any decision. | Owner (approved as option (b)) |
| R2 | Raw duplicate check on `orders.payment_ref`. | 0 groups. | Owner |
| R3 | `curl -sI https://<staging-host>/` shows the security headers. (S11) | Headers present. Do not record the body. | Owner |
| R4 | Unauthenticated `GET /api/admin/orders` returns 401 or 403. (S9, first half) | 401 or 403. | Owner |
| R5 | Code-level check only, with **no HTTP call**: read `src/app/api/admin/uploads/sweep/route.ts` and confirm that work happens only after either the scheduler bearer secret with a matching deploy target, or a SUPER_ADMIN session (`requireRole`). Do not send any request to the sweep endpoint. | Guard present in code. | Owner |
| R6 | Scheduler target guard: run `guard:target` with a non-staging target name. (C1) | Refusal. No data touched. | Owner |
| R7 | CI run on the staging branch shows the race step with `Tests 9 passed`. Read the step log, not the summary. | Log shows 9 passed, 0 skipped. | Owner |
| R8 | Read the Vercel Production Branch setting in the Vercel dashboard (view only). | Record the branch name. Do not change it. | Owner |

## 3. Non-destructive writes (W): test accounts, test data only

Each of these needs a written go-ahead, a named test account, and a note of the test order numbers.

| ID | Step | Writes | Notes |
| --- | --- | --- | --- |
| W1 | Student registration and login with a new test user. (S1, S2) | One user row, one session. | Use an address you own. |
| W2 | Upload one small test PDF through the wizard, then complete it. (S3, UPLOADS §8.1) | One document row and one object. | Object count is one. |
| W3 | Place a test order and submit a payment reference. (S4) | One order, one payment reference. | Use a **fake, unique** reference such as `TEST-<date>-<n>`. Never a real bank reference. |
| W4 | Admin verifies or rejects the test payment. (S5) | Payment status and one audit row. | Verify notes must be at least 3 trimmed characters. |
| W5 | Admin tries a page-count correction on the test order. Expect **409 `ORDER_PRICED`** and no change. | Nothing (refusal). | Confirms the step 1 refusal on staging. |
| W6 | Student cancels a test order at `PAYMENT_PENDING`. (S6) | Order to `CANCELLED`, one event, one audit row. | Do not cancel a paid test order: refund handling is not decided (see section 6). |
| W7 | Admin sets a test order to `PAYMENT_CONFIRMED`. The note is required. (Owner decision, `94fd37e`) | Status, event, audit row. | Refusal without a note must be checked first. |
| W8 | Audit trail visible to Super Admin. (S10) | Nothing. | Read-only in practice. |

## 4. Destructive steps (D): separate authorisation, backup first

Do not run any of these until the owner has authorised the specific step, and a backup or
snapshot of the staging database and bucket exists. Each one must be run on staging only.

| ID | Step | Why it is destructive | Blocking decision |
| --- | --- | --- | --- |
| D1 | Apply migrations `20261018000000_payment_reference_unique` and `20261019000000_document_purge` to staging. | Adds a unique index. Fails if raw duplicates exist. Record only after R1 is zero. | Collision option (A recommended; approval needed). |
| D2 | `POST /api/admin/uploads/sweep` (manual). Deletes expired intents, unordered documents older than 24 hours, and order documents past `retentionDays`. | Deletes objects and rows. | Scheduler decision (deferred, owner). |
| D3 | Abandoned-upload removal (C3). Needs a real 24-hour wait, then D2. | Deletes the test upload. | As D2. |
| D4 | Retention test (C5): set `retentionDays` to 1, wait, sweep, then restore 30. | Deletes order documents. | As D2, plus retention review. |
| D5 | Scheduled sweep (C2) through the workflow with `SWEEP_ENABLED`. | Recurring deletes. | Scheduler decision (deferred). Leave `SWEEP_ENABLED` unset until approved. |
| D6 | Any `prisma migrate reset`, `db push --force-reset`, seed run (`npm run db:seed`), or direct `DELETE`/`UPDATE` of payment references. | Destroys or rewrites data. | Not authorised. Do not run. |
| D7 | Option C of the collision plan: rewrite stored `payment_ref` to normalised form. | Changes payment evidence. | Only after option B. Not authorised. |
| D8 | Live Upstash rate-limit test. | Writes counters to a live store. | Not authorised. Mocked tests only. |

## 5. Not part of this checklist

- Production of any kind: no migration, sweep, deploy, Vercel setting change, or merge.
- Supabase Pro upgrade, Vercel Pro upgrade or any paid resource. Budget is $0.
- Changing `braces` audit policy or accepting the `braces` advisory.

## 6. Owner decisions that gate the steps above

1. Collision option A, B or C (`docs/payment-reference-collision-plan.md`, section 3).
2. Scheduler execution (D2, D5): deferred until retention review and written authorisation.
3. `retentionDays` default and the retention period for payment references (none is defined; the
   privacy page says they are kept "for accounting").
4. Cancellation of paid orders (W6 excludes this): whether refunds are recorded in the app, and how.
5. Admin repricing of a placed order (step 1 refuses; no policy exists).
6. `braces` audit: blocks launch until an upstream fix or an owner-signed risk acceptance.

## 7. Results log (fill in only when a step is actually run)

| ID | Date | Operator | Result (status code, count or outcome) | Evidence reference |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |
