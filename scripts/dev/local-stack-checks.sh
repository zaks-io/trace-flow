#!/usr/bin/env bash
# Source after local-stack.sh has resolved this checkout's URLs and state.

cmd_doctor() {
  local name missing=0
  for name in bun node tb docker curl setsid sha256sum; do
    if command_exists "$name"; then
      printf 'ok   %s\n' "$name"
    else
      printf 'miss %s\n' "$name"
      missing=1
    fi
  done
  if command_exists docker && docker info >/dev/null 2>&1; then
    printf 'ok   docker daemon\n'
  else
    printf 'miss docker daemon\n'
    missing=1
  fi
  if command_exists docker && docker compose version >/dev/null 2>&1; then
    printf 'ok   docker compose v2\n'
  else
    printf 'miss docker compose v2\n'
    missing=1
  fi
  printf 'State: %s\n' "$STACK_DIR"
  return "$missing"
}

require_running_stack() {
  [[ -f "$STACK_SECRETS" ]] || fail "local stack is not prepared; run scripts/dev/local-stack.sh up"
  tinybird_local_running || fail "Tinybird Local is not running; run scripts/dev/local-stack.sh up"
  resolve_tinybird_project_workspace
}

cmd_smoke() {
  require_running_stack
  # Read existing secrets without generating or changing stack state.
  set -a
  # shellcheck disable=SC1090
  source "$STACK_SECRETS"
  set +a
  TRACE_FLOW_TINYBIRD_HOST="$TRACE_FLOW_TINYBIRD_HOST" \
    TINYBIRD_WORKSPACE_TOKEN="$TINYBIRD_WORKSPACE_TOKEN" \
    STACK_PROXY_URL="http://127.0.0.1:$PROXY_PORT" \
    STACK_KV_BRIDGE_URL="http://127.0.0.1:$KV_BRIDGE_PORT" \
    STACK_API_KEYS_KV_ID="$API_KEYS_KV_ID" \
    node "$TRACE_FLOW_DEV_DIR/local-stack-smoke.mjs" "$@"
}

cmd_verify() {
  local mode="$1"
  [[ "$mode" == quick || "$mode" == full ]] || fail "usage: local-stack.sh verify [full]"
  require_running_stack
  cd "$TRACE_FLOW_ROOT" || return
  # Tinybird reads the instance's local token from the environment, not CLI arguments.
  tinybird_cli build
  tinybird_cli test run
  bun run type-check
  bun run test
  if [[ "$mode" == full ]]; then
    bun run lint
    bun run build
  fi
}
