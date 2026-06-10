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
# Phased rollout:
#   expand  - deploy new clean resources while preserving legacy datasources and legacy endpoint pipes.
#   switch  - deploy clean endpoint pipes, keep legacy tables, and stop scheduled legacy copy pipes.
#   cleanup - deploy only repo resources and delete legacy Tinybird resources; prod requires approval.
#
# The repo can keep clean final names while prod expansion/switch use a generated temporary deploy tree
# containing needed legacy files from TINYBIRD_LEGACY_REF. This keeps rollback possible without committing
# old `_copy` or `_v2` files back into main.
#
# Usage:
#   scripts/deploy-agent-tinybird.sh
#   scripts/deploy-agent-tinybird.sh --check
#   TB_TARGET_WORKSPACE=trace_flow_prod scripts/deploy-agent-tinybird.sh --check
#   TB_TARGET_WORKSPACE=trace_flow_prod TINYBIRD_DEPLOY_PHASE=switch scripts/deploy-agent-tinybird.sh
#   TB_TARGET_WORKSPACE=trace_flow_prod TINYBIRD_DEPLOY_PHASE=cleanup \
#     TINYBIRD_CLEANUP_APPROVED=trace_flow_prod_YYYYMMDD scripts/deploy-agent-tinybird.sh
#   # headless: export TB_TOKEN=<prod deploy token> first
set -euo pipefail

# Make `tb --cloud …` non-interactive on any runner (see header note). Harmless locally.
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
  *)
    echo "Refusing to deploy: unknown TB_TARGET_WORKSPACE '$TARGET_WORKSPACE'." >&2
    echo "Set TB_TARGET_WORKSPACE to trace_flow_dev or trace_flow_prod." >&2
    exit 1
    ;;
esac

if [[ -n "${TINYBIRD_DEPLOY_PHASE:-}" ]]; then
  DEPLOY_PHASE="$TINYBIRD_DEPLOY_PHASE"
elif [[ "$TARGET_WORKSPACE" == "trace_flow_prod" ]]; then
  DEPLOY_PHASE="expand"
else
  DEPLOY_PHASE="cleanup"
fi

case "$DEPLOY_PHASE" in
  expand | switch | cleanup) ;;
  *)
    echo "Refusing to deploy: unknown TINYBIRD_DEPLOY_PHASE '$DEPLOY_PHASE'." >&2
    echo "Use expand, switch, or cleanup." >&2
    exit 1
    ;;
esac

if [[ "$TARGET_WORKSPACE" == "trace_flow_prod" ]]; then
  echo "PRODUCTION Tinybird deploy target: $TARGET_WORKSPACE (phase: $DEPLOY_PHASE)"
fi

if [[ "$TARGET_WORKSPACE" == "trace_flow_prod" && "$DEPLOY_PHASE" == "cleanup" ]]; then
  if [[ ! "${TINYBIRD_CLEANUP_APPROVED:-}" =~ ^trace_flow_prod_[0-9]{8}$ ]]; then
    echo "Refusing prod cleanup without TINYBIRD_CLEANUP_APPROVED=trace_flow_prod_YYYYMMDD." >&2
    exit 1
  fi
fi

ROOT_DIR="$(pwd)"
DEPLOY_DIR="$ROOT_DIR"
TMP_DIR=""

cleanup_tmp() {
  if [[ -n "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup_tmp EXIT

resolve_legacy_ref() {
  local candidate
  for candidate in "${TINYBIRD_LEGACY_REF:-}" origin/main HEAD^1 HEAD^; do
    [[ -n "$candidate" ]] || continue
    if git rev-parse --verify --quiet "$candidate^{tree}" >/dev/null; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

copy_current_project() {
  local dest="$1"
  mkdir -p "$dest"
  for path in tinybird.config.json datasources pipes materializations tests fixtures; do
    if [[ -e "$path" ]]; then
      cp -R "$path" "$dest/"
    fi
  done
}

restore_file_from_ref() {
  local ref="$1"
  local path="$2"
  local dest="$3"
  mkdir -p "$dest/$(dirname "$path")"
  git show "$ref:$path" > "$dest/$path"
}

is_scheduled_copy_pipe() {
  local ref="$1"
  local path="$2"
  [[ "$path" == pipes/* ]] || return 1
  git show "$ref:$path" | grep -q '^COPY_SCHEDULE'
}

should_restore_legacy_path() {
  local phase="$1"
  local ref="$2"
  local path="$3"

  if [[ "$phase" == "expand" && "$path" == pipes/* ]]; then
    return 0
  fi

  if [[ "$path" == datasources/* ]]; then
    [[ ! -e "$TMP_DIR/$path" ]]
    return
  fi

  if is_scheduled_copy_pipe "$ref" "$path"; then
    return 1
  fi

  [[ ! -e "$TMP_DIR/$path" ]]
}

prepare_phase_project() {
  local phase="$1"
  if [[ "$phase" == "cleanup" ]]; then
    return 0
  fi

  local legacy_ref
  if ! legacy_ref="$(resolve_legacy_ref)"; then
    echo "Refusing $phase deploy: could not resolve TINYBIRD_LEGACY_REF." >&2
    echo "Set TINYBIRD_LEGACY_REF to the commit/ref containing the live legacy Tinybird resources." >&2
    exit 1
  fi

  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/trace-flow-tinybird-${phase}.XXXXXX")"
  copy_current_project "$TMP_DIR"

  local restored=0
  local skipped=0
  while IFS= read -r path; do
    if should_restore_legacy_path "$phase" "$legacy_ref" "$path"; then
      restore_file_from_ref "$legacy_ref" "$path" "$TMP_DIR"
      restored=$((restored + 1))
      continue
    fi
    skipped=$((skipped + 1))
  done < <(git ls-tree -r --name-only "$legacy_ref" -- datasources pipes)

  DEPLOY_DIR="$TMP_DIR"
  echo "Prepared Tinybird $phase deploy tree from $legacy_ref ($restored legacy files restored, $skipped skipped)."
}

prepare_phase_project "$DEPLOY_PHASE"

if [[ -z "${TB_TOKEN:-}" && -f "$ROOT_DIR/.tinyb" ]]; then
  export TB_TOKEN
  TB_TOKEN="$(jq -r '.token' "$ROOT_DIR/.tinyb")"
  if [[ -z "${TB_HOST:-}" ]]; then
    export TB_HOST
    TB_HOST="$(jq -r '.host' "$ROOT_DIR/.tinyb")"
  fi
fi

# `tb build` validates offline but honours dev_mode=local in tinybird.config.json, so it needs a
# running Tinybird Local container. CI's PR gate provides one (ci.yml `tinybird-local` service) and
# runs the offline build there. The prod deploy job has no container — and doesn't need one: the
# authoritative cloud validation is `tb --cloud deploy --check` below, which runs against the real
# workspace right before the apply. So deploy.yml sets TB_SKIP_BUILD=1 to skip the local-only build.
cd "$DEPLOY_DIR"
if [[ "${TB_SKIP_BUILD:-}" == "1" ]]; then
  echo "Skipping offline tb build (TB_SKIP_BUILD=1); cloud deploy --check is the validation."
else
  echo "Validating schema offline (tb build) ..."
  tb build
fi

declare -a ALLOW_DESTRUCTIVE_ARGS=()
if [[ "$DEPLOY_PHASE" == "cleanup" ]]; then
  ALLOW_DESTRUCTIVE_ARGS=(--allow-destructive-operations)
fi

echo "Validating $DEPLOY_PHASE deployment against $TARGET_WORKSPACE ..."
if [[ "${#ALLOW_DESTRUCTIVE_ARGS[@]}" -gt 0 ]]; then
  tb --cloud deploy --check "${ALLOW_DESTRUCTIVE_ARGS[@]}"
else
  tb --cloud deploy --check
fi

if [[ "$CHECK_ONLY" == "1" ]]; then
  echo "Validate-only run; skipping deploy."
  exit 0
fi

echo "Deploying $DEPLOY_PHASE schema to $TARGET_WORKSPACE ..."
if [[ "${#ALLOW_DESTRUCTIVE_ARGS[@]}" -gt 0 ]]; then
  tb --cloud deploy "${ALLOW_DESTRUCTIVE_ARGS[@]}"
else
  tb --cloud deploy
fi
