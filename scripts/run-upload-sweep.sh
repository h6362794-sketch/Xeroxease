#!/usr/bin/env bash
# Runs one upload-cleanup pass against ONE deployment. Used by .github/workflows/upload-sweep.yml,
# and by tests/upload-sweep-script.test.ts with a local stub server.
#
# Inputs (environment variables; never printed):
#   SWEEP_URL      https://<host>/api/admin/uploads/sweep   (only loopback http, and only with
#                  SWEEP_ALLOW_LOOPBACK_HTTP=1, which the test harness sets)
#   SWEEP_EXPECTED_HOST  The approved staging hostname (bare host, no scheme or port). The host in
#                  SWEEP_URL must equal it exactly, or nothing is sent. This pins the only place
#                  the scheduler and bypass credentials may go.
#   SWEEP_TARGET   staging | production. Must equal that deployment's DEPLOY_TARGET; the app refuses
#                  any other value with 403 SCHEDULER_TARGET_MISMATCH.
#   CRON_SECRET    at least 32 characters. Sent as a bearer token.
#   SWEEP_LIMIT    optional, 1..500 (default 50)
#   SWEEP_PROTECTION_BYPASS  optional. Vercel "Protection Bypass for Automation" secret for a
#                  deployment behind Deployment Protection. Sent as x-vercel-protection-bypass.
#                  It clears Vercel's edge check only; the app still checks CRON_SECRET and
#                  X-Deploy-Target.
#
# The secret and the target travel in a header file on stdin, not on the command line, so they are
# not visible in the process list. Redirects are not followed (a redirect would drop the header
# semantics we rely on), and any non-2xx answer exits non-zero. The response body is never printed:
# only the HTTP status is.
set -euo pipefail

fail() { echo "upload-sweep: $*" >&2; exit 2; }

: "${SWEEP_URL:?SWEEP_URL is not set}"
: "${SWEEP_TARGET:?SWEEP_TARGET is not set}"
: "${SWEEP_EXPECTED_HOST:?SWEEP_EXPECTED_HOST is not set (the approved staging hostname)}"
: "${CRON_SECRET:?CRON_SECRET is not set}"
limit="${SWEEP_LIMIT:-50}"

case "$SWEEP_TARGET" in
  staging|production) ;;
  *) fail "SWEEP_TARGET must be \"staging\" or \"production\"." ;;
esac

if [ "${#CRON_SECRET}" -lt 32 ]; then
  fail "CRON_SECRET must be at least 32 characters."
fi

if ! [[ "$limit" =~ ^[0-9]+$ ]] || [ "$limit" -lt 1 ] || [ "$limit" -gt 500 ]; then
  fail "SWEEP_LIMIT must be a whole number from 1 to 500."
fi

proto="=https"
if [[ "$SWEEP_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/api/admin/uploads/sweep$ ]]; then
  :
elif [ "${SWEEP_ALLOW_LOOPBACK_HTTP:-}" = "1" ] && [[ "$SWEEP_URL" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?/api/admin/uploads/sweep$ ]]; then
  proto="=http,https"
else
  fail "SWEEP_URL must be https://<host>/api/admin/uploads/sweep (no other path, no http)."
fi

# Pin the destination. Lower-case both sides, compare the bare host (no port, no userinfo).
# This runs before any header is built, so a mis-pointed URL cannot receive the scheduler
# secret or the protection-bypass header.
expected_host="$(printf '%s' "$SWEEP_EXPECTED_HOST" | tr '[:upper:]' '[:lower:]')"
if ! [[ "$expected_host" =~ ^[a-z0-9.-]+$ ]]; then
  fail "SWEEP_EXPECTED_HOST must be a bare hostname. Nothing was sent."
fi
url_host="${SWEEP_URL#*://}"
url_host="${url_host%%/*}"
url_host="${url_host%%:*}"
url_host="$(printf '%s' "$url_host" | tr '[:upper:]' '[:lower:]')"
if [ "$url_host" != "$expected_host" ]; then
  fail "SWEEP_URL host is not SWEEP_EXPECTED_HOST. Nothing was sent."
fi

# Headers from stdin: the secret never appears on the command line.
headers="$(printf 'Authorization: Bearer %s\nX-Deploy-Target: %s\n' "$CRON_SECRET" "$SWEEP_TARGET")"
if [ -n "${SWEEP_PROTECTION_BYPASS:-}" ]; then
  headers="$(printf '%s\nx-vercel-protection-bypass: %s\n' "$headers" "$SWEEP_PROTECTION_BYPASS")"
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

status="$(printf '%s\n' "$headers" | curl --silent --show-error --fail-with-body \
  --proto "$proto" --max-redirs 0 --max-time 240 \
  -X POST -H @- \
  -o "$tmp" -w '%{http_code}' \
  "${SWEEP_URL}?limit=${limit}" || true)"

# Status only. The response body is not printed: it may carry data that should not reach logs.
echo "upload-sweep: HTTP ${status} from ${SWEEP_TARGET}"

case "$status" in
  2??) exit 0 ;;
  *) exit 1 ;;
esac
