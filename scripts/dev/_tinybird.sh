#!/usr/bin/env bash
# Tinybird Local helpers for the disposable local stack.
# Source after _common.sh.
TRACE_FLOW_TINYBIRD_CONTAINER="${TRACE_FLOW_TINYBIRD_CONTAINER:-tinybird-local}"
TRACE_FLOW_TINYBIRD_PROJECT="${TRACE_FLOW_TINYBIRD_PROJECT:-trace-flow-tinybird}"

# `tb local status` exits 0 even when the container is down, so probe the API instead.
tinybird_local_running() {
  curl -s -o /dev/null --max-time 2 "$TRACE_FLOW_TINYBIRD_HOST/"
}

ensure_tinybird_tokens() {
  ensure_state_dir
  if [[ -f "$STACK_TINYBIRD_ENV" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$STACK_TINYBIRD_ENV"
    set +a
  fi
  if [[ -n "${TB_LOCAL_USER_TOKEN:-}" && -n "${TB_LOCAL_WORKSPACE_TOKEN:-}" ]]; then
    return 0
  fi
  require_command tb
  local tokens user_token workspace_token
  tokens="$(TB_VERSION_WARNING=0 tb --output=json local generate-tokens)"
  user_token="$(printf '%s' "$tokens" | json_field user_token)"
  workspace_token="$(printf '%s' "$tokens" | json_field workspace_token)"
  [[ -n "$user_token" && -n "$workspace_token" ]] || fail "Tinybird did not return local tokens"
  umask 077
  printf 'TB_LOCAL_USER_TOKEN=%s\nTB_LOCAL_WORKSPACE_TOKEN=%s\n' "$user_token" "$workspace_token" >"$STACK_TINYBIRD_ENV"
  set -a
  # shellcheck disable=SC1090
  source "$STACK_TINYBIRD_ENV"
  set +a
}

ensure_tinybird_local_container() {
  local volumes_path="$TRACE_FLOW_STATE_DIR/tinybird"
  local project data_mount running
  if project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$TRACE_FLOW_TINYBIRD_CONTAINER" 2>/dev/null)"; then
    data_mount="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/clickhouse"}}{{.Source}}{{end}}{{end}}' "$TRACE_FLOW_TINYBIRD_CONTAINER")"
    running="$(docker inspect -f '{{.State.Running}}' "$TRACE_FLOW_TINYBIRD_CONTAINER")"

    if [[ "$project" == "$TRACE_FLOW_TINYBIRD_PROJECT" && "$running" == "true" ]]; then
      log "Tinybird Local is already running"
      return 0
    fi

    if [[ "$project" != "$TRACE_FLOW_TINYBIRD_PROJECT" ]]; then
      if [[ "$data_mount" == "$volumes_path/data" ]]; then
        # `tb local start` created it without limits; its data persists in the volumes path.
        log "replacing Tinybird Local container that has no memory limit"
        docker stop "$TRACE_FLOW_TINYBIRD_CONTAINER" >/dev/null
        docker rm "$TRACE_FLOW_TINYBIRD_CONTAINER" >/dev/null
      elif [[ "$running" == "true" ]]; then
        warn "Tinybird Local was started outside scripts/dev and has no memory limit"
        return 0
      else
        fail "a stopped tinybird-local container from outside scripts/dev is in the way; remove it from its owning checkout first"
      fi
    fi
  fi

  log "starting Tinybird Local (memory limit ${TRACE_FLOW_TINYBIRD_MEMORY:-3g})"
  TRACE_FLOW_TINYBIRD_VOLUMES="$volumes_path" docker compose \
    --file "$TRACE_FLOW_DEV_DIR/tinybird-local.compose.yml" \
    up --detach --wait --wait-timeout 600
}

start_tinybird_local() {
  require_command tb
  ensure_tinybird_tokens
  docker info >/dev/null 2>&1 || fail "Docker is not running"
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required for Tinybird Local"
  ensure_tinybird_local_container
}

# Tinybird CLI prefers .tinyb's workspace name over an explicit token. Keep its
# writable config private, so an existing cloud selection cannot redirect local deploys.
tinybird_cli() {
  local cli_dir="$STACK_DIR/tinybird-cli"
  mkdir -p "$cli_dir"
  chmod 700 "$cli_dir"
  node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({name: "Tinybird_Local_Testing", cwd: process.argv[2]}), {mode: 0o600})' \
    "$cli_dir/.tinyb" "$TRACE_FLOW_ROOT"
  (cd "$cli_dir" && TB_VERSION_WARNING=0 TB_HOST="$TRACE_FLOW_TINYBIRD_HOST" \
    TB_TOKEN="$TINYBIRD_WORKSPACE_TOKEN" tb --local "$@")
}
