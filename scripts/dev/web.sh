#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
source_dev_env

cd "$TRACE_FLOW_ROOT"
exec bun run dev:web
