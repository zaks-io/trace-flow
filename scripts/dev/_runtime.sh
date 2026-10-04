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
    TRACE_FLOW_DEV_ENV="$TRACE_FLOW_STATE_DIR/dev.env"
  fi
  export TRACE_FLOW_TINYBIRD_CONTAINER="trace-flow-tinybird-$SBX_WORKTREE_ID"
  export TRACE_FLOW_TINYBIRD_PROJECT="trace-flow-tinybird-$SBX_WORKTREE_ID"
  export TB_LOCAL_PORT="$SBX_PORT_TINYBIRD"
  export TB_LOCAL_CLICKHOUSE_INTERFACE_PORT="$SBX_PORT_TINYBIRD_CLICKHOUSE"
  TRACE_FLOW_TINYBIRD_HOST="http://127.0.0.1:$TB_LOCAL_PORT"
  unset runtime_services runtime_specs runtime_service runtime_key runtime_allocated runtime_env
fi
