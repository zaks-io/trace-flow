#!/usr/bin/env bash
# One-time Tinybird repair for the context-health serving table.
# Replaces agent_context_call_buckets_hourly from agent_message_facts, then checks parity.
set -euo pipefail

TARGET_WORKSPACE="${TB_TARGET_WORKSPACE:-trace_flow_dev}"
DRY_RUN=0

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--dry-run]" >&2
  exit 2
fi

case "$TARGET_WORKSPACE" in
  trace_flow_dev | trace_flow_prod) ;;
  *)
    echo "Refusing context-health backfill: unknown TB_TARGET_WORKSPACE '$TARGET_WORKSPACE'." >&2
    exit 1
    ;;
esac

if [[ "$DRY_RUN" == "0" ]]; then
  if [[ "$TARGET_WORKSPACE" == "trace_flow_prod" ]]; then
    if [[ ! "${TINYBIRD_CONTEXT_HEALTH_BACKFILL_APPROVED:-}" =~ ^trace_flow_prod_[0-9]{8}$ ]]; then
      echo "Refusing prod context-health backfill without TINYBIRD_CONTEXT_HEALTH_BACKFILL_APPROVED=trace_flow_prod_YYYYMMDD." >&2
      exit 1
    fi
  elif [[ "${TINYBIRD_CONTEXT_HEALTH_BACKFILL_APPROVED:-}" != "$TARGET_WORKSPACE" ]]; then
    echo "Refusing dev context-health backfill without TINYBIRD_CONTEXT_HEALTH_BACKFILL_APPROVED=$TARGET_WORKSPACE." >&2
    exit 1
  fi
fi

export CI="${CI:-1}"
export TB_VERSION_WARNING="${TB_VERSION_WARNING:-0}"

if [[ -z "${TB_TOKEN:-}" && -f ".tinyb" ]]; then
  export TB_TOKEN
  TB_TOKEN="$(jq -r '.token' .tinyb)"
  if [[ -z "${TB_HOST:-}" ]]; then
    export TB_HOST
    TB_HOST="$(jq -r '.host' .tinyb)"
  fi
fi

TB_HOST="${TB_HOST:-https://api.us-west-2.aws.tinybird.co}"
TB_HOST="${TB_HOST%/}"
[[ -n "${TB_TOKEN:-}" ]] || {
  echo "TB_TOKEN is required, or run from a workspace with .tinyb." >&2
  exit 1
}

query_json() {
  local query="$1"
  curl -fsS -G "$TB_HOST/v0/sql" \
    --data-urlencode "q=$query FORMAT JSON" \
    -H "Authorization: Bearer $TB_TOKEN"
}

require_listing_entry() {
  local kind="$1"
  local listing="$2"
  local name="$3"
  if ! grep -Eq "(^name: ${name}$|[|[:space:]]${name}[|[:space:]])" <<<"$listing"; then
    echo "Required $kind '$name' is missing. Deploy Tinybird schema before running this repair." >&2
    exit 1
  fi
}

parity_sql() {
  cat <<'SQL'
SELECT
    expected.calls AS expected_calls,
    actual.calls AS actual_calls,
    expected.sessions AS expected_sessions,
    actual.sessions AS actual_sessions,
    expected.context_tokens AS expected_context_tokens,
    actual.context_tokens AS actual_context_tokens,
    expected.output_tokens AS expected_output_tokens,
    actual.output_tokens AS actual_output_tokens,
    expected.cost_usd AS expected_cost_usd,
    actual.cost_usd AS actual_cost_usd,
    expected.calls = actual.calls
        AND expected.sessions = actual.sessions
        AND expected.context_tokens = actual.context_tokens
        AND expected.output_tokens = actual.output_tokens
        AND expected.cost_usd = actual.cost_usd AS parity_ok
FROM
(
    SELECT
        count() AS calls,
        uniqExact(session_pk) AS sessions,
        sum(toUInt64(input_tokens) + toUInt64(cache_read_tokens) + toUInt64(cache_creation_tokens)) AS context_tokens,
        sum(toUInt64(output_tokens)) AS output_tokens,
        round(sum(ifNull(cost_usd, 0.)), 6) AS cost_usd
    FROM agent_message_facts
    WHERE role = 'assistant'
        AND token_coverage != 'missing'
) AS expected
CROSS JOIN
(
    SELECT
        ifNull(sum(finalizeAggregation(CallCount)), 0) AS calls,
        uniqExact(session_pk) AS sessions,
        ifNull(sum(context_tokens * finalizeAggregation(CallCount)), 0) AS context_tokens,
        ifNull(sum(finalizeAggregation(OutputTokens)), 0) AS output_tokens,
        round(ifNull(sum(finalizeAggregation(CostUsd)), 0.), 6) AS cost_usd
    FROM agent_context_call_buckets_hourly
) AS actual
SQL
}

datasource_listing="$(tb --cloud datasource ls)"
require_listing_entry datasource "$datasource_listing" agent_message_facts
require_listing_entry datasource "$datasource_listing" agent_context_call_buckets_hourly

copy_listing="$(tb --cloud copy ls)"
require_listing_entry "copy pipe" "$copy_listing" repair_agent_context_call_buckets_hourly

echo "Tinybird context-health backfill target: $TARGET_WORKSPACE"
echo "Current parity:"
before_json="$(query_json "$(parity_sql)")"
echo "$before_json" | jq '.data[0]'

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry run: not running repair_agent_context_call_buckets_hourly."
  exit 0
fi

tb --cloud copy run repair_agent_context_call_buckets_hourly --wait --mode replace

echo "Post-backfill parity:"
after_json="$(query_json "$(parity_sql)")"
echo "$after_json" | jq '.data[0]'

parity_ok="$(echo "$after_json" | jq -r '.data[0].parity_ok // 0')"
if [[ "$parity_ok" != "1" && "$parity_ok" != "true" ]]; then
  echo "Context-health backfill parity failed. Pause agent ingestion and rerun the repair." >&2
  exit 1
fi

echo "Context-health backfill complete."
