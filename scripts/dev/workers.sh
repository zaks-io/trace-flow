#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
source_dev_env

cd "$TRACE_FLOW_ROOT"

args=(
  dev
  -c apps/proxy/wrangler.toml
  -c apps/proxy-consumer/wrangler.toml
  -c apps/api/wrangler.toml
  -c apps/pipes-api/wrangler.toml
  -c apps/agent-ingest/wrangler.jsonc
  -c apps/agent-consumer/wrangler.jsonc
  --persist-to .wrangler/state
)

if [[ -n "${TRACE_FLOW_WORKERS_ENV_FILE:-}" ]]; then
  args+=(--env-file "$TRACE_FLOW_WORKERS_ENV_FILE")
fi

exec bunx wrangler "${args[@]}"
