#!/usr/bin/env bash
# Read-only parity checks for phased Tinybird rollout. Compares legacy FINAL sources to clean facts
# and serving aggregates. Use after backfill, during dual-write soak, and before cleanup.
set -euo pipefail

HOURS="${1:-24}"
if [[ ! "$HOURS" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 [hours]" >&2
  exit 2
fi

export CI="${CI:-1}"
export TB_VERSION_WARNING="${TB_VERSION_WARNING:-0}"
ROWS_LIMIT="${ROWS_LIMIT:-50}"

require_legacy_resources() {
  local listing
  listing="$(tb --cloud datasource ls)"
  for name in \
    agent_messages \
    agent_tool_events \
    agent_file_events \
    agent_pull_request_links \
    agent_capability_snapshots \
    otel_traces \
    otel_traces_genai \
    llm_requests; do
    if ! grep -q "name: $name"$ <<<"$listing"; then
      echo "Legacy datasource '$name' is missing." >&2
      echo "Run this parity report only after the Tinybird expansion phase, before cleanup." >&2
      exit 1
    fi
  done
}

run_query() {
  local title="$1"
  local query="$2"

  echo
  echo "=== $title ==="
  tb --cloud sql --rows-limit "$ROWS_LIMIT" "$query"
}

require_legacy_resources

run_query "Raw fact parity" "
SELECT *
FROM
(
    SELECT 'agent_messages' AS source, count() AS legacy_rows
    FROM agent_messages FINAL
    UNION ALL
    SELECT 'agent_tool_events', count() FROM agent_tool_events FINAL
    UNION ALL
    SELECT 'agent_file_events', count() FROM agent_file_events FINAL
    UNION ALL
    SELECT 'agent_pull_request_links', count() FROM agent_pull_request_links FINAL
    UNION ALL
    SELECT 'agent_capability_snapshots', count() FROM agent_capability_snapshots FINAL
    UNION ALL
    SELECT 'otel_traces', count() FROM otel_traces FINAL
    UNION ALL
    SELECT 'otel_traces_genai', count() FROM otel_traces_genai FINAL
    UNION ALL
    SELECT 'llm_requests', count() FROM llm_requests FINAL
) AS legacy
LEFT JOIN
(
    SELECT 'agent_messages' AS source, count() AS clean_rows FROM agent_message_facts
    UNION ALL
    SELECT 'agent_tool_events', count() FROM agent_tool_event_facts
    UNION ALL
    SELECT 'agent_file_events', count() FROM agent_file_event_facts
    UNION ALL
    SELECT 'agent_pull_request_links', count() FROM agent_pull_request_facts
    UNION ALL
    SELECT 'agent_capability_snapshots', count() FROM agent_capability_snapshot_facts
    UNION ALL
    SELECT 'otel_traces', count() FROM otel_trace_spans
    UNION ALL
    SELECT 'otel_traces_genai', count() FROM otel_genai_spans
    UNION ALL
    SELECT 'llm_requests', count() FROM llm_request_facts
) AS clean USING source
ORDER BY source
"

run_query "Recent missing clean identities (${HOURS}h)" "
SELECT *
FROM
(
    SELECT
        'agent_messages' AS source,
        count() AS missing_clean_rows
    FROM agent_messages FINAL
    WHERE EventAt >= now() - INTERVAL $HOURS HOUR
      AND (OrgId, session_pk, message_pk) NOT IN
        (SELECT OrgId, session_pk, message_pk FROM agent_message_facts)
    UNION ALL
    SELECT 'agent_tool_events', count()
    FROM agent_tool_events FINAL
    WHERE EventAt >= now() - INTERVAL $HOURS HOUR
      AND (OrgId, session_pk, tool_use_pk) NOT IN
        (SELECT OrgId, session_pk, tool_use_pk FROM agent_tool_event_facts)
    UNION ALL
    SELECT 'agent_file_events', count()
    FROM agent_file_events FINAL
    WHERE EventAt >= now() - INTERVAL $HOURS HOUR
      AND (OrgId, session_pk, file_event_pk) NOT IN
        (SELECT OrgId, session_pk, file_event_pk FROM agent_file_event_facts)
    UNION ALL
    SELECT 'agent_pull_request_links', count()
    FROM agent_pull_request_links FINAL
    WHERE EventAt >= now() - INTERVAL $HOURS HOUR
      AND (OrgId, session_pk, pull_request_link_pk) NOT IN
        (SELECT OrgId, session_pk, pull_request_link_pk FROM agent_pull_request_facts)
    UNION ALL
    SELECT 'agent_capability_snapshots', count()
    FROM agent_capability_snapshots FINAL
    WHERE EventAt >= now() - INTERVAL $HOURS HOUR
      AND (OrgId, session_pk, capability_snapshot_pk) NOT IN
        (SELECT OrgId, session_pk, capability_snapshot_pk FROM agent_capability_snapshot_facts)
    UNION ALL
    SELECT 'otel_traces', count()
    FROM otel_traces FINAL
    WHERE toDateTime(ReceivedAt / 1000000000) >= now() - INTERVAL $HOURS HOUR
      AND (ApiKey, TraceId, SpanId) NOT IN
        (SELECT ApiKey, TraceId, SpanId FROM otel_trace_spans)
    UNION ALL
    SELECT 'otel_traces_genai', count()
    FROM otel_traces_genai FINAL
    WHERE toDateTime(ReceivedAt / 1000000000) >= now() - INTERVAL $HOURS HOUR
      AND (ApiKey, TraceId, SpanId) NOT IN
        (SELECT ApiKey, TraceId, SpanId FROM otel_genai_spans)
    UNION ALL
    SELECT 'llm_requests', count()
    FROM llm_requests FINAL
    WHERE toDateTime(ReceivedAt / 1000000000) >= now() - INTERVAL $HOURS HOUR
      AND (ApiKey, TraceId, SpanId) NOT IN
        (SELECT ApiKey, TraceId, SpanId FROM llm_request_facts)
)
ORDER BY source
"

run_query "Agent serving parity" "
SELECT 'assistant_messages_raw' AS metric, count() AS value
FROM agent_message_facts
WHERE role = 'assistant'
UNION ALL
SELECT 'assistant_messages_hourly', countMerge(MessageCount)
FROM agent_usage_hourly
UNION ALL
SELECT 'assistant_messages_sessions', sumMerge(MessageCount)
FROM agent_session_summaries
UNION ALL
SELECT 'tool_events_raw', count()
FROM agent_tool_event_facts
UNION ALL
SELECT 'tool_events_hourly', countMerge(EventCount)
FROM agent_tool_usage_hourly
UNION ALL
SELECT 'tool_events_sessions', sumMerge(ToolEventCount)
FROM agent_session_summaries
ORDER BY metric
"

run_query "Copy jobs still running (${HOURS}h)" "
SELECT
    pipe_name,
    count() AS ops,
    round(sum(cpu_time), 3) AS cpu_seconds,
    sum(read_rows) AS read_rows,
    sum(written_rows) AS written_rows
FROM organization.datasources_ops_log
WHERE timestamp >= now() - INTERVAL $HOURS HOUR
  AND (event_type = 'copy' OR pipe_name LIKE '%copy%')
GROUP BY pipe_name
ORDER BY cpu_seconds DESC
"
