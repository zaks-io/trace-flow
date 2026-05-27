#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$TRACE_FLOW_ROOT"

if [[ "${TRACE_FLOW_SMOKE_SKIP_SETUP:-0}" != "1" ]]; then
  "$TRACE_FLOW_DEV_DIR/start.sh"
fi

source_dev_env

require_command node
require_command bun
require_command tb

export TRACE_FLOW_ROOT
export TRACE_FLOW_DEV_DIR
export TRACE_FLOW_STATE_DIR
export TRACE_FLOW_DEV_ENV
export TRACE_FLOW_TINYBIRD_HOST
export TB_LOCAL_WORKSPACE_TOKEN="${TB_LOCAL_WORKSPACE_TOKEN:-}"

node "$TRACE_FLOW_DEV_DIR/smoke.mjs" "$@"
