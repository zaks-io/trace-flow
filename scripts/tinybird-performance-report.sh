#!/usr/bin/env bash
# Read-only Tinybird/ClickHouse performance snapshot for rollup CPU, endpoint CPU, insert pressure,
# and active MergeTree parts. Defaults to the authenticated Tinybird Cloud workspace.
set -euo pipefail

HOURS="${1:-24}"
if [[ ! "$HOURS" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 [hours]" >&2
  exit 2
fi

export CI="${CI:-1}"
export TB_VERSION_WARNING="${TB_VERSION_WARNING:-0}"

TB_SCOPE=("--cloud")
ROWS_LIMIT="${ROWS_LIMIT:-20}"

run_query() {
  local title="$1"
  local query="$2"

  echo
  echo "=== $title ==="
  if ! tb "${TB_SCOPE[@]}" sql --rows-limit "$ROWS_LIMIT" "$query"; then
    echo "WARN: query failed: $title" >&2
  fi
}

run_query "Datasource operations by CPU (${HOURS}h)" "
SELECT
    datasource_name,
    pipe_name,
    event_type,
    count() AS ops,
    round(sum(cpu_time), 3) AS cpu_seconds,
    sum(read_rows) AS read_rows,
    sum(read_bytes) AS read_bytes,
    sum(written_rows) AS written_rows,
    sum(written_bytes) AS written_bytes,
    round(quantile(0.95)(elapsed_time), 3) AS p95_elapsed_seconds
FROM organization.datasources_ops_log
WHERE timestamp >= now() - INTERVAL ${HOURS} HOUR
GROUP BY datasource_name, pipe_name, event_type
ORDER BY cpu_seconds DESC
LIMIT ${ROWS_LIMIT}
"

run_query "Endpoint pipes by CPU (${HOURS}h)" "
SELECT
    pipe_name,
    count() AS requests,
    round(sum(cpu_time), 3) AS cpu_seconds,
    sum(read_rows) AS read_rows,
    sum(read_bytes) AS read_bytes,
    sum(result_rows) AS result_rows,
    round(quantile(0.50)(duration), 3) AS p50_duration_seconds,
    round(quantile(0.95)(duration), 3) AS p95_duration_seconds,
    sum(error) AS errors
FROM organization.pipe_stats_rt
WHERE start_datetime >= now() - INTERVAL ${HOURS} HOUR
GROUP BY pipe_name
ORDER BY cpu_seconds DESC
LIMIT ${ROWS_LIMIT}
"

run_query "Insert/write pressure (${HOURS}h)" "
SELECT
    datasource_name,
    event_type,
    count() AS ops,
    sum(written_rows) AS rows_written,
    sum(written_bytes) AS bytes_written,
    round(sum(cpu_time), 3) AS cpu_seconds,
    round(quantile(0.95)(elapsed_time), 3) AS p95_elapsed_seconds
FROM organization.datasources_ops_log AS ops
WHERE timestamp >= now() - INTERVAL ${HOURS} HOUR
    AND ops.written_rows > 0
GROUP BY datasource_name, event_type
ORDER BY rows_written DESC
LIMIT ${ROWS_LIMIT}
"

run_query "Active MergeTree parts" "
SELECT
    table,
    countIf(active = 1) AS active_parts,
    countIf(active = 1 AND level = 0) AS fresh_parts,
    sumIf(rows, active = 1) AS active_rows,
    sumIf(bytes_on_disk, active = 1) AS active_bytes,
    maxIf(modification_time, active = 1) AS newest_part_at
FROM system.parts
WHERE table IN (
    'otel_trace_spans',
    'otel_genai_spans',
    'llm_request_facts',
    'llm_usage_hourly',
    'llm_usage_daily',
    'llm_usage_monthly',
    'agent_message_facts',
    'agent_tool_event_facts',
    'agent_file_event_facts',
    'agent_capability_snapshot_facts',
    'agent_pull_request_facts',
    'agent_usage_hourly',
    'agent_usage_daily',
    'agent_tool_usage_hourly',
    'agent_tool_usage_daily',
    'agent_session_summaries',
    'agent_repositories',
    'trace_filter_options'
)
GROUP BY table
ORDER BY active_parts DESC
LIMIT ${ROWS_LIMIT}
"
