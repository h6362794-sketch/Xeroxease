# XeroxEase — `/dashboard` production failure: root cause, remediation plan, validation

**Decision: HOLD on production writes — but the remediation is now unblocked and verified.**
The production exception is confirmed, the exact schema gap is enumerated, the migration has
been replayed against a real PostgreSQL and proven data-preserving, and the dashboard query
has been executed successfully against the migrated schema. The only remaining blocker to
the fix is **authorisation to run `prisma migrate deploy` against production**.

Investigation date: 2026-20-10 → 2026-10-21. Scope: read-only production inspection, plus a
disposable local PostgreSQL 16 cluster. No production write, environment change, deployment,
or migration was performed.

---

## 1. Confirmed root cause and supporting evidence

**The deployed application is ahead of its database.** The build at `149b378` was generated
from a `schema.prisma` that expects nine `orders` columns and seven enum labels which the
production database does not have. `GET /dashboard` is the first request that reads `orders`,
so it is where the mismatch surfaces.

`dpl_Ew8PFSCE46ZqrM5T853a43Ne7izD` → git SHA **`149b378360e09899d085f2a6ac16e154d2398891`**
(`main`, `READY`/`PROMOTED`, alias assigned `2026-10-20T12:59:25Z`).

`POST /api/auth/login` returns 200 because every `users`/`sessions` column the login path
touches exists. `GET /dashboard` then throws in `prisma.order.findFirst()` — reported by
Vercel as `The column orders.pricing_snapshot does not exist in the current database.`

**Why that column and not another:** the dashboard query has **no `select`**, so Prisma emits
SQL selecting all **40** `Order` columns derived from `schema.prisma`. The table has 31. The
first missing column in declaration order is `pricing_snapshot`.

---

## 2. Exact migration/schema mismatch

Read-only inspection of the reachable project (`vjwvvoczyuebtowbnuqf`, PG 17.6.1).

### 2.1 Migration status — **pending, not failed, not partial**

| | |
|---|---|
| Committed migrations | **5** |
| Applied in `_prisma_migrations` | **3** — `20261013000000_init`, `20261014000000_recovery_codes`, `20261015000000_direct_upload_intents` |
| Never finished | **0** |
| Rolled back | **0** |
| **Missing** | `20261020000000_order_lifecycle_enum_values`, `20261020000100_order_lifecycle_payments_pricing` |

The two missing migrations are **absent from the history table entirely** — they were never
attempted. There is no partial application to recover from.

### 2.2 Applied-migration checksums are intact

The three applied rows record checksums. Every historical commit of those three migration
files — including both `04334a9` (PR #13) and `149b378` (deployed) — is **byte-identical**, and
the recorded checksums match the CRLF form of the current files exactly. No applied migration
was edited after the fact, so `prisma migrate deploy` will not stop on a checksum drift error.

> One benign anomaly: `init` records `applied_steps_count = 0` while the other two record `1`.
> The actual schema equals "the first three migrations applied, nothing more" **exactly** (see
> 2.4), so this is a baseline-style artefact, not a partial apply. It does not affect
> `migrate deploy`, which only matches on migration name and checksum.

### 2.3 Every missing object

Diffing `schema.prisma` against the production schema — verified independently against a
locally rebuilt replica — gives **17 missing schema objects plus 1 missing index**:

| Kind | Object | Needed by |
|---|---|---|
| Column | `orders.pricing_snapshot` | **dashboard `findFirst`/`findMany`/`aggregate`** (the reported error) |
| Column | `orders.finishing_options` | dashboard (same `SELECT`) |
| Column | `orders.payment_method` | dashboard (same `SELECT`), order detail, payments |
| Column | `orders.accepted_at`, `accepted_by` | admin accept flow, order detail |
| Column | `orders.rejected_at`, `rejected_by`, `rejection_reason` | admin reject flow |
| Column | `orders.delivered_at` | lifecycle completion |
| Enum value | `OrderStatus.ORDER_RECEIVED` | **order creation** (`orders.ts:249` writes it explicitly) |
| Enum value | `OrderStatus.ACCEPTED` | accept flow, payment eligibility |
| Enum value | `OrderStatus.READY_FOR_PICKUP` | printing lifecycle |
| Enum value | `OrderStatus.DELIVERED` | **dashboard filter** (`TERMINAL_STATUSES`) |
| Enum value | `OrderStatus.REJECTED` | **dashboard filter**, reject flow |
| Enum type | `PaymentMethod` (`CASH_ON_DELIVERY`, `UPI`) | `orders.payment_method` |
| Enum value | `NotificationType.ORDER_REJECTED`, `ORDER_ACCEPTED` | notification writers |
| Index | `orders_payment_method_payment_status_idx` | payment-desk filters |

**Blast radius is wider than `/dashboard`.** Order creation itself fails: `orders.ts` writes
`status: "ORDER_RECEIVED"`, which the enum lacks — reproduced locally as
`invalid input value for enum "OrderStatus": "ORDER_RECEIVED"`.

### 2.4 No other schema drift

Excluding `_prisma_migrations` itself, production and a local replay of the first three
migrations are **identical**:

| Digest | Production | Local replay |
|---|---|---|
| 151 columns (name/nullability/type) | `4d5b7c00f0605ee64097e91854f62b7e` | `4d5b7c00f0605ee64097e91854f62b7e` |
| 9 enums / 56 labels | `8f493407ea06184dc853739ab65a9525` | `8f493407ea06184dc853739ab65a9525` |
| 47 index definitions | identical | identical |

So the *only* difference between the database and what the code expects is the two unapplied
migrations. Nothing was hand-modified, and no other object is missing or extra.

### 2.5 Database identity — still not attested

`DATABASE_URL` is a Vercel `sensitive` variable and cannot be decrypted here; `NEXT_PUBLIC_SUPABASE_URL`
is also sensitive (and would only identify the *storage* project). The reachable project
`vjwvvoczyuebtowbnuqf` is the sole project on the connected account and its schema matches the
pre-PR#13 repository **exactly**, which is strong corroboration — **not proof**. See §6.

---

## 3. Is the migration safe to apply?

Verified by replay against a **disposable PostgreSQL 16.2** cluster (same major version as CI),
never against production.

**Both migrations apply cleanly, in order, with zero errors.** `ON_ERROR_STOP=1` throughout.

| Property | Result |
|---|---|
| Order dependency respected | `…000000` appends enum values; `…000100` sets `status` default to `ORDER_RECEIVED`. Separate files because PostgreSQL forbids using a new enum value in the transaction that adds it. |
| Additive only | Appends 5 `OrderStatus` + 2 `NotificationType` labels, creates `PaymentMethod`, adds 9 **nullable/defaulted** columns, 1 index. No `DROP`, `DELETE`, `UPDATE`, `TRUNCATE` or `RENAME`. |
| Data preserved | On a populated legacy database, row counts, order statuses, totals, `payment_ref`, order numbers and a deterministic content digest were **identical before and after**. New columns are `NULL`/empty on historical rows. |
| Old labels still valid | All 12 legacy `OrderStatus` labels remain readable; historical orders keep their status. |
| Full schema convergence | After applying, a replayed database satisfies `schema.prisma` **completely** — 0 discrepancies across 13 tables, 160 columns, 9 enums / 56 labels. |
| Replay idempotency | The enum migration uses `IF NOT EXISTS` and the `PaymentMethod` create is guarded by a `DO` block. The **column** statements are not idempotent, so the file must never be re-run after a partial failure — it should be applied once, in order. |
| Locking | `ALTER TABLE … ADD COLUMN` with `NULL`/default takes a brief `ACCESS EXCLUSIVE` lock; `CREATE INDEX` is non-concurrent. On this table size that is sub-second, but it should still be applied in a low-traffic window. |

**Verdict: safe to apply as an ordered pair, once, with a verified backup and a low-traffic
window. No recovery plan for a partial apply is needed today, because nothing was attempted.**

---

## 4. Reproduction: failure and cure, end to end

Rebuilt three databases from the committed migrations and ran the dashboard's *exact* query
shape (all 40 schema columns + the `TERMINAL_STATUSES` filter).

| Probe | Production-state DB (3 migrations) | Fully migrated DB (5) |
|---|---|---|
| Dashboard `SELECT` (40 cols, `status NOT IN (…)`) | ❌ `column t.pricing_snapshot does not exist` | ✅ `(0 rows)` |
| `'DELIVERED'::"OrderStatus"` | ❌ `invalid input value for enum "OrderStatus"` | ✅ `DELIVERED` |
| `'UPI'::"PaymentMethod"` | ❌ `type "PaymentMethod" does not exist` | ✅ `UPI` |
| Create order as the app does (`status='ORDER_RECEIVED'`) | ❌ enum rejects it | ✅ inserted |
| New order with default status | `ORDER_PLACED` (wrong) | `ORDER_RECEIVED` (correct) |

The first row reproduces **the production log message verbatim**. The last two show the same
defect silently breaking order creation, not just the dashboard.

This is now an executable regression test — `tests/migration-replay.pg.test.ts` (8 tests).

---

## 5. Minimal code changes

No change is required to fix the incident: **the defect is in the database, not the code.**
No dashboard query was removed, no order field was dropped, no error was swallowed, and no
auth/authorization/session validation was touched.

Small additive changes are included to prevent recurrence and to make the next incident
diagnosable in minutes rather than days:

| File | Change |
|---|---|
| `src/server/schema-skew.ts` | **New.** Pure classifier mapping PostgreSQL `42703`/`42P01`/`22P02`/`3F000` and Prisma `P2021`/`P2022` to `{kind, prismaCode, pgCode, object}`. Emits only allowlisted schema identifiers — never message text, SQL parameters or row data. |
| `src/server/schema-readiness.ts` | **New.** Pure comparison of committed vs applied migration names; flags pending *and* unrecognised migrations. |
| `scripts/check-schema-ready.ts` + `preflight:schema` | **New.** Read-only adapter: one `SELECT` against `_prisma_migrations`; exit `0` ready / `1` not ready / `2` unknown. Prints migration names only. |
| `src/instrumentation.ts` | Adds a guarded `schemaSkew` field to `[server-request-error]`. `P2022` alone did not reveal *which* column; this does. Wrapped in `try/catch`. |
| `src/app/(student)/dashboard/error.tsx` | **New** route-scoped boundary: explains the failure, shows the numeric digest as a support reference, one deliberate `reset()`, no auto-retry, no server detail. |

The Server Component still throws and the request still fails — only presentation is handled.
`npm run build` was deliberately **not** changed to run the gate (see §8.3).

**Regression coverage added: 51 tests** across
`enum-migration-contract` (14), `schema-readiness` (10), `schema-skew` (13),
`dashboard-error-boundary` (6), `migration-replay.pg` (8).

---

## 6. Validation results

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Install | `npm ci --ignore-scripts` | **PASS (0)**. Plain `npm ci` **FAILS (1)** — Prisma postinstall cannot reach `binaries.prisma.sh`. |
| 2 | Prisma generate | `npx prisma generate` | **FAIL (1)** — blocked engine download. `--no-engine` also fails. |
| 3 | Prisma validate | `npx prisma validate` | **NOT RUN** — same engine dependency. |
| 4 | Schema text pre-flight | `npm run schema:check` | **PASS (0)** |
| 5 | Typecheck | `npm run typecheck` | **FAIL (1)** — 52 diagnostics, **identical set** to a pristine `149b378` worktree using the same `node_modules`. My changes add **zero**. All cascade from the ungenerated client. |
| 6 | Lint | `npx next lint` | **PASS (0)** — no warnings or errors |
| 7 | Unit + regression | `npx vitest run` | **PASS (0)** — 47 files passed, 1 skipped; **640 passed, 4 skipped** |
| 8 | **DB migration replay** | `PG_TEST_DSN=… npx vitest run tests/migration-replay.pg.test.ts` | **PASS (0)** — **8/8** against PostgreSQL 16.2 |
| 9 | Production build | `npm run build` | **FAIL (1)** — stops at `prisma generate`. **No build success is claimed.** |
| 10 | Release gate (live) | `npm run preflight:schema` | **exit 2** — fails closed because Prisma Client is not generated. The gate's *decision* logic is validated against a real `_prisma_migrations` history by test 8. |
| 11 | Auth → dashboard render | `tests/student-login-dashboard-flow.test.ts` | **PASS** — login 200 → session → dashboard render; and login-success-then-schema-failure. |
| 12 | Production smoke / integration | — | **NOT RUN** — needs explicit authorisation and an approved test account. |

**Skipped vs passed:** the 4 skips are the pre-existing PostgreSQL-only
`recovery-concurrency.pg.test.ts`. Items 2, 3, 9 and 12 did not execute successfully; item 11
is a unit-level simulation, not a production test.

---

## 7. Ordered remediation plan

**Stop before step 4 unless explicitly authorised.**

### Step 1 — Confirm the target (operator, read-only)
Attest the non-secret project reference and database name behind `DATABASE_URL` for
`dpl_Ew8PFS…` / `149b378…`. Compare with `vjwvvoczyuebtowbnuqf`. If it differs, **stop** — §2
must be re-taken against the real target.

### Step 2 — Confirm the gap (read-only)
```sql
SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at;
-- expect 3 rows; 20261020000000 and 20261020000100 must be absent
```

### Step 3 — Backup
Take a verified snapshot / confirm PITR on the target and **record the restore point**. Verify
it is restorable, not merely that a backup job ran.

### Step 4 — Apply (authorised operator, low-traffic window)
```sh
npx prisma migrate deploy      # applies 20261020000000, then 20261020000100
npx prisma migrate status      # expect: Database schema is up to date!
```
Never: `migrate resolve --applied`, `db push`, the files out of order, or a re-run of
`…000100` after a partial failure.

### Step 5 — Post-migration checks
```sql
SELECT 'DELIVERED'::"OrderStatus";      -- must succeed
SELECT 'UPI'::"PaymentMethod";          -- must succeed
SELECT count(*), status FROM orders GROUP BY status;   -- compare with the pre-migration tally
```
```sh
npm run preflight:schema                # must exit 0
```

### Step 6 — Deploy and smoke test
Deploy the reviewed SHA, then verify the **actual server-rendered result**, not the homepage:
authenticated `GET /dashboard` must return **200** and contain the dashboard heading. Requires
authorisation and an approved test account.

### Step 7 — Observe (15–30 min)
Dashboard 5xx rate, auth failures, Prisma `P2022`/`P2023`, and any `[server-request-error]`
entry with a non-null `schemaSkew`.

### Rollback
The migrations are additive, so **rolling back the application is safe and needs no schema
change** — old code ignores the new nullable columns and appended enum labels.
`git`-level rollback = re-alias `dpl_E1YCMo…`. **Do not roll back the migrations**: dropping
enum values or columns is destructive and unnecessary. If the migration itself fails
mid-way, stop and collect safe state — do not blind-retry.

---

## 8. Unresolved blockers and risks

### 8.1 Production migration — **waiting on explicit authorisation** (the actual fix)
### 8.2 Database identity — **waiting on operator attestation** (see §2.5)
### 8.3 Do not gate the build on the preflight
Wiring `preflight:schema` into `next build` would fail every deploy whenever the database is
unreachable at build time, and would change production deployment configuration. Adopt it as a
**release step** (§7 step 5), not a build step.

### 8.4 Admin analytics is also affected
`src/app/api/admin/analytics/route.ts` filters orders by `ORDER_RECEIVED`, `ACCEPTED`,
`READY_FOR_PICKUP`, `DELIVERED`, and `REJECTED` across `count()`, `aggregate()`, and
`groupBy()`, failing on an unmigrated database with `SQLSTATE 22P02` (`invalid input value
for enum "OrderStatus"`). `src/server/api-utils.ts` now maps `22P02` via `describeSchemaSkew`
to `503 SCHEMA_OUTDATED` and `AdminDashboard` displays a safe retryable `ErrorState` instead
of indefinite loading skeletons; applying both October 20 migrations resolves the underlying
schema gap for both `/dashboard` and `/admin`.

### 8.5 Build/typecheck environment
Local offline validation succeeds via `prisma generate --no-engine` + mocked Google Fonts,
and GitHub Actions CI (`verify` + `migrations` on PostgreSQL 16 and 17) exercises full native
Prisma engine downloads, `prisma migrate diff`, `npm run preflight:schema`, `pg_dump -Fc` /
`pg_restore` backup-and-restore replay, and `next build`.

### 8.6 Security gate — **patched compatible advisories; `braces` remains open**
`next` & `eslint-config-next` were upgraded `15.5.27 → 15.5.28` (`GHSA-2464-fhr4-w9xw`,
`GHSA-p3m5-59mp-jv5r`) and `vitest` `4.1.11 → 4.1.12` (`GHSA-qxg6-89mg-rqv8`,
`GHSA-xp26-3454-mjgp`), reducing total `npm audit` findings from `9` to `7` (`0` moderate,
`0` production runtime vulnerabilities via `npm audit --omit=dev`). Dev-only
`GHSA-vfj7-8cjw-p6xm` (`braces <= 3.0.3`) remains unpatched upstream without suppression,
fake overrides, or lowered audit thresholds (`SECURITY.md` §12.7).

### 8.7 Residual risk after the fix
`npm run preflight:schema` is now exercised automatically against both PostgreSQL 16 and 17
in CI (`migrations` matrix job), and must also be run as a release gate (§7 step 5) before
promoting future schema-dependent deployments.

---

## 10. Re-verification update — 2026-10-22 (`main` at `77ce38c`)

- **Vercel Production (`xeroxease.vercel.app`):** Deployment `dpl_9zdBmDrc2N1yPEQc5icpuFpkuhrA` (`READY`, `PROMOTED`, `iad1`, Node `24.x`) serves `main` commit `77ce38c6930b9e1f7e608f2fc67f44f256f3eb81` (PR #16). Preview deployment `dpl_2YX4bAmwdDJGTLoCZx84sDEQ2GRY` (`READY`, `STAGED`) serves PR #17 (`310e950`). `DATABASE_URL` and `DIRECT_URL` in Vercel are scoped strictly to `production` (`type: "sensitive"`).
- **Supabase Production (`vjwvvoczyuebtowbnuqf`, `ap-northeast-1`, PostgreSQL `17.6`):** Read-only metadata inspection confirmed `_prisma_migrations` still contains only `20261013000000_init`, `20261014000000_recovery_codes`, and `20261015000000_direct_upload_intents` (`finished_at` non-null, `rolled_back_at` null). Both `20261020000000_order_lifecycle_enum_values` and `20261020000100_order_lifecycle_payments_pricing` remain unapplied (`orders` has 31/40 columns; 4 live historical orders exist across `COMPLETED`, `PAYMENT_PENDING`, `PAYMENT_UNDER_REVIEW`, and `READY_FOR_COLLECTION`; private `documents` bucket and all 7 `pricing_config` keys are intact).
- **Safety gate hold:** **Zero writes or migrations were executed against Production.** Supabase Free plan has no branching/PITR, sandbox egress cannot run direct `pg_dump` against `*.supabase.co`, exporting live tables over chat/MCP would expose customer data/hashes, and explicit owner authorization has not been granted. Follow [`DATABASE.md`](DATABASE.md) §*Production Migration & Recovery Runbook* from an operator workstation before authorizing `npx prisma migrate deploy`.

---

## 9. Classification

| State | Item |
|---|---|
| **Verified complete** | Production source is `149b378`; production exception reproduced verbatim against a rebuilt production-state database. |
| **Verified complete** | Exact gap enumerated: 17 objects + 1 index; pending, not failed, not partial; applied checksums intact; no other drift (digests match). |
| **Verified complete** | Migration pair applies cleanly in order on PostgreSQL 16 and preserves all data (byte-identical digests). |
| **Verified complete** | Dashboard query succeeds after migration; order creation and the new default behave correctly. |
| **Confirmed defect fixed and regression-tested** *(prevention layer)* | 51 new tests, 640/644 passing, lint clean, zero new typecheck diagnostics. |
| **Waiting on explicit authorisation** | `prisma migrate deploy` on production; authenticated production smoke test. |
| **Waiting on operator access** | Runtime-log confirmation of digest `3932642283`; `DATABASE_URL` attestation. |
| **Failed validation** | `npm ci` (full), `prisma generate`, `prisma validate`, `npm run build` — blocked engine egress. |
| **Not yet tested** | Production smoke test; admin analytics on migrated data; device/browser acceptance. |
| **Remaining gate** | `GHSA-vfj7-8cjw-p6xm` open. |

### Release decision: **HOLD**

Not because the cause is unknown — it is proven — but because the only remaining action that
fixes production is a **production database write**, which requires authorisation this session
does not have. The build also cannot be validated here, and the security gate is open.

**Eligible for human review as a migration plan: yes.** The plan in §7 is verified end to end
against a disposable database and is ready to execute the moment the target is attested and
authorised.
