#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

start_docker_if_possible() {
  if ! command_exists docker; then
    warn "docker is unavailable; skipping Tinybird Local startup"
    return 1
  fi

  if docker info >/dev/null 2>&1; then
    return 0
  fi

  if command_exists sudo && command_exists service; then
    log "starting Docker service"
    sudo service docker start >/dev/null 2>&1 || true
  fi

  docker info >/dev/null 2>&1
}

ensure_tinybird_tokens() {
  ensure_state_dir
  if [[ -f "$TRACE_FLOW_DEV_ENV" ]]; then
    source_dev_env
  fi

  if [[ "${TRACE_FLOW_SKIP_TINYBIRD:-0}" == "1" ]]; then
    TB_LOCAL_USER_TOKEN="${TB_LOCAL_USER_TOKEN:-local-tinybird-user-token}"
    TB_LOCAL_WORKSPACE_TOKEN="${TB_LOCAL_WORKSPACE_TOKEN:-local-tinybird-workspace-token}"
    write_dev_env "$TB_LOCAL_USER_TOKEN" "$TB_LOCAL_WORKSPACE_TOKEN"
    source_dev_env
    return 0
  fi

  require_command tb

  local current_info
  if current_info="$(TB_VERSION_WARNING=0 tb --output=json info 2>/dev/null)"; then
    local current_user_token
    local current_workspace_token
    local current_api
    current_user_token="$(printf '%s' "$current_info" | json_expr "data.local?.user_token ?? ''")"
    current_workspace_token="$(printf '%s' "$current_info" | json_expr "data.local?.token ?? ''")"
    current_api="$(printf '%s' "$current_info" | json_expr "data.local?.api ?? ''")"

    if [[ -n "$current_user_token" && -n "$current_workspace_token" ]]; then
      TRACE_FLOW_TINYBIRD_HOST="${current_api:-$TRACE_FLOW_TINYBIRD_HOST}"
      write_dev_env "$current_user_token" "$current_workspace_token"
      source_dev_env
      return 0
    fi
  fi

  if [[ -n "${TB_LOCAL_USER_TOKEN:-}" && -n "${TB_LOCAL_WORKSPACE_TOKEN:-}" ]]; then
    return 0
  fi

  log "generating Tinybird Local tokens"
  local tokens
  tokens="$(TB_VERSION_WARNING=0 tb --output=json local generate-tokens)"
  local user_token
  local workspace_token
  user_token="$(printf '%s' "$tokens" | json_field user_token)"
  workspace_token="$(printf '%s' "$tokens" | json_field workspace_token)"

  [[ -n "$user_token" ]] || fail "Tinybird did not return a user token"
  [[ -n "$workspace_token" ]] || fail "Tinybird did not return a workspace token"

  write_dev_env "$user_token" "$workspace_token"
  source_dev_env
}

write_dev_env() {
  local user_token="$1"
  local workspace_token="$2"

  cat >"$TRACE_FLOW_DEV_ENV" <<EOF
TB_LOCAL_USER_TOKEN=$user_token
TB_LOCAL_WORKSPACE_TOKEN=$workspace_token
TRACE_FLOW_TINYBIRD_HOST=$TRACE_FLOW_TINYBIRD_HOST
TRACE_FLOW_CONVEX_URL=$TRACE_FLOW_CONVEX_URL
TRACE_FLOW_CONVEX_SITE_URL=$TRACE_FLOW_CONVEX_SITE_URL
TRACE_FLOW_BODY_ENCRYPTION_ROOT_KEY=$TRACE_FLOW_BODY_ENCRYPTION_ROOT_KEY
TRACE_FLOW_USAGE_SYNC_SECRET=$TRACE_FLOW_USAGE_SYNC_SECRET
TRACE_FLOW_AGENT_INGEST_SHARED_SECRET=$TRACE_FLOW_AGENT_INGEST_SHARED_SECRET
EOF
  chmod 600 "$TRACE_FLOW_DEV_ENV"
}

start_tinybird_local() {
  if [[ "${TRACE_FLOW_SKIP_TINYBIRD:-0}" == "1" ]]; then
    log "skipping Tinybird Local"
    return 0
  fi

  require_command tb
  ensure_tinybird_tokens

  if ! start_docker_if_possible; then
    fail "Docker is not running; set TRACE_FLOW_SKIP_TINYBIRD=1 to skip Tinybird Local"
  fi

  if TB_VERSION_WARNING=0 tb local status >/dev/null 2>&1; then
    log "Tinybird Local is already running"
  else
    log "starting Tinybird Local"
    TB_VERSION_WARNING=0 tb local start \
      --daemon \
      --volumes-path "$TRACE_FLOW_STATE_DIR/tinybird" \
      --user-token "$TB_LOCAL_USER_TOKEN" \
      --workspace-token "$TB_LOCAL_WORKSPACE_TOKEN"
  fi

  if [[ "${TRACE_FLOW_SKIP_TB_BUILD:-0}" != "1" ]]; then
    log "building Tinybird project against local Tinybird"
    TB_VERSION_WARNING=0 tb build
  fi
}

write_local_runtime_files() {
  ensure_tinybird_tokens

  write_runtime_file "$TRACE_FLOW_ROOT/apps/proxy/.dev.vars" <<EOF
CONVEX_SITE_URL=$TRACE_FLOW_CONVEX_SITE_URL
USAGE_SYNC_SECRET=$TRACE_FLOW_USAGE_SYNC_SECRET
BODY_ENCRYPTION_ROOT_KEY=$TRACE_FLOW_BODY_ENCRYPTION_ROOT_KEY
BODY_ENCRYPTION_KEY_ID=v1
AXIOM_TOKEN=
SENTRY_DSN=
EOF

  write_runtime_file "$TRACE_FLOW_ROOT/apps/proxy-consumer/.dev.vars" <<EOF
TINYBIRD_TOKEN=$TB_LOCAL_WORKSPACE_TOKEN
TINYBIRD_DATASOURCE=otel_trace_spans
TINYBIRD_HOST=$TRACE_FLOW_TINYBIRD_HOST
AXIOM_TOKEN=
SENTRY_DSN=
EOF

  write_runtime_file "$TRACE_FLOW_ROOT/apps/api/.dev.vars" <<EOF
TINYBIRD_ADMIN_TOKEN=$TB_LOCAL_WORKSPACE_TOKEN
TINYBIRD_API_URL=$TRACE_FLOW_TINYBIRD_HOST
BODY_ENCRYPTION_ROOT_KEY=$TRACE_FLOW_BODY_ENCRYPTION_ROOT_KEY
BODY_ENCRYPTION_KEY_ID=v1
AUTH0_DOMAIN=test.auth0.com
AUTH0_CLIENT_ID=test-client-id
AXIOM_TOKEN=
SENTRY_DSN=
EOF

  write_runtime_file "$TRACE_FLOW_ROOT/apps/agent-ingest/.dev.vars" <<EOF
CONVEX_SITE_URL=$TRACE_FLOW_CONVEX_SITE_URL
AGENT_INGEST_SHARED_SECRET=$TRACE_FLOW_AGENT_INGEST_SHARED_SECRET
SENTRY_DSN=
EOF

  write_runtime_file "$TRACE_FLOW_ROOT/apps/agent-consumer/.dev.vars" <<EOF
TINYBIRD_TOKEN=$TB_LOCAL_WORKSPACE_TOKEN
TINYBIRD_HOST=$TRACE_FLOW_TINYBIRD_HOST
SENTRY_DSN=
EOF

  write_runtime_file "$TRACE_FLOW_ROOT/apps/web/.env.local" <<EOF
NEXT_PUBLIC_CONVEX_URL=$TRACE_FLOW_CONVEX_URL
NEXT_PUBLIC_API_URL=$TRACE_FLOW_API_URL
NEXT_PUBLIC_TINYBIRD_API_URL=$TRACE_FLOW_TINYBIRD_HOST
NEXT_PUBLIC_AUTH0_DOMAIN=test.auth0.com
NEXT_PUBLIC_AUTH0_CLIENT_ID=test-client-id
AUTH0_SECRET=$TRACE_FLOW_AUTH0_SECRET
AUTH0_CLIENT_SECRET=test-client-secret
APP_BASE_URL=$TRACE_FLOW_WEB_URL
EOF

  if [[ "${TRACE_FLOW_SKIP_TINYBIRD:-0}" != "1" ]]; then
    sync_tinybird_runtime_vars
  fi
}

sync_tinybird_runtime_vars() {
  sync_runtime_env_var "$TRACE_FLOW_ROOT/apps/proxy-consumer/.dev.vars" \
    TINYBIRD_TOKEN "$TB_LOCAL_WORKSPACE_TOKEN"
  sync_runtime_env_var "$TRACE_FLOW_ROOT/apps/proxy-consumer/.dev.vars" \
    TINYBIRD_HOST "$TRACE_FLOW_TINYBIRD_HOST"

  sync_runtime_env_var "$TRACE_FLOW_ROOT/apps/api/.dev.vars" \
    TINYBIRD_ADMIN_TOKEN "$TB_LOCAL_WORKSPACE_TOKEN"
  sync_runtime_env_var "$TRACE_FLOW_ROOT/apps/api/.dev.vars" \
    TINYBIRD_API_URL "$TRACE_FLOW_TINYBIRD_HOST"

  sync_runtime_env_var "$TRACE_FLOW_ROOT/apps/agent-consumer/.dev.vars" \
    TINYBIRD_TOKEN "$TB_LOCAL_WORKSPACE_TOKEN"
  sync_runtime_env_var "$TRACE_FLOW_ROOT/apps/agent-consumer/.dev.vars" \
    TINYBIRD_HOST "$TRACE_FLOW_TINYBIRD_HOST"

  sync_runtime_env_var "$TRACE_FLOW_ROOT/apps/web/.env.local" \
    NEXT_PUBLIC_TINYBIRD_API_URL "$TRACE_FLOW_TINYBIRD_HOST"
}

cd "$TRACE_FLOW_ROOT"
write_local_runtime_files
start_tinybird_local

log "local environment is prepared"
log "run scripts/dev/convex.sh, scripts/dev/workers.sh, and scripts/dev/web.sh in separate terminals"
