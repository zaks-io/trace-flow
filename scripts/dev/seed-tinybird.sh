#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$TRACE_FLOW_ROOT"
require_command tb

if [[ "${TRACE_FLOW_SKIP_TINYBIRD:-0}" == "1" ]]; then
  fail "TRACE_FLOW_SKIP_TINYBIRD=1 is set; cannot seed Tinybird"
fi

TB_VERSION_WARNING=0 tb local status >/dev/null 2>&1 || "$TRACE_FLOW_DEV_DIR/start.sh"

for fixture in fixtures/agent_message_facts.ndjson \
  fixtures/agent_tool_event_facts.ndjson \
  fixtures/agent_file_event_facts.ndjson \
  fixtures/agent_pull_request_facts.ndjson \
  fixtures/agent_capability_snapshot_facts.ndjson
do
  if [[ -f "$fixture" ]]; then
    datasource="$(basename "$fixture" .ndjson)"
    log "replacing $datasource from $fixture"
    TB_VERSION_WARNING=0 tb datasource replace "$datasource" "$fixture"
  fi
done

log "Tinybird fixtures seeded"
