#!/usr/bin/env bash
# Deploy the agent_* Tinybird schema (datasources/agent_*, pipes/agent_*) through a scripted release
# gate. Tinybird is not in CI, so this is the manual/scripted path the consumer and the end-to-end
# smoke run depend on. There is no manual admin-token insert path — `tb build` + `tb --cloud deploy
# --check` is the only thing that counts as schema verification (TRA-110).
#
# Dev is the default target and requires no opt-in. Production is opt-in only: it requires
# TB_TARGET_WORKSPACE=trace_flow_prod, and the gate refuses to deploy unless the current cloud
# workspace already matches that target. The script never silently switches workspaces — prod is the
# current cloud workspace in this account, so a bare `tb --cloud deploy` is dangerous; the explicit
# target check is the guard.
#
# Usage:
#   scripts/deploy-agent-tinybird.sh                                   # validate + deploy to dev
#   scripts/deploy-agent-tinybird.sh --check                           # validate only (dev)
#   TB_TARGET_WORKSPACE=trace_flow_prod scripts/deploy-agent-tinybird.sh --check   # validate against prod
#   TB_TARGET_WORKSPACE=trace_flow_prod scripts/deploy-agent-tinybird.sh           # deploy to prod (opt-in)
set -euo pipefail

TARGET_WORKSPACE="${TB_TARGET_WORKSPACE:-trace_flow_dev}"

case "$TARGET_WORKSPACE" in
  trace_flow_dev | trace_flow_prod) ;;
  *)
    echo "Refusing to deploy: unknown TB_TARGET_WORKSPACE '$TARGET_WORKSPACE'." >&2
    echo "Set TB_TARGET_WORKSPACE to trace_flow_dev or trace_flow_prod." >&2
    exit 1
    ;;
esac

current="$(tb --no-version-warning --cloud workspace current | awk '/^name:/{print $2; exit}')"
if [[ "$current" != "$TARGET_WORKSPACE" ]]; then
  echo "Refusing to deploy: current workspace is '$current', expected '$TARGET_WORKSPACE'." >&2
  echo "Switch with: tb --cloud workspace use $TARGET_WORKSPACE" >&2
  exit 1
fi

if [[ "$TARGET_WORKSPACE" == "trace_flow_prod" ]]; then
  echo "PRODUCTION Tinybird deploy target: $TARGET_WORKSPACE"
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
