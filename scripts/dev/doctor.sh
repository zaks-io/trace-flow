#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

check_command() {
  local name="$1"
  if command_exists "$name"; then
    printf 'ok   %s (%s)\n' "$name" "$(command -v "$name")"
  else
    printf 'miss %s\n' "$name"
  fi
}

cd "$TRACE_FLOW_ROOT"

check_command bun
check_command node
check_command tb
check_command docker

if command_exists docker && docker info >/dev/null 2>&1; then
  printf 'ok   docker daemon\n'
else
  printf 'miss docker daemon\n'
fi

if [[ -f "$TRACE_FLOW_DEV_ENV" ]]; then
  printf 'ok   %s\n' "${TRACE_FLOW_DEV_ENV#$TRACE_FLOW_ROOT/}"
else
  printf 'miss %s\n' "${TRACE_FLOW_DEV_ENV#$TRACE_FLOW_ROOT/}"
fi

for path in \
  apps/proxy/.dev.vars \
  apps/proxy-consumer/.dev.vars \
  apps/api/.dev.vars \
  apps/pipes-api/.dev.vars \
  apps/agent-ingest/.dev.vars \
  apps/agent-consumer/.dev.vars \
  apps/web/.env.local
do
  if [[ -f "$path" ]]; then
    printf 'ok   %s\n' "$path"
  else
    printf 'miss %s\n' "$path"
  fi
done
