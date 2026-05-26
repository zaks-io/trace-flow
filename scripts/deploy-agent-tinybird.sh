#!/usr/bin/env bash
# Deploy the agent_* Tinybird schema (datasources/agent_*, pipes/agent_*) to the
# DEV workspace. Tinybird is not in CI, so this is the manual/scripted path the
# consumer (2c) and the end-to-end run (2e) depend on. Prod stays gated until 2e
# lifts it — this script refuses to run against trace_flow_prod by design.
#
# Usage:
#   scripts/deploy-agent-tinybird.sh          # validate then deploy to dev
#   scripts/deploy-agent-tinybird.sh --check  # validate only (no deploy)
set -euo pipefail

EXPECTED_WORKSPACE="trace_flow_dev"

current="$(tb --no-version-warning --cloud workspace current | awk '/^name:/{print $2; exit}')"
if [[ "$current" != "$EXPECTED_WORKSPACE" ]]; then
  echo "Refusing to deploy: current workspace is '$current', expected '$EXPECTED_WORKSPACE'." >&2
  echo "Switch with: tb workspace use $EXPECTED_WORKSPACE" >&2
  exit 1
fi

echo "Validating schema offline (tb build) ..."
tb build

echo "Validating deployment against $current ..."
tb --cloud deploy --check

if [[ "${1:-}" == "--check" ]]; then
  echo "Validate-only run; skipping deploy."
  exit 0
fi

echo "Deploying agent_* schema to $current ..."
tb --cloud deploy
