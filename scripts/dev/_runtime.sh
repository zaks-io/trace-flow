#!/usr/bin/env bash
# Source after _common.sh. Sandbox allocations cover the complete local stack.
if command_exists sbx-runtime; then
  runtime_services=(web proxy pipes raw-api agent-ingest kv-bridge convex convex-site oidc
    workers-inspector pipes-inspector raw-api-inspector agent-ingest-inspector kv-bridge-inspector
    tinybird tinybird-clickhouse)
  runtime_specs=()
  for runtime_service in "${runtime_services[@]}"; do
    runtime_key="TRACE_FLOW_LOCAL_STACK_${runtime_service^^}_PORT"
    runtime_key="${runtime_key//-/_}"
    runtime_specs+=("$runtime_service${!runtime_key:+="${!runtime_key}"}")
  done
  runtime_env="$(sbx-runtime allocate --worktree "$TRACE_FLOW_ROOT" --format shell "${runtime_specs[@]}")"
  eval "$runtime_env"
  for runtime_service in "${runtime_services[@]}"; do
    runtime_key="TRACE_FLOW_LOCAL_STACK_${runtime_service^^}_PORT"
    runtime_key="${runtime_key//-/_}"
    runtime_allocated="SBX_PORT_${runtime_service^^}"
    runtime_allocated="${runtime_allocated//-/_}"
    export "$runtime_key=${!runtime_allocated}"
  done
  if [[ "$TRACE_FLOW_STATE_DIR" == "$TRACE_FLOW_ROOT/.trace-flow" ]]; then
    TRACE_FLOW_STATE_DIR="$SBX_STATE_DIR/trace-flow"
  fi
  export TRACE_FLOW_TINYBIRD_CONTAINER="trace-flow-tinybird-$SBX_WORKTREE_ID"
  export TRACE_FLOW_TINYBIRD_PROJECT="trace-flow-tinybird-$SBX_WORKTREE_ID"
  export TB_LOCAL_PORT="$SBX_PORT_TINYBIRD"
  export TB_LOCAL_CLICKHOUSE_INTERFACE_PORT="$SBX_PORT_TINYBIRD_CLICKHOUSE"
  export TRACE_FLOW_TINYBIRD_HOST="http://127.0.0.1:$TB_LOCAL_PORT"
  unset runtime_services runtime_specs runtime_service runtime_key runtime_allocated runtime_env
fi

# Standalone machines retain explicit/default ports and checkout-local state.
# Docker resources still need checkout ownership when the sandbox helper is absent.
STACK_RUNTIME_ID="${SBX_WORKTREE_ID:-$(printf '%s' "$TRACE_FLOW_ROOT" | sha256sum | cut -c1-12)}"
export TRACE_FLOW_TINYBIRD_CONTAINER="${TRACE_FLOW_TINYBIRD_CONTAINER:-trace-flow-tinybird-$STACK_RUNTIME_ID}"
export TRACE_FLOW_TINYBIRD_PROJECT="${TRACE_FLOW_TINYBIRD_PROJECT:-trace-flow-tinybird-$STACK_RUNTIME_ID}"
export TB_LOCAL_PORT="${TRACE_FLOW_LOCAL_STACK_TINYBIRD_PORT:-7181}"
export TB_LOCAL_CLICKHOUSE_INTERFACE_PORT="${TRACE_FLOW_LOCAL_STACK_TINYBIRD_CLICKHOUSE_PORT:-7182}"
export TRACE_FLOW_TINYBIRD_HOST="http://127.0.0.1:$TB_LOCAL_PORT"
export TB_LOCAL_HOST=127.0.0.1
if [[ -n "${STACK_REQUESTED_TINYBIRD_HOST:-}" && "$STACK_REQUESTED_TINYBIRD_HOST" != "$TRACE_FLOW_TINYBIRD_HOST" ]]; then
  fail "the self-contained stack uses its local Tinybird instance; set TRACE_FLOW_LOCAL_STACK_TINYBIRD_PORT instead of TRACE_FLOW_TINYBIRD_HOST"
fi
