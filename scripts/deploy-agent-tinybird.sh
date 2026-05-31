#!/usr/bin/env bash
# Deploy the Tinybird schema (datasources/*, pipes/*) through a scripted release gate. This is the
# break-glass / local path; CI is the normal deploy path (.github/workflows/deploy.yml runs the apply
# on merge to main, ci.yml runs `--check` on every PR that touches datasources/** or pipes/**).
# `tb build` + `tb --cloud deploy --check` is the only thing that counts as schema verification
# (TRA-110, TRA-118). There is no manual admin-token insert path.
#
# Auth: defaults to the ambient `tb` cloud login (.tinyb). For headless/CI use, set TB_TOKEN (and
# TB_HOST if not api.tinybird.co) — `tb` reads those natively, no interactive login needed. The token
# itself selects the workspace, so the guard below asserts the token resolves to TB_TARGET_WORKSPACE
# and refuses to deploy anywhere else. A prod token in a dev-targeted run (or vice versa) fails fast.
#
# Dev is the default target and requires no opt-in. Production is opt-in only: it requires
# TB_TARGET_WORKSPACE=trace_flow_prod.
#
# Usage:
#   scripts/deploy-agent-tinybird.sh                                   # validate + deploy to dev
#   scripts/deploy-agent-tinybird.sh --check                           # validate only (dev)
#   TB_TARGET_WORKSPACE=trace_flow_prod scripts/deploy-agent-tinybird.sh --check   # validate against prod
#   TB_TARGET_WORKSPACE=trace_flow_prod scripts/deploy-agent-tinybird.sh           # deploy to prod (opt-in)
#   # headless: export TB_TOKEN=<prod deploy token> first
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

# The active workspace is whatever the token (TB_TOKEN) or .tinyb login resolves to. Assert it matches
# the intended target so a misconfigured token can never deploy to the wrong workspace.
current="$(tb --no-version-warning --cloud workspace current | awk '/^name:/{print $2; exit}')"
if [[ "$current" != "$TARGET_WORKSPACE" ]]; then
  echo "Refusing to deploy: token resolves to workspace '$current', expected '$TARGET_WORKSPACE'." >&2
  echo "Local: switch with 'tb --cloud workspace use $TARGET_WORKSPACE'. CI: check the TB_TOKEN secret." >&2
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

echo "Deploying schema to $current ..."
tb --cloud deploy
