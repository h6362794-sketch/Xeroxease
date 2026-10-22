#!/usr/bin/env bash
# Thin POSIX entrypoint delegating to the cross-platform TypeScript runner so
# both `npm run backup:rehearse` (Windows PowerShell/CMD, WSL2, macOS, Linux)
# and `bash scripts/rehearse-prod-backup.sh` execute the exact same verified code.
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."
exec npx tsx scripts/rehearse-prod-backup.ts "$@"
