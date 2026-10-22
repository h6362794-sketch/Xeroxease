#!/usr/bin/env bash
# ==============================================================================
# XeroxEase — Production Backup + Storage Archive + Isolated PG17 Rehearsal Gate
# ==============================================================================
# SAFETY GUARANTEES:
# 1. Read-only against Production: performs ONLY `pg_dump -Fc` over `DIRECT_URL`
#    (and verifies `_prisma_migrations` row count before/after) + Storage read.
#    NEVER runs `prisma migrate deploy` or any write against `DIRECT_URL`!
# 2. Zero secret exposure: NEVER sets `set -x`, NEVER logs URLs/passwords/keys,
#    NEVER prints customer filenames/emails/order rows, enforces `umask 077`,
#    and refuses any output directory inside the git repository.
# 3. Version-matched PostgreSQL 17 rehearsal: uses local PG17 tools if installed
#    (plus `LOCAL_PG17_ADMIN_URL` when provided), or automatically launches a
#    disposable `postgres:17-alpine` Docker container bound ONLY to `127.0.0.1`
#    and tears it down unconditionally on exit.
# ==============================================================================

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

die() {
  echo "[rehearse] ERROR: $*" >&2
  exit 1
}

log() {
  echo "[rehearse] $*"
}

# --- 1. Validate required environment variables without printing secrets ------
[[ -n "${DIRECT_URL:-}" ]] || die "DIRECT_URL is not set. Export your Session Pooler port 5432 URI first."
[[ "${DIRECT_URL}" =~ ^postgres(ql)?:// ]] || die "DIRECT_URL must begin with postgresql:// or postgres://."
if [[ "${DIRECT_URL}" == *":6543/"* || "${DIRECT_URL}" == *":6543?"* || "${DIRECT_URL}" =~ :6543$ ]]; then
  die "DIRECT_URL points to port 6543 (transaction pooler). Use port 5432 (Supabase Session Pooler aws-*-<region>.pooler.supabase.com:5432?sslmode=require)."
fi

STORAGE_URL="${SUPABASE_URL:-${NEXT_PUBLIC_SUPABASE_URL:-}}"
[[ -n "${STORAGE_URL}" ]] || die "Set NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) in environment."
[[ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]] || die "Set SUPABASE_SERVICE_ROLE_KEY in environment."

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="${BACKUP_ROOT:-${HOME}/xeroxease-backups/${STAMP}}"

RESOLVED_REPO="$(node -e 'console.log(require("path").resolve(process.argv[1]))' "${REPO_ROOT}")"
RESOLVED_BACKUP="$(node -e 'console.log(require("path").resolve(process.argv[1]))' "${BACKUP_ROOT}")"
node -e '
const path = require("path");
const rel = path.relative(process.argv[1], process.argv[2]);
if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
  process.exit(2);
}
' "${RESOLVED_REPO}" "${RESOLVED_BACKUP}" || die "BACKUP_ROOT must be outside the git repository (${REPO_ROOT})."

mkdir -p "${RESOLVED_BACKUP}"
chmod 700 "${RESOLVED_BACKUP}"

DUMP_FILE="${RESOLVED_BACKUP}/xeroxease-prod-${STAMP}.dump"
TOC_FILE="${RESOLVED_BACKUP}/toc.txt"
STORAGE_DIR="${RESOLVED_BACKUP}/storage"
DB_SUMS_FILE="${RESOLVED_BACKUP}/SHA256SUMS"
REPORT_FILE="${RESOLVED_BACKUP}/rehearsal-report.json"

# --- 2. Provision PG17 tools & isolated local PG17 rehearsal target -----------
DOCKER_CONTAINER=""
LOCAL_TEMP_DB=""
LOCAL_ADMIN_URL="${LOCAL_PG17_ADMIN_URL:-}"

cleanup() {
  set +e
  if [[ -n "${LOCAL_TEMP_DB}" && -n "${LOCAL_ADMIN_URL}" ]] && command -v psql >/dev/null 2>&1; then
    psql "${LOCAL_ADMIN_URL}" -X -q -v ON_ERROR_STOP=0 \
      -c "DROP DATABASE IF EXISTS \"${LOCAL_TEMP_DB}\" WITH (FORCE);" >/dev/null 2>&1
  fi
  if [[ -n "${DOCKER_CONTAINER}" ]]; then
    docker rm -f -v "${DOCKER_CONTAINER}" >/dev/null 2>&1
  fi
}
trap cleanup EXIT

HAVE_LOCAL_PG_TOOLS=0
if command -v pg_dump >/dev/null 2>&1 && command -v pg_restore >/dev/null 2>&1 && command -v psql >/dev/null 2>&1; then
  PG_DUMP_MAJOR="$(pg_dump --version | sed -E 's/.* ([0-9]+)\..*/\1/')"
  SRC_SERVER_MAJOR="$(psql "${DIRECT_URL}" -X -q -t -A -v ON_ERROR_STOP=1 \
    -c "SELECT current_setting('server_version_num')::int / 10000;" 2>/dev/null || echo 99)"
  if [[ "${PG_DUMP_MAJOR}" =~ ^[0-9]+$ && "${SRC_SERVER_MAJOR}" =~ ^[0-9]+$ ]] \
    && (( PG_DUMP_MAJOR >= SRC_SERVER_MAJOR )); then
    HAVE_LOCAL_PG_TOOLS=1
  fi
fi

if [[ -z "${LOCAL_ADMIN_URL}" || "${HAVE_LOCAL_PG_TOOLS}" -eq 0 ]]; then
  command -v docker >/dev/null 2>&1 || die "PostgreSQL 17 client/server not found locally and Docker is unavailable. Install Docker Desktop or PostgreSQL 17."
  LOCAL_PG_PASS="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
  DOCKER_CONTAINER="xe-pg17-rehearsal-${STAMP,,}-$$"
  log "Starting isolated local PostgreSQL 17 rehearsal container bound to 127.0.0.1..."
  docker run -d \
    --name "${DOCKER_CONTAINER}" \
    -e "POSTGRES_USER=postgres" \
    -e "POSTGRES_PASSWORD=${LOCAL_PG_PASS}" \
    -e "POSTGRES_DB=postgres" \
    -p 127.0.0.1::5432 \
    postgres:17-alpine >/dev/null

  PORT_LINE="$(docker port "${DOCKER_CONTAINER}" 5432/tcp | head -n1)"
  HOST_PORT="${PORT_LINE##*:}"
  [[ "${HOST_PORT}" =~ ^[0-9]+$ ]] || die "Could not determine mapped host port for local PG17 container."

  for _ in $(seq 1 40); do
    if docker exec "${DOCKER_CONTAINER}" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
  docker exec "${DOCKER_CONTAINER}" pg_isready -U postgres -d postgres >/dev/null 2>&1 \
    || die "Local PostgreSQL 17 rehearsal container failed readiness check."

  REHEARSAL_DB="xe_rehearsal_${STAMP,,}"
  docker exec "${DOCKER_CONTAINER}" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"${REHEARSAL_DB}\";"
  REHEARSAL_URL="postgresql://postgres:${LOCAL_PG_PASS}@127.0.0.1:${HOST_PORT}/${REHEARSAL_DB}?sslmode=disable"
else
  LOCAL_TEMP_DB="xe_rehearsal_${STAMP,,}"
  log "Creating isolated local PostgreSQL 17 rehearsal database (${LOCAL_TEMP_DB})..."
  psql "${LOCAL_ADMIN_URL}" -X -q -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"${LOCAL_TEMP_DB}\";"
  REHEARSAL_URL="$(node -e '
    const u = new URL(process.argv[1]);
    u.pathname = "/" + process.argv[2];
    console.log(u.toString());
  ' "${LOCAL_ADMIN_URL}" "${LOCAL_TEMP_DB}")"
fi

run_psql_source() {
  local sql="$1"
  if [[ "${HAVE_LOCAL_PG_TOOLS}" -eq 1 ]]; then
    psql "${DIRECT_URL}" -X -q -t -A -v ON_ERROR_STOP=1 -c "${sql}"
  else
    docker exec -e "SRC_DSN=${DIRECT_URL}" "${DOCKER_CONTAINER}" \
      sh -c 'psql "$SRC_DSN" -X -q -t -A -v ON_ERROR_STOP=1 -c "$1"' _ "${sql}"
  fi
}

run_psql_rehearsal() {
  local sql="$1"
  if [[ "${HAVE_LOCAL_PG_TOOLS}" -eq 1 ]]; then
    psql "${REHEARSAL_URL}" -X -q -t -A -v ON_ERROR_STOP=1 -c "${sql}"
  else
    docker exec "${DOCKER_CONTAINER}" \
      psql -U postgres -d "${REHEARSAL_DB}" -X -q -t -A -v ON_ERROR_STOP=1 -c "${sql}"
  fi
}

# --- 3. Read-only source precheck + custom-format dump (`pg_dump -Fc`) --------
SRC_MIGRATIONS_BEFORE="$(run_psql_source "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;")"
log "Step 1/7: Exporting custom-format PostgreSQL dump (source finished migrations=${SRC_MIGRATIONS_BEFORE})..."
if [[ "${HAVE_LOCAL_PG_TOOLS}" -eq 1 ]]; then
  pg_dump --dbname="${DIRECT_URL}" -Fc --no-owner --no-privileges -f "${DUMP_FILE}"
else
  docker exec -e "SRC_DSN=${DIRECT_URL}" "${DOCKER_CONTAINER}" \
    sh -c 'pg_dump --dbname="$SRC_DSN" -Fc --no-owner --no-privileges' > "${DUMP_FILE}"
fi
chmod 600 "${DUMP_FILE}"
DUMP_BYTES="$(wc -c < "${DUMP_FILE}" | tr -d '[:space:]')"
(( DUMP_BYTES > 0 )) || die "Database dump file is 0 bytes."

log "Step 2/7: Verifying archive table of contents (pg_restore --list)..."
if [[ "${HAVE_LOCAL_PG_TOOLS}" -eq 1 ]]; then
  pg_restore --list "${DUMP_FILE}" > "${TOC_FILE}"
else
  docker exec -i "${DOCKER_CONTAINER}" pg_restore --list < "${DUMP_FILE}" > "${TOC_FILE}"
fi
chmod 600 "${TOC_FILE}"
TOC_LINES="$(grep -cv '^[[:space:]]*;' "${TOC_FILE}" || true)"
(( TOC_LINES > 0 )) || die "pg_restore --list produced no catalog entries."

# --- 4. Private Supabase Storage bucket archive + SHA-256 verification --------
log "Step 3/7: Archiving private Storage bucket into restricted folder..."
(cd "${REPO_ROOT}" && npx tsx scripts/backup-storage.ts "${STORAGE_DIR}")

log "Step 4/7: Computing and verifying SHA-256 checksums..."
DUMP_SHA256="$(node -e '
  const fs = require("fs"), crypto = require("crypto");
  const h = crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex");
  console.log(h);
' "${DUMP_FILE}")"
printf '%s  %s\n' "${DUMP_SHA256}" "$(basename "${DUMP_FILE}")" > "${DB_SUMS_FILE}"
chmod 600 "${DB_SUMS_FILE}"

# Re-verify every archived file against recorded SHA256SUMS using Node (cross-platform Linux/macOS/WSL)
node -e '
  const fs = require("fs"), path = require("path"), crypto = require("crypto");
  for (const [dir, sumsFile] of [[process.argv[1], "SHA256SUMS"], [path.join(process.argv[1], "storage"), "SHA256SUMS"]]) {
    const content = fs.readFileSync(path.join(dir, sumsFile), "utf8").trim();
    if (!content) continue;
    for (const line of content.split("\n")) {
      const [expected, relPath] = line.split(/  (.+)/);
      const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, relPath))).digest("hex");
      if (actual !== expected) throw new Error("SHA-256 verification failed for archive entry");
    }
  }
' "${RESOLVED_BACKUP}"

# --- 5. Isolated PG17 restore + migration replay + data-preservation checks ---
log "Step 5/7: Restoring custom dump into isolated local PostgreSQL 17 database..."
if [[ "${HAVE_LOCAL_PG_TOOLS}" -eq 1 ]]; then
  pg_restore --dbname="${REHEARSAL_URL}" --no-owner --no-privileges --exit-on-error "${DUMP_FILE}"
else
  docker exec -i "${DOCKER_CONTAINER}" \
    pg_restore -U postgres -d "${REHEARSAL_DB}" --no-owner --no-privileges --exit-on-error < "${DUMP_FILE}"
fi

PRE_COUNTS="$(run_psql_rehearsal "SELECT json_build_object(
  'users', (SELECT count(*) FROM users),
  'orders', (SELECT count(*) FROM orders),
  'uploaded_files', (SELECT count(*) FROM uploaded_files),
  'order_events', (SELECT count(*) FROM order_events),
  'payment_events', (SELECT count(*) FROM payment_events),
  'pricing_config', (SELECT count(*) FROM pricing_config)
)::text;")"

log "Step 6/7: Running pending Prisma migrations against isolated local PG17 copy ONLY..."
if [[ -n "${REHEARSAL_MIGRATE_CMD:-}" ]]; then
  (
    cd "${REPO_ROOT}"
    DATABASE_URL="${REHEARSAL_URL}" DIRECT_URL="${REHEARSAL_URL}" eval "${REHEARSAL_MIGRATE_CMD}"
  )
else
  (
    cd "${REPO_ROOT}"
    DATABASE_URL="${REHEARSAL_URL}" DIRECT_URL="${REHEARSAL_URL}" npx prisma migrate deploy
  )
fi

log "Step 7/7: Verifying zero data loss, schema convergence, and untouched source DB..."
POST_COUNTS="$(run_psql_rehearsal "SELECT json_build_object(
  'users', (SELECT count(*) FROM users),
  'orders', (SELECT count(*) FROM orders),
  'uploaded_files', (SELECT count(*) FROM uploaded_files),
  'order_events', (SELECT count(*) FROM order_events),
  'payment_events', (SELECT count(*) FROM payment_events),
  'pricing_config', (SELECT count(*) FROM pricing_config)
)::text;")"

[[ "${PRE_COUNTS}" == "${POST_COUNTS}" ]] \
  || die "Row-count mismatch on rehearsal DB! before=${PRE_COUNTS} after=${POST_COUNTS}"

SCHEMA_VERIFY="$(run_psql_rehearsal "SELECT
  (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) || ':' ||
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='orders') || ':' ||
  ('DELIVERED'::\"OrderStatus\")::text || ':' ||
  ('UPI'::\"PaymentMethod\")::text;")"

[[ "${SCHEMA_VERIFY}" == "5:40:DELIVERED:UPI" ]] \
  || die "Post-migration schema check failed on rehearsal DB (got ${SCHEMA_VERIFY}, expected 5:40:DELIVERED:UPI)."

APPLIED_NAMES_JSON="$(run_psql_rehearsal "SELECT coalesce(json_agg(row_to_json(m)), '[]'::json)::text FROM (SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at) m;")"
(
  cd "${REPO_ROOT}"
  APPLIED_NAMES_JSON="${APPLIED_NAMES_JSON}" npx tsx -e '
    import { readdirSync } from "node:fs";
    import { join } from "node:path";
    import { compareMigrations } from "./src/server/schema-readiness";
    const committed = readdirSync(join(process.cwd(), "prisma", "migrations"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    const rows = JSON.parse(process.env.APPLIED_NAMES_JSON || "[]") as Array<{
      migration_name: string;
      finished_at: string | null;
      rolled_back_at: string | null;
    }>;
    const applied = rows
      .filter((r) => Boolean(r.finished_at) && !r.rolled_back_at)
      .map((r) => r.migration_name);
    const result = compareMigrations(committed, applied);
    if (!result.ok) {
      console.error("[rehearse] Schema readiness check failed:", JSON.stringify(result));
      process.exit(1);
    }
  '
  if [[ "${SKIP_OFFLINE_PRISMA_ENGINE_PREFLIGHT:-0}" != "1" ]]; then
    DATABASE_URL="${REHEARSAL_URL}" DIRECT_URL="${REHEARSAL_URL}" npm run preflight:schema >/dev/null
  fi
)

SRC_MIGRATIONS_AFTER="$(run_psql_source "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;")"
[[ "${SRC_MIGRATIONS_BEFORE}" == "${SRC_MIGRATIONS_AFTER}" ]] \
  || die "Unexpected change detected on source _prisma_migrations count (${SRC_MIGRATIONS_BEFORE} -> ${SRC_MIGRATIONS_AFTER})!"

STORAGE_SUMMARY="$(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(JSON.stringify({ bucket: m.bucket, objectCount: m.objectCount, totalBytes: m.totalBytes }));
' "${STORAGE_DIR}/storage-manifest.json")"

node -e '
  const fs = require("fs");
  const report = {
    verifiedAt: new Date().toISOString(),
    dumpBytes: Number(process.argv[2]),
    dumpSha256: process.argv[3],
    tocEntries: Number(process.argv[4]),
    storage: JSON.parse(process.argv[5]),
    rehearsalRowCountsBefore: JSON.parse(process.argv[6]),
    rehearsalRowCountsAfter: JSON.parse(process.argv[7]),
    rehearsalSchemaVerify: process.argv[8],
    sourceFinishedMigrationsUnchanged: Number(process.argv[9]),
    productionModified: false
  };
  fs.writeFileSync(process.argv[1], JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
' "${REPORT_FILE}" "${DUMP_BYTES}" "${DUMP_SHA256}" "${TOC_LINES}" "${STORAGE_SUMMARY}" \
  "${PRE_COUNTS}" "${POST_COUNTS}" "${SCHEMA_VERIFY}" "${SRC_MIGRATIONS_AFTER}"

log "======================================================================"
log "REHEARSAL PASSED — Production database was NOT modified."
log "  Dump size (bytes) : ${DUMP_BYTES}"
log "  Dump SHA-256      : ${DUMP_SHA256}"
log "  Storage archive   : ${STORAGE_SUMMARY}"
log "  Row counts preserved: ${POST_COUNTS}"
log "  Schema verified   : ${SCHEMA_VERIFY}"
log "  Private report    : ${REPORT_FILE}"
log "======================================================================"
