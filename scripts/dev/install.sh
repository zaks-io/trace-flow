#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

install_bun() {
  if [[ "${TRACE_FLOW_AUTO_INSTALL_TOOLS:-0}" != "1" ]]; then
    fail "bun is not installed. Install Bun or rerun with TRACE_FLOW_AUTO_INSTALL_TOOLS=1."
  fi

  log "installing Bun"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
}

install_tinybird_cli() {
  if [[ "${TRACE_FLOW_AUTO_INSTALL_TOOLS:-0}" != "1" ]]; then
    fail "Tinybird CLI is not installed. Install tb or rerun with TRACE_FLOW_AUTO_INSTALL_TOOLS=1."
  fi

  log "installing Tinybird CLI"
  curl -fsSL https://tinybird.co | sh
  export PATH="$HOME/.local/bin:$PATH"
}

command_exists bun || install_bun
command_exists tb || install_tinybird_cli

require_command bun
require_command tb

if ! command_exists node; then
  warn "node is not installed; some Convex and Next.js commands may require Node 24"
fi

if ! command_exists docker; then
  warn "docker is not installed; Tinybird Local will not start until Docker is available"
fi

cd "$TRACE_FLOW_ROOT"
log "installing workspace dependencies"
bun install --frozen-lockfile

log "install complete"
