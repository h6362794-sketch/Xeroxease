# XeroxEase — blocker-closure handoff

**Decision: HOLD. No release-readiness or production-fix claim.** Read `RELEASE-READINESS.md` for previous executed tests, defect reproductions and the full rollout/recovery plan. This handoff does not repeat those checks or authorize any writes.

## Checklist and next responsible action

| State | Blocker / completed item | Evidence required to close | Next responsible action |
|---|---|---|---|
| Verified complete | Local auth/privacy/dashboard/intro fixes and recorded available tests | Prior recorded 589 unit tests passed, 4 skipped; 17 Chromium component scenarios passed; lint/whitespace passed. These are not production E2E results. | Maintainer retains the reviewed source; do not rerun unchanged tests merely to imply new evidence. |
| Verified complete | Candidate diff reviewed, existing work preserved, migration/package/CI/env/media files unchanged | Reviewed tracked diff and new source/test/harness files. Local-only candidate freeze gives a stable Git SHA; use the commit reported with this handoff, not base main. | Maintainer supplies the local commit SHA; no push/PR/remote trigger. |
| Waiting on operator access | Actual login/dashboard server exception and browser correlation | Deployment-scoped runtime/request logs, browser digest and real UTC incident time; request below | Vercel project operator exports sanitized retained logs or grants read-only execution-log capability. |
| Waiting on operator access | Production DATABASE_URL project identity | Operator attestation of the **deployed configuration's** non-secret Supabase project reference, deployment ID and verification time | Deployment/database operator supplies the attestation; no secret values or public-storage-URL inference. |
| Waiting on explicit authorization | Engine-enabled candidate execution without deployment | Named existing runner/workspace, permitted candidate transfer, no deployment hooks, no production secrets, no new charges | Repository owner approves one of the CI paths below. No executable authorized path for this candidate was found. |
| Failed validation | Installation/generation/validation/build could not finish; TypeScript actually failed | Successful exact-candidate `npm ci`, generate, validate, typecheck and build logs/exit codes on engine-enabled runner | Maintainer runs the sequence below after runner authorization; investigate remaining diagnostics rather than declaring them environmental. |
| Waiting on explicit authorization | Staging/shadow migration and database-test writes | Named isolated targets plus exact write scope, fixtures, recovery and limits | DBA/owner completes authorization request below. Connected project `vjwvvoczyuebtowbnuqf` is not implicitly staging or production. |
| Not yet tested | Database replay, historical-data preservation, enum/default behavior, lock duration, real DB integration and actual login→dashboard HTTP flow | Approved-target replay/diff/status, before/after assertions and integration/E2E results | DBA/QA executes approved plan; skipped tests do not count. |
| Failed validation | Full audit: seven high package nodes rooted in GHSA-vfj7-8cjw-p6xm | Official supported remediation with compatibility checks, or required owner-signed exception under policy | Security owner chooses remediation review or formal acceptance; current gate remains active. |
| Not yet tested | Physical-device/Safari/Firefox acceptance | Representative device/browser results where required by release policy | QA arranges existing test devices; no paid provisioning. |

### Exact previous failed-check outcomes (not rerun in this closure pass)

`npm ci`: exit 1 at Prisma postinstall; `npm run db:generate`: 1; `npx prisma validate`: 1; `npm run typecheck`: 2 with **48 diagnostics**; `npm run build`: 1 before Next build. Engine downloads from binaries.prisma.sh are blocked in this sandbox. `npx vitest run tests/recovery-concurrency.pg.test.ts`: exit 0 but **0 passed, 4 skipped**. The full audit exited 1. No successful complete candidate build exists.

## 1. Copyable operator request — runtime evidence

**To: Vercel project operator / incident reporter**

Please provide retained read-only request and serverless/function execution logs for:
- Project `xeroxease` (`prj_L8cPfseDXRCUaLxTAaExhlgVGpSA`), production alias `xeroxease.vercel.app`.
- Deployment **`dpl_E1YCMoxNS69HwvqFut9UwmseTA6M`**, Git SHA `04334a9c5d797b402cd47735d1bdb34eb5f188af`.
- Routes **POST `/api/auth/login`**, followed by **GET `/dashboard`**, including dashboard RSC render requests and associated function exceptions.
- **Browser digest: not supplied. Please provide the exact digest, if available.**
- **Incident UTC time: not supplied. Please provide an actual ISO-8601 UTC timestamp T.** Export the concrete interval **T minus 5 minutes through T plus 5 minutes**, and state its exact UTC start/end. The deployment's creation time (08:30:59.061 UTC on 2026-10-20) is **not** an incident timestamp and must not be substituted.

Safe fields: deployment/environment, route template and HTTP method/status, UTC event timestamp, existing platform request/trace/correlation IDs, region/function identifier, exception class, sanitized exception message (column/enum names and Prisma/PostgreSQL codes retained), browser/server digest, and sanitized code-file stack locations. Include existing evidence that credential verification/session creation completed only if it is already logged, with session/token/cookie values and hashes removed. A login HTTP 200 alone is not proof that the browser accepted a cookie or that the dashboard succeeded.

Exclude passwords, credentials, full URLs/query strings, SQL bound values, Authorization/Cookie/Set-Cookie contents, tokens or token hashes, student identifiers/records, payment references and document names/contents. Do not export raw HAR or unsanitized whole logs.

Required read-only capability: access to **runtime/request/function execution logs**, scoped to this project/deployment and UTC range, including function exception records and HTTP outcome metadata. Existing integration `get_deployment_events` returns **build** output and does not satisfy this capability. Build success is not incident correlation.

If logs expired, are unavailable under the existing retention/plan, or contain no matching incident, state that explicitly. Do not enable a paid log drain, extend paid retention, deploy instrumentation or initiate a fresh production login without separate authorization. If T is unknown, first identify it from existing reporter evidence or retained deployment runtime errors, rather than inventing a time window. A new reproduction writes sessions/audit data and needs its own approved test scope.

## 2. Copyable operator request — database identity

**To: authorized deployment/database operator**

Please attest the **non-secret Supabase project reference targeted by DATABASE_URL for deployment `dpl_E1YCMoxNS69HwvqFut9UwmseTA6M`**, including operator role, verification UTC time, and which existing deployment/infrastructure metadata establishes the association. Distinguish the deployment's frozen configuration from today's project defaults; a later environment change must not be silently attributed to this deployment.

Return only the project reference, confirmed production/nonproduction classification, and non-secret evidence provenance. No passwords, full host/user connection strings, environment values, tokens or keys. Do not post/decrypt secrets for this investigation. If safe metadata does not establish it, state **not confirmed**. NEXT_PUBLIC_SUPABASE_URL for storage, a matching project name, or the existence of one connected Supabase project is insufficient to prove DATABASE_URL identity.

After confirmed identity, the agent can inspect schema/enum/migration metadata read-only on the identified accessible project and compare it with the unchanged PR #13 SQL. Until then, findings on `vjwvvoczyuebtowbnuqf` must remain separate from production attribution.

## 3. Existing CI capability and missing authorization

Repository `.github/workflows/ci.yml` is active (workflow ID **384536192**). Its jobs use GitHub-hosted **ubuntu-latest**, Node **22**, and test-only local configuration. Historical run **39393956427** on base `04334a9` had successful verify and clean-PostgreSQL migration jobs, demonstrating an engine-capable environment **then**; audit failed. This is not an existing live runner reserved for this candidate or permission to execute it now.

Current triggers: **push to main** and **pull_request**; no `workflow_dispatch`. A rerun of that historical run tests old source, not this candidate. Pushing/opening a PR could independently trigger connected Vercel deployment even though the CI YAML itself has no deploy job. Neither action is authorized, and no workflow was triggered.

Owner must choose and explicitly authorize:

**Preferred without repository publication:** identify an existing approved engine-enabled workspace/runner (operator/owner, platform, Node version, outbound access, any cost limits), authorize transfer/check-out of this exact local candidate via an approved channel, and confirm execution cannot access production credentials or invoke deploy hooks. Run commands there, return SHA plus exit statuses and safe logs. Runner existence/access is currently unconfirmed.

**GitHub Actions alternative:** owner authorizes candidate publication on the fixed branch and a PR-triggered run **only after** confirming all external Vercel/deployment automation is prevented by an approved mechanism. Any settings/workflow changes require separate approval. The agent will not disable automation, push, open the PR or edit default-branch workflows implicitly. No production deployment or main push is part of this request.

Minimum engine-enabled check sequence (test-only config, no production credentials):
```sh
npm ci
npm run db:generate
npx prisma validate
npm run typecheck
npm run lint
npm test
npm run build
npm audit --audit-level=high
```
Record every command's independent exit status. Installation already generates Prisma Client, but the explicit generation step records the requested outcome. Schema validation requires syntactically valid runner-local DATABASE_URL/DIRECT_URL; do not supply shared live credentials. Do not use engine placeholders, skip TypeScript or suppress audit failure. Match approved runtime/toolchain; the historical workflow uses Node 22 while Vercel deployment metadata recorded Node 24.x, so record versions and resolve compatibility before release.

DB jobs below are **not** authorized by runner approval alone. Their targets and writes require separate authorization. Full tests with DB integration must not unknowingly pick up a production/shared database from the environment.

## 4. Exact staging/shadow authorization request and replay plan

**To: owner + DBA**

Please identify existing staging **and shadow** targets by non-secret project/database name and reference, PostgreSQL version, owner, isolation from production/unrelated live data, permitted fixture scope, execution window, lock/duration limits, restore source and recovery authority. Confirm whether the targets are disposable. Keep connection details in approved secret delivery to the runner, not chat or reports.

Explicitly authorize or reject each operation:
1. Establish the pre-PR #13 migration baseline on the named staging target and create only approved synthetic/historical-format fixture records.
2. Execute the **two unchanged PR #13 migrations in order** on staging.
3. Replay migrations for schema diff on the named shadow target, including Prisma's required temporary schema/reset activity there; shadow must be isolated/disposable and cannot be staging or production by accident.
4. Run database-backed integration/E2E tests and their fixture/session/order/payment-event/private-storage test writes on the named staging/test targets; storage writes require their own named private test bucket if needed.
5. Permit deliberate failed-migration/recovery experiments only on a separately identified disposable target; no destructive test on shared staging by implication. Restore/reset/cleanup permissions and data scope must be explicit.

Migrations:
- First: `20261020000000_order_lifecycle_enum_values` — append five order and two notification enum labels. Commit enum changes before using ORDER_RECEIVED in a default.
- Second: `20261020000100_order_lifecycle_payments_pricing` — PaymentMethod enum, nine order columns/defaults and payment-method/payment-status index. No substitute migration.

Before execution, DBA checks namespace/search_path, privileges, complete prior migration history/checksums, failed/rolled-back entries and actual column/type definitions. Existing PaymentMethod needs label/namespace verification; the DO name-existence guard does not prove equivalence. The second migration is **not generically idempotent**: its ADD COLUMN/CREATE INDEX statements must not be replayed blindly after a partial failure.

Data assertions on approved fixtures: save before/after row counts and deterministic digests of existing order IDs, user associations, statuses, totals/prices, payment fields and event history inside the secure test environment. Assert no existing rows deleted/changed, prior status labels readable, existing amounts unchanged, nullable new fields null, finishing_options empty by default. Assert future default ORDER_RECEIVED, expected enum labels, nine exact columns/types/defaults, the composite index and schema diff agreement. Test old-format and new lifecycle rows and immutable historical pricing snapshots. These assertions are planned, not executed.

Use approved runner-local configuration; execute `npm run db:deploy`, `npm run db:status`, the existing CI `prisma migrate diff --from-migrations ... --to-schema-datamodel ... --shadow-database-url ... --exit-code` pattern, and PostgreSQL integration tests only after target approval. Let Prisma apply separate migration files; do not wrap both in one transaction. Record independent outcomes, actual PostgreSQL/client versions, migration duration and lock waits. Assert DB tests actually ran rather than skipped.

ALTER TABLE/default changes and non-concurrent CREATE INDEX acquire locks. Measure under approved production-like fixture volume and concurrency; agree stop limits with DBA before shared-target execution. A successful text schema check does not validate locks, constraints, DML preservation or transaction behavior.

On failure: stop, collect safe migration/history/schema evidence, determine partial state, then ask DBA for the reviewed forward-repair or restore operation. Do not blindly retry, run reset/db push/resolve-as-applied, drop enum values/columns or rewrite historical orders. Reverting application code after new statuses/defaults/payment writes may misinterpret data. Restoring a backup may lose subsequent writes; do not treat it as an automatic safe rollback. Production remains untouched in this plan.

## 5. Security gate: refreshed official evidence

Rechecked official GitHub advisory and npm registry in this closure pass:
- GHSA-vfj7-8cjw-p6xm: **high**, not withdrawn; official first patched version **null**; vulnerable range **<=3.0.3**; advisory updated 2026-10-02.
- `npm view braces version`: **3.0.3**.
- Last executed full audit: seven high package findings from one root advisory. No compatible official braces patch is established.

Supported toolchain remediation still requires a separately reviewed Tailwind/toolchain upgrade removing every affected chain (including lint tooling), with install/typecheck/build/full tests/browser validation and a fresh complete audit. Do not blindly apply npm's force/downgrade suggestion or infer Tailwind alone removes the lint chain.

Closure evidence is either verified official resolution/remediation across the actual dependency tree, or the required **owner-signed risk acceptance** naming advisory, exposure analysis, residual build/lint risks, controls on untrusted build inputs, accountable owner, expiry/review date and remediation plan. No signed acceptance has been supplied. A clean production-only audit does not close this gate; CI audit enforcement remains unchanged.

## 6. Candidate freeze and boundaries

No additional application changes were necessary in this closure pass; only this handoff and report cross-references were added. Existing source changes and recorded tests were preserved. All reviewed candidate files will be frozen in a **local-only commit** on `arena/424bd43f-xeroxease`; its SHA is reported after commit creation. This is a source identifier, **not** release approval or a verified production-fix SHA. No push/PR/workflow/merge/deployment follows it.

Use `git show --stat HEAD` and `git rev-parse HEAD` after the local freeze to identify the full candidate. A later approved code change requires a new candidate SHA and relevant reruns; do not reuse old successful tests as evidence for changed code. No production/shared-target write is authorized by this handoff.
