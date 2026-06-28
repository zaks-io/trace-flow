#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

TRACE_FLOW_DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRACE_FLOW_ROOT="$(cd "$TRACE_FLOW_DEV_DIR/../.." && pwd)"
TRACE_FLOW_STATE_DIR="${TRACE_FLOW_STATE_DIR:-$TRACE_FLOW_ROOT/.trace-flow}"
TRACE_FLOW_DEV_ENV="${TRACE_FLOW_DEV_ENV:-$TRACE_FLOW_STATE_DIR/dev.env}"
TRACE_FLOW_TINYBIRD_HOST="${TRACE_FLOW_TINYBIRD_HOST:-http://127.0.0.1:7181}"
TRACE_FLOW_CONVEX_URL="${TRACE_FLOW_CONVEX_URL:-http://127.0.0.1:3210}"
TRACE_FLOW_CONVEX_SITE_URL="${TRACE_FLOW_CONVEX_SITE_URL:-http://127.0.0.1:3211}"
TRACE_FLOW_WEB_URL="${TRACE_FLOW_WEB_URL:-http://127.0.0.1:3000}"
TRACE_FLOW_API_URL="${TRACE_FLOW_API_URL:-http://127.0.0.1:8787}"
TRACE_FLOW_BODY_ENCRYPTION_ROOT_KEY="${TRACE_FLOW_BODY_ENCRYPTION_ROOT_KEY:-MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=}"
TRACE_FLOW_BODY_ACCESS_JWT_SECRET="${TRACE_FLOW_BODY_ACCESS_JWT_SECRET:-local-body-access-secret-at-least-32-characters}"
TRACE_FLOW_USAGE_SYNC_SECRET="${TRACE_FLOW_USAGE_SYNC_SECRET:-local-usage-sync-secret}"
TRACE_FLOW_AGENT_INGEST_SHARED_SECRET="${TRACE_FLOW_AGENT_INGEST_SHARED_SECRET:-local-agent-ingest-shared-secret}"
TRACE_FLOW_AUTH0_SECRET="${TRACE_FLOW_AUTH0_SECRET:-test-secret-at-least-32-characters-long}"

log() {
  printf '[trace-flow-dev] %s\n' "$*"
}

warn() {
  printf '[trace-flow-dev] warning: %s\n' "$*" >&2
}

fail() {
  printf '[trace-flow-dev] error: %s\n' "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  command_exists "$1" || fail "missing required command: $1"
}

ensure_state_dir() {
  mkdir -p "$TRACE_FLOW_STATE_DIR"
}

source_dev_env() {
  if [[ -f "$TRACE_FLOW_DEV_ENV" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$TRACE_FLOW_DEV_ENV"
    set +a
  fi
}

write_runtime_file() {
  local path="$1"
  if [[ -f "$path" && "${TRACE_FLOW_OVERWRITE_LOCAL_ENV:-0}" != "1" ]]; then
    log "keeping existing ${path#$TRACE_FLOW_ROOT/}"
    return 0
  fi

  mkdir -p "$(dirname "$path")"
  cat >"$path"
  log "wrote ${path#$TRACE_FLOW_ROOT/}"
}

sync_runtime_env_var() {
  local path="$1"
  local key="$2"
  local value="$3"

  [[ -f "$path" ]] || return 0

  local tmp
  tmp="$(mktemp "${path}.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    $0 ~ "^" key "=" {
      print key "=" value
      done = 1
      next
    }
    { print }
    END {
      if (done == 0) print key "=" value
    }
  ' "$path" >"$tmp"

  chmod --reference="$path" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  mv "$tmp" "$path"
}

json_field() {
  local field="$1"
  json_expr "data['$field'] ?? ''"
}

json_expr() {
  local expr="$1"
  if command_exists node; then
    node -e "const fs = require('node:fs'); const data = JSON.parse(fs.readFileSync(0, 'utf8')); process.stdout.write(String($expr));"
  elif command_exists bun; then
    bun -e "const data = JSON.parse(await Bun.stdin.text()); process.stdout.write(String($expr));"
  else
    fail "node or bun is required to parse JSON"
  fi
}
