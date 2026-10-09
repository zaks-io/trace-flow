#!/usr/bin/env bash
# CI deploys the repository directly. The TRA-405 approval only permits its exact retired resources;
# subsequent destructive deploys require a new approval dated the day of deployment.
set -euo pipefail
export CI="${CI:-1}"
TARGET_WORKSPACE="${TB_TARGET_WORKSPACE:-trace_flow_dev}"
CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--check]" >&2
  exit 2
fi
case "$TARGET_WORKSPACE" in
  trace_flow_dev | trace_flow_prod) ;;
  *) echo "Unknown TB_TARGET_WORKSPACE: $TARGET_WORKSPACE" >&2; exit 1 ;;
esac
ROOT_DIR="$(pwd)"
"$ROOT_DIR/scripts/verify-tinybird-copy-policy.sh"
if [[ "${TB_SKIP_BUILD:-}" != "1" ]]; then
  tb build
fi
CHECK_RESULT="$(mktemp)"
trap 'rm -f "$CHECK_RESULT"' EXIT
# Validation never applies changes. JSON carries the provider's authoritative drop inventory.
tb --cloud --output json deploy --check --allow-destructive-operations | tee "$CHECK_RESULT"
ALLOW_DESTRUCTIVE=0
if [[ "$TARGET_WORKSPACE" == "trace_flow_prod" ]]; then
  CLEANUP_CONSUMED="$(node "$ROOT_DIR/scripts/ci/tinybird-cleanup-receipt.mjs" check)"
  ALLOW_DESTRUCTIVE="$(node "$ROOT_DIR/scripts/ci/tinybird-cleanup-approval.mjs" "$CHECK_RESULT" "$CLEANUP_CONSUMED")"
else
  ALLOW_DESTRUCTIVE=1
fi
if [[ "$CHECK_ONLY" == "1" ]]; then
  echo "Validate-only run; skipping deploy."
  exit 0
fi
CLEANUP_RECEIPT=""
if [[ "$TARGET_WORKSPACE" == "trace_flow_prod" && "$ALLOW_DESTRUCTIVE" == "1" && "${TINYBIRD_CLEANUP_APPROVED:-}" == "trace_flow_prod_20261009" ]]; then
  # Persist consumption before Tinybird writes. An incomplete attempt requires fresh approval.
  CLEANUP_RECEIPT="$(node "$ROOT_DIR/scripts/ci/tinybird-cleanup-receipt.mjs" consume)"
fi
if [[ "$ALLOW_DESTRUCTIVE" == "1" ]]; then
  tb --cloud deploy --allow-destructive-operations
else
  tb --cloud deploy
fi

if [[ -n "$CLEANUP_RECEIPT" ]]; then
  node "$ROOT_DIR/scripts/ci/tinybird-cleanup-receipt.mjs" success "$CLEANUP_RECEIPT"
fi
