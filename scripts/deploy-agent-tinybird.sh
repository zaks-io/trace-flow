#!/usr/bin/env bash
# CI deploys the repository directly. Only resources in the reviewed retirement manifest
# may be deleted; PR checks and production deploys use the same guard.
set -euo pipefail
export CI="${CI:-1}"
CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--check]" >&2
  exit 2
fi
ROOT_DIR="$(pwd)"
"$ROOT_DIR/scripts/verify-tinybird-copy-policy.sh"
if [[ "${TB_SKIP_BUILD:-}" != "1" ]]; then
  tb build
fi
CHECK_RESULT="$(mktemp)"
trap 'rm -f "$CHECK_RESULT"' EXIT
# The CLI emits the deletion inventory even when an unflagged destructive check fails.
CHECK_STATUS=0
tb --cloud --output json deploy --check | tee "$CHECK_RESULT" || CHECK_STATUS=$?
ALLOW_DESTRUCTIVE="$(node "$ROOT_DIR/scripts/ci/tinybird-destructive-diff.mjs" "$CHECK_RESULT")"
if [[ "$ALLOW_DESTRUCTIVE" == "1" ]]; then
  tb --cloud --output json deploy --check --allow-destructive-operations | tee "$CHECK_RESULT"
  node "$ROOT_DIR/scripts/ci/tinybird-destructive-diff.mjs" "$CHECK_RESULT" >/dev/null
elif [[ "$CHECK_STATUS" != "0" ]]; then
  exit "$CHECK_STATUS"
fi
if [[ "$CHECK_ONLY" == "1" ]]; then
  echo "Validate-only run; skipping deploy."
  exit 0
fi
if [[ "$ALLOW_DESTRUCTIVE" == "1" ]]; then
  tb --cloud deploy --allow-destructive-operations
else
  tb --cloud deploy
fi
