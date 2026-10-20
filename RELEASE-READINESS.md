# XeroxEase release candidate review — 2026-10-20

> **Blocker-closure update:** `BLOCKER-CLOSURE.md` contains the exact operator
> evidence requests, CI execution/authorization paths and staging replay checklist.
> The reviewed source is being frozen in a local-only candidate commit; use the
> resulting branch HEAD SHA reported with that handoff. Earlier uncommitted counts
> and no-commit statements below describe the prior verification snapshot. No
> application code or previous test outcomes changed in the closure pass.

## Decision: HOLD — not a verified release candidate

Production incident outcome: **production failure could not be reproduced or correlated because runtime logs, browser digest/incident time and production database identity are unavailable**. Do not call the Server Components incident fixed. Passing local unit/browser component checks is not production readiness.

This report supersedes older “latest” counts and disconnected-Vercel statements in the initial investigation. Historical evidence remains in `INVESTIGATION-2026-10-20.md`.

## Current baseline

- Branch: `arena/424bd43f-xeroxease` (active).
- HEAD and current GitHub `main` (queried with `git ls-remote`): `04334a9c5d797b402cd47735d1bdb34eb5f188af`.
- Nothing staged; pre-existing edits were preserved. No commit, push, PR publication, deployment or remote workflow was performed.
- Vercel `list_deployments` (production/project-filtered) and `get_deployment` reconfirm `dpl_E1YCMoxNS69HwvqFut9UwmseTA6M`, `READY` / `PROMOTED`, target production, branch `main`, SHA `04334a9c5d797b402cd47735d1bdb34eb5f188af`.
- Alias `xeroxease.vercel.app`; immutable URL `xeroxease-7es1zllne-pashu-shield.vercel.app`.
- Project `xeroxease`, ID `prj_L8cPfseDXRCUaLxTAaExhlgVGpSA`; team PASHU SHIELD.
- Created 2026-10-20 **08:30:59.061 UTC**; ready **08:32:11.764 UTC**; alias assigned **08:32:11.996 UTC**. These are deployment times, not incident times.
- Deployed SHA matches main/HEAD, but not the uncommitted working-tree candidate. No CI or preview has tested these exact uncommitted changes. Existing main CI verify/migration checks passed and audit failed; those historical checks do not validate this patch.
- No exact release commit exists yet. Freeze/review the final patch and assign a commit SHA only after outstanding gates are addressed. Do not use current HEAD as though it includes this candidate.

## Production evidence and limits

Vercel and Supabase connector capabilities were reloaded. Vercel provides build logs/events, **not runtime/function-log retrieval**. Supabase provides project metadata/SQL but no mapping to a Vercel deployment's database configuration. No secret values were read/decrypted. Environment-variable names alone do not prove endpoint, pool flags, NODE_ENV value, storage mode or database identity. A public storage URL would not by itself prove DATABASE_URL targets the same project.

Required missing evidence:
1. Protected runtime logs for the confirmed deployment, filtered to the actual incident window, including `/api/auth/login` and subsequent `/dashboard` requests.
2. Browser digest, UTC incident timestamp and request/correlation ID, if available; export must exclude cookies, tokens, authorization headers and student/payment/document data.
3. Operator-attested **non-secret database project reference for the deployed DATABASE_URL**. No connection string should be supplied in chat.

Thus the live exception class/code/frames and whether login succeeded before rendering failed remain unknown. Missing columns, enum errors, P2024, pool limit 1, NODE_ENV mismatch, serialization errors and student-specific data issues are leads, not newly verified production facts. No live login requests were sent: a login writes session/audit/last-login data and was not authorized as a production write.

Read-only Supabase metadata was refreshed on the sole connected project `vjwvvoczyuebtowbnuqf` (PostgreSQL 17). It still records only the initial, recovery and direct-upload migrations; all nine PR #13 columns and new lifecycle/notification/payment-method enum labels remain absent. Diagnostic request `2f4fc4ae-16de-4d66-b5b3-4c93dad9dd90` identifies the metadata query, **not** a student request. This project is **not confirmed as production or approved staging**. No rows or credentials were read. The earlier zero-row 42703 reproduction applies to this project only.

## Confirmed local defects / focused fixes

| Severity | Path / defect | Evidence | Fix / regression |
|---|---|---|---|
| High availability | `src/server/auth.ts`: boolean argon2Tried became true before import completed; concurrent cold-start valid checks saw null and returned false, potentially incrementing lockout counters | Real-Argon2 regression failed with `[true,false]` for two correct passwords before fix; passes `[true,true]` after | Share the pending import promise and its cached success/failure. Existing password checks, bcrypt fallback, cookie/session/role rules unchanged. `tests/auth-sessions.test.ts` |
| Medium privacy | New `src/instrumentation.ts`: multiline Error.message could forge an otherwise-valid `at /app/studentSecret.js:1:2` stack line | Regression failed before fix, retaining forged message text | Remove the entire exact Error heading/message before frame filtering; unknown formats omit custom frames. Numeric Next digest, optional shape-checked request ID and conventional file locations only. `tests/server-error-logging.test.ts` |
| Medium | `/dashboard` active card treated DELIVERED/REJECTED as active | Original query omitted canonical terminals | Existing authoritative TERMINAL_STATUSES; component query regression |
| Medium accessibility | Intro background/focus/scroll released during exit while modal remained mounted | Browser check and original state dependencies | Keep isolation until AnimatePresence exit completion; tested by optional harness |
| Medium responsive/accessibility | Intro lacked required portrait presentation and modal focus isolation | Existing component/CSS review | Available-stage width+height fit, contain, stable video element, safe-area/dvh sizing, initial/looped focus, reduced motion, fallback and dismissal persistence |

**Neither the cold-start auth race nor the new logger issue establishes the cause of the production RSC incident.** The logger is not deployed. The Argon2 defect affects credential validation, whereas the reported incident may be after login.

Custom logger does not emit passwords, URLs, cookies, arbitrary headers, error messages, query values or student records. Request ID is a sanitized correlation aid, not independently authenticated proof. Native Next protected exception logging remains intact; this is not a claim that every pre-existing provider/API log is sanitized. User-facing error boundary remains generic; unexpected schema failures still propagate rather than masquerade as empty dashboards.

## Complete candidate file list

| File | Purpose |
|---|---|
| `src/server/auth.ts` | Pending Argon2 import sharing; fixes confirmed concurrent valid-login rejection |
| `tests/auth-sessions.test.ts` | Real-Argon2 cold-start concurrency regression; existing auth/session tests retained |
| `src/instrumentation.ts` | Structured server correlation, message/frame privacy filtering; added during investigation, not deployed |
| `src/app/error.tsx` | Browser digest/path/time logging; corrects false claim that browser effect writes server logs |
| `src/app/(student)/dashboard/page.tsx` | Exclude canonical and legacy terminal orders using existing shared model |
| `src/components/intro-gate.tsx` | Modal focus/isolation through exit, pause, storage fallback, reduced motion, contained stable video |
| `src/app/globals.css` | 16:9 / mobile-portrait 9:16 frame sized to available stage, dynamic viewport and safe areas |
| `tests/server-error-logging.test.ts` | Four privacy/correlation cases including forged multiline message |
| `tests/student-login-dashboard-flow.test.ts` | Four real-handler/password/session/dashboard flows with mocked persistence/cookies |
| `tests/student-dashboard.test.ts` | Four rendering/query/error-propagation cases |
| `tests/lifecycle-migration-contract.test.ts` | Two static SQL contract checks; not SQL replay |
| `tests/intro-video.test.ts` | Ten source/asset guards, including three added orientation/asset checks |
| `scripts/verify-intro-browser.mjs` | Optional local component harness using external test-only browser tooling |
| `vitest.config.ts` | Automatic OXC JSX transform to execute actual TSX in installed Vite/Vitest |
| `SECURITY.md` | Preserve launch gate; prior risk prose is not owner-signed acceptance |
| `INVESTIGATION-2026-10-20.md` | Detailed historical evidence and earlier test history |
| `RELEASE-READINESS.md` | Hold decision, PR draft, approval/rollout/recovery plan and recorded verification snapshot |
| `BLOCKER-CLOSURE.md` | Operator requests, runner authorization paths, staging evidence and source-freeze handoff |

No migrations, package manifests/lockfiles, CI files, environment files, storage policies or media assets changed. Ignored temporary fixture/cache files and external test-tool binaries are not candidate source changes.

## Migration validation — static complete; shared-target execution not authorized

Reviewed PR #13 merged file list/merge SHA, schema, PostgreSQL migration lock and both unchanged SQL files:
1. `20261020000000_order_lifecycle_enum_values`: append OrderStatus ORDER_RECEIVED, ACCEPTED, READY_FOR_PICKUP, DELIVERED, REJECTED and NotificationType ORDER_REJECTED, ORDER_ACCEPTED.
2. `20261020000100_order_lifecycle_payments_pricing`: change default to ORDER_RECEIVED; create PaymentMethod CASH_ON_DELIVERY/UPI; add payment_method, accepted_at/by, rejected_at/by, rejection_reason, delivered_at, pricing_snapshot, finishing_options; add orders(payment_method,payment_status) index.

Payment method is nullable enum; six lifecycle audit columns are nullable TIMESTAMP(3)/TEXT; pricing_snapshot nullable JSONB; finishing_options TEXT[] NOT NULL DEFAULT empty array. Names/types/defaults match the checked-out schema. Prior statuses/totals/events are not updated; no backfill of old snapshots. The new actor fields are plain TEXT, **not new foreign keys**; do not claim referential constraints absent from SQL/schema.

Prerequisites: initial objects/history match, privileges and namespace/search_path correct, no partial/failed migrations; validate any pre-existing PaymentMethod type, because its DO guard tests only name existence. First migration's new enum values must commit before the next uses them. Do not combine both migrations into one transaction. Second migration is not generally rerunnable: ADD COLUMN/CREATE INDEX lack IF NOT EXISTS; inspect failed state before retry/resolve, never mark applied to conceal failure.

ALTER TABLE and non-concurrent index construction take locks; approved staging must measure duration/lock impact with production-like row counts. PostgreSQL constant defaults may avoid a physical rewrite, but that is not a no-lock/no-downtime guarantee. New application code needs the schema first. Older code may read additive columns harmlessly but cannot be assumed to understand new enum states/defaults or payment semantics; code rollback after new writes is not automatically safe.

**Approved staging/shadow target: none. Production target identity: unconfirmed.** No SQL replay, DML preservation test, migration deploy/status/diff or DB concurrency execution was performed against a shared database.

Proposed staging work, awaiting exact target/operation approval:
- DBA verifies isolated staging and shadow project/database identities, no unrelated live data, restore capability, engine/version compatibility and sanitized representative fixtures.
- Establish pre-PR #13 baseline in staging; capture counts/checksums of historical fixture values, expected legacy states and totals.
- Execute the existing two migrations in order, with separate enum/default commit boundaries; inspect migration history and columns/types/defaults/indexes/enum labels.
- Run schema diff on the separately approved shadow database; test ORDER_RECEIVED insertion, legacy reads, nullable fields, snapshot immutability, data preservation and recovery from an intentionally failed migration only in a disposable approved target.
- Run real PostgreSQL integration tests and login/dashboard/order/payment/admin/private-file flows using staging test accounts/objects. These tests write; approval must name the targets and permitted data scope.

## Verification results and limitations

See final result table appended below. Standard npm scripts were used; no engine stub, validation suppression, ignored TypeScript error or unofficial dependency fork was used.

Normal `npm ci` exits 1 at postinstall `prisma generate` because binaries.prisma.sh is network-blocked. Dependencies are present enough for unit/lint/browser execution, but **clean install success is not claimed**. The current typecheck errors must be re-evaluated after real generation; it is not established that all errors are environmental. No permitted engine-enabled runner was available for the uncommitted patch; publishing/triggering Vercel-connected CI was not authorized.

Browser command: `NODE_PATH=/home/user/browser-tools/node_modules LD_LIBRARY_PATH=/home/user/browser-tools/al2023/lib node scripts/verify-intro-browser.mjs`. External tooling: Playwright 1.64.1, Chromium 153.0.0. Tests eight sizes 320×568 through 1920×1080, StrictMode, actual MP4 decoding/time advancement, mute/inline, contain, ratio/fit/no horizontal overflow, focus loop/inertness, rotation without element/playhead reset, pause/isolation through exit, scroll restore, Skip/Escape, reload persistence, initial/live reduced motion, network-failure fallback and storage denial/remount. Existing 1280×720 asset and poster unchanged; portrait is intentional letterboxing, not native portrait artwork. No physical mobile/notch/browser-chrome, Safari or Firefox coverage. Not a Next production/RSC HTTP or live Supabase round-trip test.

Risk-based review covers actual auth route/helpers/layout, dashboard queries, shared lifecycle/payment rules, admin role and SUPER_ADMIN pricing guards, order/file association/private-download checks, API generic errors, singleton/config/concurrency helpers and existing regression suite. There is no evidence justifying pool increases or extra Prisma clients. The local flow suite mocks persistence/cookie storage; no production DB or browser authentication pass is claimed. Storage round-trips, admin UI PDF preview, payment collection and real pool contention remain staging gates, not verified successes.

## Security gate

Requeried official GitHub advisory GHSA-vfj7-8cjw-p6xm: high; not withdrawn; no first patched version; range <=3.0.3. `npm view braces version`: 3.0.3. Installed tree still reaches braces 3.0.3 through Tailwind 3.4.19 → chokidar 3.6.0 and micromatch 4.0.8/fast-glob; lint config/plugin also reaches fast-glob/micromatch. Prisma's chokidar 4.0.3 is a separate non-braces chain.

Seven high package nodes: braces, chokidar, micromatch, fast-glob, tailwindcss, @next/eslint-plugin-next, eslint-config-next. One root advisory, not seven independent CVEs. Production-only audit zero does not satisfy launch policy. A major Tailwind 4 migration and lint-toolchain change require compatibility review/build/regression testing; no blind downgrade/force update/override was applied. No official compatible braces patch was found. **Launch remains blocked until official resolution or the required owner-signed risk acceptance.** Acceptance must explicitly identify advisory/tree, build/lint exposure, constraints on untrusted build input, named risk owner, expiry/review date and remediation plan; this document is not acceptance and audit enforcement remains enabled.

## PR description draft — not published

**Title:** Harden student auth cold starts, server diagnostics and responsive intro; fix terminal-order dashboard filtering

**Summary:** Preserve existing architecture and security controls. Fix reproduced Argon2 lazy-import race and diagnostic multiline-message leakage; exclude delivered/rejected orders from active dashboard; contain the existing video in orientation-aware frames with modal isolation through exit. Add focused tests and an optional browser component harness. Do not claim production RSC incident resolution.

**Root cause scope:** Connected-project schema drift confirmed, deployment mapping unknown; exact production runtime exception uncorrelated. Independent auth concurrency/privacy defects reproduced locally and repaired.

**Tests / migrations / risks:** Use final table below; two existing SQL migrations unchanged, approval-required; missing generated client/build/DB replay/security gates make this a HOLD PR, not deploy-ready. No production settings changed. Require real engine-enabled CI and approved staging before merge/release consideration.

## Proposed production rollout — DO NOT EXECUTE

| Owner | Operation / target / expected effect | Gate / risks |
|---|---|---|
| Operator + incident lead | Export sanitized runtime evidence and attest deployment DATABASE_URL project reference | Read-only; protect secrets/student data; correlation required before root-cause claim |
| Owner/security | Resolve advisory upstream or record required signed acceptance | Launch blocker cannot be bypassed; audit stays enforced |
| Maintainer | Freeze exact candidate commit after review; run approved install/generate/validate/typecheck/lint/unit/build/CI without auto-deployment | No intended SHA assigned yet; pushing/PR/workflow with deployment side effects requires explicit approval |
| DBA/QA | Execute staging plan above on named isolated staging/shadow targets | Explicit write scope, engine-enabled runner and recoverable fixtures approved; all gates must pass |
| DBA | Verify production backup/PITR restore point and perform restore drill on approved target | RPO/RTO, retention and potential loss of subsequent live writes understood; extra cost/restore writes need approval |
| Incident lead/operator | Approved maintenance/write pause if needed; verify exact DB/project/history and old-code compatibility | Do not allow unaware older writers to insert new enum/default values; operational actions require approval |
| DBA | After explicit authorization, `npm run db:deploy` against **operator-confirmed production target**, using the reviewed existing migration chain | Not authorized now; enum then columns/default; table/index lock and partial-failure risk. No reset/db push/resolve workaround |
| Release operator | After separate authorization, deploy the **approved frozen candidate SHA** to Vercel project xeroxease production | Not HEAD-as-placeholder; verify artifact/client and aliases; no NODE_ENV/pool/env changes without separate approval |
| QA/operator | Smoke tests with explicitly approved production test accounts/orders/files and payment-safe scenarios | Login/order/payment tests write live data. Define accounts, cleanup/audit and no-real-charge scope before approval |

Required environment review is non-secret: production NODE_ENV semantics; DATABASE_URL pool endpoint/transaction-mode compatibility and limit/timeout; DIRECT_URL suitable for migrations; session expiry/secure cookies; private storage backend/bucket and CSP origins; public build-time values. This plan does not infer current values or recommend changing them without evidence.

Smoke suite: student valid/invalid login/session/logout/expiry/role separation; empty/existing dashboard; terminal orders excluded; notifications/pricing; upload/PDF preview/private download and cross-owner denial; create/accept/print/ready/deliver/reject/cancel; COD/UPI claim/review/admin verification without auto-advancing print state; SUPER_ADMIN pricing/history; keyboard intro/portrait/landscape. Verify aliases/SHA/schema/history and absence of new browser/server errors.

Monitor login success→dashboard completion, 5xx/RSC digest rate, Prisma P2022/SQLSTATE 42703, invalid enum SQLSTATE 22P02/unsafe enum use, P2024/pool queue/latency, storage/signing failures, auth failures/lockouts, payment/status/audit integrity. Observe safe digest/time/request ID correlations, not student records.

Stop rollout on unexpected migration state, lock/latency threshold exceedance (thresholds must be agreed in staging), increased login/render failures, authorization regressions, payment inconsistencies or missing private files. Do not repeatedly retry a failed migration or auto-rollback enums. DBA inspects partial state and chooses reviewed forward repair or separately approved restore. Restoring a backup can discard writes since the recovery point; code rollback alone does not repair schema and can misinterpret new states. Freeze further writes only under approved incident procedure. Reconfirm security/data-integrity gates before reopening traffic.

## Exact approvals still needed

1. Named isolated staging **and shadow** targets, permitted migration/test/fixture/restore writes, and any production-like data handling.
2. An existing engine-enabled runner for this exact patch, with explicit permission for any push/PR/workflow and assurance it will not deploy without approval.
3. Owner-signed advisory risk acceptance (if chosen) or a separately reviewed official toolchain remediation; not implied by general task authorization.
4. Only after evidence/build/staging/security gates pass: exact production database migration target/operation/window, backup/recovery procedures, and a separately named Vercel production commit deployment. Any env/settings change is a separate request.
5. Explicit production smoke-test account/object/write scope, cleanup rules and payment safety limits. No such production writes were performed here.

## Final command outcomes for this candidate (2026-10-20)

| Command | Exit | Actual outcome |
|---|---:|---|
| `npm ci` | 1 | Lockfile install reaches postinstall then Prisma engine download fails; clean installation not passed |
| `npm run db:generate` | 1 | Blocked at binaries.prisma.sh TLS/download; no usable generated client |
| `npx prisma validate` | 1 | Same engine-download block; schema validation not passed |
| `npm run typecheck` | 2 | **48 diagnostics**, absent/incomplete generated Prisma types among errors; not a typecheck pass or proof all errors are environment-only |
| `npm run lint` | 0 | Zero warnings/errors; Next lint command deprecation notice remains |
| `npm test` | 0 | **589 passed, 0 failed, 4 skipped (593)**; 42 files passed, 1 skipped |
| Targeted six-file auth/login/dashboard/logging/migration subset | 0 | **56 passed, 0 failed**, included in full total |
| `npx vitest run tests/recovery-concurrency.pg.test.ts` | 0 | **0 passed, 4 skipped**; opt-in real PostgreSQL target absent, not an integration pass |
| `npm run build` | 1 | Stops at Prisma generation; Next production build did not run |
| `npm run schema:check` | 0 | 13-model text comparison only; no SQL replay |
| `npm audit --audit-level=high` | 1 | Seven high package findings, one root advisory; retained |
| `npm audit --omit=dev --audit-level=high` | 0 | Zero vulnerabilities; launch gate not waived |
| Browser harness command above | 0 | **17 scenarios passed, 0 failed**; Chromium component harness only |
| `git diff --check` | 0 | Tracked diff whitespace clean; untracked candidate text also checked separately |

Targeted subset command:
```sh
npx vitest run tests/auth-sessions.test.ts tests/auth-login.test.ts \
  tests/student-login-dashboard-flow.test.ts tests/student-dashboard.test.ts \
  tests/server-error-logging.test.ts tests/lifecycle-migration-contract.test.ts
```
The Argon2 regression was first run against the pre-fix implementation: **1 failed, 20 passed**. The message-forgery logger regression was first run against its pre-fix implementation: **1 failed, 3 passed**. Both pass after minimal fixes. These expected reproduction failures are not concealed or counted as passing checks.

Working tree at the recorded verification snapshot: **9 modified tracked files, 8 untracked candidate files**, nothing staged, all uncommitted. No exact candidate SHA or published PR exists. Files and before/after logs remain available for review; no source changes beyond those listed above.
