#!/usr/bin/env bash
# Deploy the Tinybird schema (datasources/*, pipes/*) through a scripted release gate. This is the
# break-glass / local path; CI is the normal deploy path (.github/workflows/deploy.yml runs the apply
# on merge to main, ci.yml runs `--check` on every PR that touches datasources/** or pipes/**).
# `tb build` + `tb --cloud deploy --check` is the only thing that counts as schema verification
# (TRA-110, TRA-118). There is no manual admin-token insert path.
#
# Auth: defaults to the ambient `tb` cloud login (.tinyb). For headless/CI use, set TB_TOKEN (and
# TB_HOST if not api.tinybird.co) — `tb` reads those natively, no interactive login needed. The token
# itself selects the workspace, so there is nothing to "target": a prod token deploys to prod, a dev
# token to dev. This mirrors Tinybird's own CI/CD templates (tinybirdco/ci), which pass the token via
# env/flags and never call workspace-introspection commands.
#
# TB_TARGET_WORKSPACE is a deliberate prod opt-in gate, not a live assertion. Dev is the default and
# needs no opt-in. Production requires TB_TARGET_WORKSPACE=trace_flow_prod so a bare run can never
# deploy to prod by accident; pairing it with a non-prod TB_TOKEN simply fails at deploy time.
#
# We intentionally do NOT call `tb workspace current` to verify the token, and we export CI=1 below.
# Every `tb --cloud …` command (deploy, deploy --check, workspace current) prompts to confirm "running
# from an untracked folder" unless tb detects CI via the GITHUB_ACTIONS/CI env vars. The Blacksmith
# runner image doesn't reliably export those, so on empty stdin the prompt made the deploy exit 1 with
# no output — silently killing the whole prod deploy (TRA-118). Forcing CI=1 ourselves makes tb skip
# the prompt regardless of runner; the token then defines the workspace and a bad token fails loudly.
#
# Usage:
#   scripts/deploy-agent-tinybird.sh                                   # validate + deploy to dev
#   scripts/deploy-agent-tinybird.sh --check                           # validate only (dev)
#   TB_TARGET_WORKSPACE=trace_flow_prod scripts/deploy-agent-tinybird.sh --check   # validate against prod
#   TB_TARGET_WORKSPACE=trace_flow_prod scripts/deploy-agent-tinybird.sh           # deploy to prod (opt-in)
#   # headless: export TB_TOKEN=<prod deploy token> first
set -euo pipefail

# Make `tb --cloud …` non-interactive on any runner (see header note). Harmless locally.
export CI="${CI:-1}"

TARGET_WORKSPACE="${TB_TARGET_WORKSPACE:-trace_flow_dev}"

case "$TARGET_WORKSPACE" in
  trace_flow_dev | trace_flow_prod) ;;
  *)
    echo "Refusing to deploy: unknown TB_TARGET_WORKSPACE '$TARGET_WORKSPACE'." >&2
    echo "Set TB_TARGET_WORKSPACE to trace_flow_dev or trace_flow_prod." >&2
    exit 1
    ;;
esac

if [[ "$TARGET_WORKSPACE" == "trace_flow_prod" ]]; then
  echo "PRODUCTION Tinybird deploy target: $TARGET_WORKSPACE"
fi

# `tb build` validates offline but honours dev_mode=local in tinybird.config.json, so it needs a
# running Tinybird Local container. CI's PR gate provides one (ci.yml `tinybird-local` service) and
# runs the offline build there. The prod deploy job has no container — and doesn't need one: the
# authoritative cloud validation is `tb --cloud deploy --check` below, which runs against the real
# workspace right before the apply. So deploy.yml sets TB_SKIP_BUILD=1 to skip the local-only build.
if [[ "${TB_SKIP_BUILD:-}" == "1" ]]; then
  echo "Skipping offline tb build (TB_SKIP_BUILD=1); cloud deploy --check is the validation."
else
  echo "Validating schema offline (tb build) ..."
  tb build
fi

echo "Validating deployment against $TARGET_WORKSPACE ..."
tb --cloud deploy --check

if [[ "${1:-}" == "--check" ]]; then
  echo "Validate-only run; skipping deploy."
  exit 0
fi

echo "Deploying schema to $TARGET_WORKSPACE ..."
tb --cloud deploy
