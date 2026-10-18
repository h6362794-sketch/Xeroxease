#!/usr/bin/env bash
# Runs one upload-cleanup pass against ONE deployment. Used by .github/workflows/upload-sweep.yml,
# and by tests/upload-sweep-script.test.ts with a local stub server.
#
# Inputs (environment variables; never printed):
#   SWEEP_URL      https://<host>/api/admin/uploads/sweep   (only loopback http, and only with
#                  SWEEP_ALLOW_LOOPBACK_HTTP=1, which the test harness sets)
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
# semantics we rely on), and any non-2xx answer exits non-zero.
set -euo pipefail

fail() { echo "upload-sweep: $*" >&2; exit 2; }

: "${SWEEP_URL:?SWEEP_URL is not set}"
: "${SWEEP_TARGET:?SWEEP_TARGET is not set}"
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

echo "upload-sweep: HTTP ${status} from ${SWEEP_TARGET}"
# The body is the sweep report (counts only). It contains no secret.
cat "$tmp"
echo

case "$status" in
  2??) exit 0 ;;
  *) exit 1 ;;
esac
