# Student render failure investigation — 2026-10-20

> **Current status:** See `RELEASE-READINESS.md` for the refreshed deployment identity,
> latest verification results, additional reproduced auth/privacy fixes, PR draft
> and approval-gated rollout/recovery plan. Counts and disconnected-Vercel notes
> below are historical observations, not current release approval.

## Status / safety

**Not production-resolved; definition of done is not fully met.** No deployment, database write, migration, environment change, provisioning, merge, commit or push was performed. Production remediation requires approval. All work remains on `arena/424bd43f-xeroxease`.

## Baseline and deployment evidence

Before edits, fetched `origin/main`: both it and HEAD were `04334a9c5d797b402cd47735d1bdb34eb5f188af`, the merge of PR #13. The fixed Arena branch already starts at current main; no branch switch was needed.

GitHub's commit status reports successful Vercel deployment:
`https://vercel.com/pashu-shield/xeroxease/E1YCMoxNS69HwvqFut9UwmseTA6M`.
GitHub Deployments API returned no deployment records. The successful status does **not** prove which commit the production alias currently serves. Direct HTTPS to `https://xeroxease.vercel.app` failed with curl exit 35. No Vercel connector/runtime log access or deployed environment was available. Therefore the exact production alias SHA, browser digest, incident timestamp, request ID and matching Vercel exception remain **unverified**, not inferred from the generic browser message.

## Confirmed database incompatibility

Read-only Supabase connector queries against the sole connected project, `vjwvvoczyuebtowbnuqf`, found:

- `_prisma_migrations`: only `20261013000000_init`, `20261014000000_recovery_codes`, `20261015000000_direct_upload_intents`, all finished and not rolled back.
- The two existing PR #13 lifecycle migrations are not recorded.
- `orders` lacks `pricing_snapshot`, `payment_method`, `accepted_at`, `accepted_by`, `rejected_at`, `rejected_by`, `rejection_reason`, `delivered_at`, `finishing_options`.
- `OrderStatus` lacks `ORDER_RECEIVED`, `ACCEPTED`, `READY_FOR_PICKUP`, `DELIVERED`, `REJECTED`; `NotificationType` lacks `ORDER_ACCEPTED` and `ORDER_REJECTED`; `PaymentMethod` does not exist.
- Zero-row reproduction (no student rows read):
  ```sql
  SELECT pricing_snapshot, payment_method FROM public.orders LIMIT 0;
  ```
  Actual database exception: **`ERROR: 42703: column "pricing_snapshot" does not exist`**.

Metadata request references: `8fba554e-2c25-41b1-80e3-104aa33ec273` (migration history), `750525ec-f4b1-41aa-9121-163594732d37` (columns/enums). These identify diagnostic connector calls, **not** the student's HTTP request.

This confirms schema drift in that project and a concrete failure mechanism, not just a speculative missing-column diagnosis. However no checked-in configuration identifies the production database project; an operator must confirm this project is the production deployment's database. Without that mapping and the Vercel incident logs, this cannot honestly be labeled a digest-correlated production root cause.

## Login / render path

1. `/login` posts to `POST /api/auth/login`.
2. Handler rate-limits, validates input, looks up the user, enforces STUDENT/active/lockout, verifies password, resets lockout, creates a session and records login success.
3. `createSession` stores a SHA-256 token digest; sets an HTTP-only, same-site lax, production-secure, root-path expiring cookie.
4. Login JSON success is followed by client `router.push('/dashboard')` and `router.refresh()`.
5. Student layout calls `getSessionUser`, redirects anonymous users to `/login` and non-students to `/admin`. Dashboard independently calls `requirePageUser`.
6. `/dashboard` starts order `findFirst`, order `findMany`, aggregate and recovery-code lookup concurrently. Both order reads use Prisma's default all-scalar selection, which includes the missing columns. They fail on the observed schema even if no order rows exist. Authentication queries do not reference those order columns.
7. Notifications load separately through the student chrome/API; pricing loads on its own surfaces, not in the dashboard's four-query batch. Payment state is part of order data.

The new mocked-persistence flow test executes the **real** login route, bcrypt verifier, session/cookie helpers and dashboard component. It proves a 200 login can precede a P2022 dashboard rejection, empty dashboard markup renders after valid login on the compatible test double, expired sessions redirect, and an admin cannot create a student session. It does not prove an actual browser/PostgreSQL production flow, and P2022 there is an injected Prisma-shaped failure, not a captured production exception.

No evidence obtained here confirms P2024, session corruption, serialization errors, stale generated clients or environment differences as the incident cause. Existing Prisma singleton/config diagnostics and concurrency helper were inspected; pool limits were not changed. Layout/page independently repeat session lookup and dashboard starts four queries, but observed production contention was not established, so no speculative concurrency rewrite was made.

## Repair plan — approval required, not executed

Reuse the existing intended migrations; do not invent compatibility columns or hide exceptions:

1. Operator confirms production alias SHA, database project, runtime/build environment and migration history (including checksums/failed entries). Capture the browser digest, UTC time, `/dashboard` request and Vercel request ID; find its corresponding server exception.
2. Take/verify a database backup and recovery point. Use an approved existing staging database with a production-like pre-PR #13 schema; no staging service was provisioned here.
3. Replay the existing migration chain in staging, in order:
   - `20261020000000_order_lifecycle_enum_values`: additive enum labels.
   - `20261020000100_order_lifecycle_payments_pricing`: default, PaymentMethod, nine columns and index.
4. Keep the enum addition committed before the default uses `ORDER_RECEIVED`. Do not combine into a single transaction. Review the second migration's table/index lock implications and maintenance window. No rows are rewritten, but index creation and ALTER TABLE still acquire locks.
5. Run `prisma migrate status` and a database-backed `prisma migrate diff` with an isolated shadow database, generate the client, typecheck/build, and exercise the checklist below. Text schema check is not a substitute.
6. Only after **explicit production authorization**, run the reviewed migration deployment against the verified production database, then check columns/enums/history and the affected routes. Do not use reset, db push, force-reset, or resolve-as-applied to bypass migration execution.
7. New lifecycle rows are not fully understood by older code. Prefer forward fix; do not promise an old-code rollback is semantically safe once canonical statuses have been written. Additive schema alone does not settle application rollback safety.

## Changes

| File | Reason |
|---|---|
| `src/instrumentation.ts` | Next 15 server request-error hook logs timestamp, validated numeric Next digest, route template/type, router, method, optional shape-checked Vercel ID, Prisma code and filtered file-location stack frames. No cookies, general headers, URL/query strings, messages, SQL values or student records. Next's native server exception logging remains in place. |
| `src/app/error.tsx` | Corrects misleading claim that a browser effect writes server logs; structured browser digest/path/time, generic user-facing message preserved. |
| `src/app/(student)/dashboard/page.tsx` | Uses existing authoritative terminal-status list; DELIVERED/REJECTED no longer appear as active orders. No missing-column suppression or incomplete-schema workaround. |
| `src/components/intro-gate.tsx` | Single video remains mounted across orientation changes; pauses on dismissal, modal focus loop/restore, inert background, live reduced-motion preference handling, sessionStorage plus page-lifetime fallback and prior body-overflow restoration. |
| `src/app/globals.css` | Dynamic viewport/safe areas, available-stage size container, contained 16:9 frame or portrait-mobile 9:16 frame. |
| `tests/student-login-dashboard-flow.test.ts` | Four real-handler/helper/component flow tests with mocked persistence; assert rendered empty-state markup and cookie attributes. |
| `tests/student-dashboard.test.ts` | Four component regressions: empty data, existing order, terminal filter, propagation of schema rejection. |
| `tests/server-error-logging.test.ts` | Three server log correlation/redaction regressions. |
| `tests/intro-video.test.ts` | Three additional source/asset guards (10 total). |
| `tests/lifecycle-migration-contract.test.ts` | Two static migration-contract checks; not SQL execution. |
| `scripts/verify-intro-browser.mjs` | Reusable optional local browser component harness; 17 scenarios, external browser tooling, no application dependency/lockfile change. |
| `vitest.config.ts` | Automatic JSX transform for executing actual TSX components using the installed Vite OXC transformer. |
| `SECURITY.md` | Clarifies prior “accepted risk” prose is not owner-signed approval; GHSA-vfj7-8cjw-p6xm remains a launch gate. |
| This report | Evidence, scope, limitations and safe action plan. |

## Intro before / after

Before: full-viewport flex overlay, single contained video filling the flexible row, poster/failure panel, muted autoplay/playsInline, Escape/Skip and sessionStorage dismissal. It had no explicit orientation-dependent presentation ratio or modal focus isolation.

After: desktop/tablet and landscape use 16:9; viewports under 768 CSS pixels in portrait use 9:16. The frame fits **both** available stage width and height via `cqw/cqh`; stage occupies remaining space above branding inside `100dvh` and safe-area padding. Rotation/resizing changes CSS only, not src/key or playback state. Source remains `public/brand/xeroxease-intro.mp4`; MP4 tkhd metadata confirms **1280×720**. No portrait asset exists. `object-fit: contain` preserves the entire landscape frame in portrait with intentional black letterboxing (the artwork is not falsely described as native portrait). Poster remains `xeroxease-logo.jpeg`. No asset was generated or altered. Native portrait reframing would require an approved portrait asset.

## Risk-based audit findings

| Severity | Finding / affected surface | Evidence / reproducibility | Action |
|---|---|---|---|
| Critical availability blocker | PR #13 schema incompatible with connected DB; dashboard and other full-order reads, lifecycle/payment writes affected | Metadata + real 42703 zero-row query above | Existing migrations, project mapping/log correlation and approval required; not resolved in production |
| Medium | Delivered/rejected order can be shown as active on `/dashboard` | Old notIn omitted canonical terminals; regression verifies corrected query | Fixed using existing terminal list |
| Medium accessibility | Intro modal did not isolate background focus or set/loop focus | Existing implementation lacked focus/inert handling | Fixed; browser/device acceptance still required |
| Medium responsive requirement | Intro lacked required portrait/landscape presentation sizing | Existing flexible video had no orientation ratio | Fixed in CSS; real device visual acceptance still required |
| Medium operability | `[app-error]` was a browser log incorrectly documented as server logging | `use client` error boundary effect | Added server hook, retained native exception logging; not deployed |
| High / launch blocker | GHSA-vfj7-8cjw-p6xm and transitive dependency findings | Actual `npm audit --audit-level=high`: seven high package findings | No suppressions/upgrades; owner-signed acceptance or official resolution required |

Signup/login/logout/expiry/role checks, recovery, ownership/private file routes, admin lookup/detail/pricing/payment verification, lifecycle rules, file validation, upload failure/retry behavior, CSP and required Supabase connections were covered by existing tests rerun in full. Examples: auth login 21, registration 21, sessions 20; payment lifecycle 31; admin document access 17; admin pricing 11; admin payments 12; direct-upload routes 29. This is **not** an exhaustive live UI/API audit or a claim all routes work against the unmigrated database. Live PDF/storage, payment, status timeline, pricing and notification round-trips remain unverified. No new confirmed auth/ownership/CSP defect was identified by these tests; security controls were not weakened.

## Follow-up verification (current patch; supersedes initial test counts)

### Deployment / incident access

- Vercel connector lookup returned **disconnected**. Connect Vercel in Arena for read-only deployment metadata and protected runtime logs; no credentials should be sent in chat.
- Re-read GitHub status: commit `04334a9` has Vercel success pointing to deployment `E1YCMoxNS69HwvqFut9UwmseTA6M`, status updated **2026-10-20 08:32:14 UTC**. This is deployment-status time, not the student's incident timestamp. GitHub Deployments API still returns zero records.
- Retried production HTTPS: curl exit 35. No alias-to-deployment mapping or production DB identity was established. No browser digest, incident timestamp or matching Vercel exception was obtained. The earlier Supabase schema evidence remains separate.
- No approved staging/shadow database or engine-enabled execution environment was identified. No connected database was used as a substitute staging target. No push/PR/workflow execution was initiated: a repository-connected push/PR could trigger an unapproved Vercel deployment.

### Review findings and focused follow-up changes

Reviewed all tracked diff and new files, every new test assertion, both migrations against the initial migration and Prisma schema, Next's error-hook type, and native digest generation in the installed Next package. Native RSC digests are decimal string hashes. The logger now accepts that digest shape only, bounds stack output to 40 conventional JS/TS file locations, and strips function display names, message-continuation text, eval/URL frames and query strings. The previous starts-with-`at` filter could log message continuation lines, so it was tightened and tested. Native Next protected exception logging is unchanged; the sanitized hook does not claim to sanitize every pre-existing application/provider log. Optional `x-vercel-id` is shape-checked metadata, **not** independently authenticated identity; absent/malformed IDs are omitted. Logged timestamps describe error handling, not proof of an earlier incident time.

The expanded browser harness confirmed that initial dismissal released inert/focus isolation before AnimatePresence removed the modal. `introPresent` now keeps background inertness, Tab handling and scroll locking through exit completion. Playback pauses immediately; reduced-motion exits have zero animation duration; exit scaling was removed to avoid stretching the viewport presentation. StrictMode, storage denial/remount and scroll restoration are exercised in the browser harness. Physical-device browser chrome/notches and non-Chromium engines remain untested.

### Migration review — static only, not approved staging validation

- Prerequisites: the initial migration must have created `orders`, `OrderStatus`, `NotificationType`; preceding recovery/upload migrations must match recorded history. Correct target namespace/search path, migration checksums, privileges, and absence of partial/failed entries must be verified by the operator.
- First PR #13 migration appends five OrderStatus values and two NotificationType values exactly as listed above. No legacy labels are deleted or renamed; new enum values must commit before the next migration uses `ORDER_RECEIVED`.
- Second migration changes the **future insert default**, creates PaymentMethod with `CASH_ON_DELIVERY`/`UPI`, and adds:

  | Column(s) | Type / existing-row behavior |
  |---|---|
  | `payment_method` | Nullable PaymentMethod enum |
  | `accepted_at`, `rejected_at`, `delivered_at` | Nullable TIMESTAMP(3) |
  | `accepted_by`, `rejected_by`, `rejection_reason` | Nullable TEXT |
  | `pricing_snapshot` | Nullable JSONB; does not backfill historical prices |
  | `finishing_options` | TEXT[] NOT NULL, default empty array |

  The composite payment-method/payment-status index matches Prisma. All nine column names/types/defaults match the checked-out PR #13 code/schema. This is **not** confirmation of compatibility with an unknown alias SHA. Historical statuses/totals/events are not updated; existing new nullable fields remain null. New enum labels append to PostgreSQL order rather than being inserted among legacy labels; application lifecycle ordering must remain the shared explicit status model, not enum sort order.
- The `PaymentMethod` DO guard checks name existence, not existing labels/namespace equivalence. Staging/production preflight must reject a conflicting pre-existing type rather than assuming this guard validates it. No speculative migration edit was made.
- ADD COLUMN/default changes acquire table locks; the index is not CONCURRENTLY. Plan lock timeouts/window and data size in staging. Verify physical behavior on the approved PostgreSQL version rather than promising zero-lock/zero-rewrite execution.
- A failed migration requires inspection for partial state and logs before any retry/resolve. No automated destructive rollback is supplied. Enum removal and dropping columns are not safe automatic reversals; once new lifecycle/payment writes exist, old-code rollback may misinterpret them. Backup/restore or a reviewed forward fix requires a separately approved plan.
- Existing main CI clean-DB migration check completed successfully at **08:32:02 UTC**. This is historical evidence for the unchanged SQL, **not** a replay of this patch on approved staging or proof of production state. Both migration files remain unmodified. Two new static contract tests cover ordering, enum additions, column names, defaults/index and absence of destructive data statements.

### Dependency audit investigation

`npm audit --audit-level=high` still exits nonzero. The seven high package nodes are `braces`, `chokidar`, `micromatch`, `fast-glob`, `tailwindcss`, `@next/eslint-plugin-next`, and `eslint-config-next`; they represent **one root advisory**, not seven independent CVEs.

`npm ls braces micromatch fast-glob chokidar --all` confirms:
- Tailwind 3.4.19 → chokidar 3.6.0 → braces 3.0.3.
- Tailwind / Next lint plugin → fast-glob → micromatch 4.0.8 → braces 3.0.3.
- Prisma's separate chokidar 4.0.3 does not use this vulnerable braces chain.

Read-only official GitHub advisory metadata: GHSA-vfj7-8cjw-p6xm is high, not withdrawn, vulnerable range `<=3.0.3`, `first_patched_version: null`, updated 2026-10-02. `npm view braces version` returns 3.0.3. npm proposes a major Tailwind 4 change and a Next lint configuration downgrade; neither was blindly applied. `npm audit --omit=dev --json` reports **zero runtime findings**, but build/lint exposure and the owner-signed acceptance gate still matter. The advisory is **not resolved**; no unofficial fork, override, suppression or approval waiver was introduced.

### Commands / actual latest outcomes

| Command | Outcome |
|---|---|
| `npx prisma generate` | Blocked: TLS/network access to binaries.prisma.sh fails; no generated client |
| `npm run typecheck` | **Failed**, 52 diagnostics with Prisma exports unavailable; not passed |
| `npm run lint` | Passed, zero warnings/errors; Next lint deprecation notice remains |
| `npm run build` | Blocked at Prisma generation; Next production build did not run |
| `npm test` | **587 passed, 0 failed, 4 skipped (591)**; 42 files passed, 1 skipped |
| `npx vitest run tests/recovery-concurrency.pg.test.ts` | **0 passed, 4 skipped**; no approved PostgreSQL target; not an integration pass |
| `npm run schema:check` | Passed, 13-model **text-only** check; not DB replay/diff |
| `npm audit --audit-level=high` | Failed: seven high package findings, one root advisory |
| `npm audit --omit=dev --json` | Zero vulnerabilities; does not waive launch gate |
| `git diff --check` | Passed |
| Browser command below | **17 scenarios passed, 0 failed** in local Chromium harness |

Browser command actually run:
```sh
NODE_PATH=/home/user/browser-tools/node_modules \
LD_LIBRARY_PATH=/home/user/browser-tools/al2023/lib \
node scripts/verify-intro-browser.mjs
```
Temporary external tooling: Playwright 1.64.1, @sparticuz/chromium 153.0.0. The earlier missing libnspr4 issue was resolved locally by extracting the libraries already included in that npm package; no system package installation, dependency manifest change or production change. Browser web-security-disabling flags were excluded. The script creates/cleans an ignored component fixture, starts/closes its local Vite server, and runs React StrictMode against the real IntroGate and CSS/assets. It is not a Next.js production build, authenticated HTTP flow, or physical-device test. The separate exploratory harness was stopped.

17 browser scenarios: eight viewport sizes from the checklist; actual video metadata/decoding/time advancement; resize/rotation preserving element/playhead and changing ratio; Skip/pause with inert/focus through exit plus overflow restoration; reload dismissal persistence; Escape; initial reduced motion; live reduced-motion dismissal; failed-video fallback; storage denial with component remount. Viewport cases assert contain, fit, no horizontal overflow, initial focus, Tab/Shift-Tab loop, inert background and no page errors. They do not establish iOS/Android safe-area/browser-chrome behavior, physical touch ergonomics, or Safari/Firefox playback.

Unit totals include four real-handler/session/dashboard mocked-persistence flows, four dashboard cases, three log privacy cases, two static migration cases and ten intro source/asset guards. They are not additional counts beyond the full total. The corrected existing-order assertion verifies rendered Decimal-like totals, not a claimed proof of Next RSC serialization. The login success test now checks actual empty-state HTML and cookie attributes, not just a truthy React element.

## Staging / operator acceptance checklist

- [ ] Confirm production alias commit and DB project; obtain browser digest + UTC timestamp + request ID and protected server exception. Correlate after approved instrumentation deployment if needed.
- [ ] Record build/runtime env consistency without copying secrets: DATABASE_URL endpoint/flags, DIRECT_URL separation, session TTL, storage mode/bucket/origins, build-time public settings and generated client version.
- [ ] Approved staging migration replay/diff/status, client generation, full typecheck/lint/build/CI. Confirm historical rows unchanged and nullable/defaulted new fields valid.
- [ ] Valid/invalid login, inactive/locked users, expired/revoked session, logout/persistence, admin/student route separation and redirects, signup/duplicate accounts.
- [ ] Empty and existing-order dashboards; successful login response followed by successful `/dashboard` RSC response; no P2022/42703/enum/P2024 logs.
- [ ] Concurrent login/dashboard/notification requests with production-like pool settings; measure query latency/duplicates before any tuning. Do not blindly raise limits.
- [ ] Orders/upload verification/private download, cross-owner and cross-order denial, PDF preview, pricing snapshot, acceptance/printing/ready/delivery/rejection/cancellation and status timeline.
- [ ] Cash and UPI selection/submission/rejection/verification, explicit admin confirmation, separate payment/order axes, SUPER_ADMIN pricing edits and immutable historical totals.
- [ ] Intro on 320×568, 390×844, 430×932, 844×390, 768×1024, 1024×768, 1366×768, 1920×1080. Test fit/contain/black bars, safe areas/browser chrome and Skip visibility.
- [ ] Rotate/resize while playing: same element/playhead, no duplicate playback or overflow. Skip/Escape/Tab/Shift-Tab/focus return; reload/navigation after dismissal including storage denial; initial and live reduced motion; failed/slow video and poster; no console/network errors beyond deliberately induced fallback.
- [ ] Preserve GHSA launch gate; record official resolution or owner-signed acceptance before launch.
- [ ] Obtain explicit approval separately for production migration, environment changes, instrumentation/code deployment and any infrastructure action. No approval is implied by this report.
