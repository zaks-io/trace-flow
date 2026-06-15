#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

mode="${1:-quick}"
cd "$TRACE_FLOW_ROOT"

if [[ "${TRACE_FLOW_VERIFY_SKIP_START:-0}" != "1" ]]; then
  TRACE_FLOW_SKIP_TB_BUILD=1 "$TRACE_FLOW_DEV_DIR/start.sh"
fi

if [[ "${TRACE_FLOW_SKIP_TINYBIRD:-0}" != "1" ]]; then
  require_command tb
  log "validating Tinybird project"
  export_tinybird_sdk_env
  TB_VERSION_WARNING=0 tb build
  TB_VERSION_WARNING=0 tb test run
fi

log "running TypeScript checks"
bun run type-check

log "running tests"
bun run test

if [[ "$mode" == "full" ]]; then
  log "running lint"
  bun run lint

  log "running build"
  bun run build
fi

log "verification complete ($mode)"
