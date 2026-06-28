#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
source_dev_env

cd "$TRACE_FLOW_ROOT"

export BODY_ACCESS_JWT_SECRET="${BODY_ACCESS_JWT_SECRET:-$TRACE_FLOW_BODY_ACCESS_JWT_SECRET}"

if [[ "${TRACE_FLOW_CONVEX_DEPLOYMENT:-local}" == "local" ]]; then
  log "selecting Convex local deployment"
  bunx convex deployment select local || warn "could not select local Convex deployment; continuing with current Convex selection"
fi

exec bunx convex dev
