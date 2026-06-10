#!/usr/bin/env bash
# One-time Tinybird backfill from legacy ReplacingMergeTree tables into clean MergeTree fact tables.
# Safe to run after dual-write has started: every export filters out rows already present in the
# clean target by stable fact identity.
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
    echo "Refusing backfill: unknown TB_TARGET_WORKSPACE '$TARGET_WORKSPACE'." >&2
    exit 1
    ;;
esac

if [[ "$DRY_RUN" == "0" ]]; then
  if [[ "$TARGET_WORKSPACE" == "trace_flow_prod" ]]; then
    if [[ ! "${TINYBIRD_BACKFILL_APPROVED:-}" =~ ^trace_flow_prod_[0-9]{8}$ ]]; then
      echo "Refusing prod backfill without TINYBIRD_BACKFILL_APPROVED=trace_flow_prod_YYYYMMDD." >&2
      exit 1
    fi
  elif [[ "${TINYBIRD_BACKFILL_APPROVED:-}" != "$TARGET_WORKSPACE" ]]; then
    echo "Refusing dev backfill without TINYBIRD_BACKFILL_APPROVED=$TARGET_WORKSPACE." >&2
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

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/trace-flow-tinybird-backfill.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

DATASOURCE_LISTING="$(tb --cloud datasource ls)"

require_datasource() {
  local name="$1"
  if ! grep -q "name: $name"$ <<<"$DATASOURCE_LISTING"; then
    echo "Required datasource '$name' is missing." >&2
    echo "Run backfill only after expansion deploy and before cleanup." >&2
    exit 1
  fi
}

for datasource in \
  agent_messages agent_message_facts \
  agent_tool_events agent_tool_event_facts \
  agent_file_events agent_file_event_facts \
  agent_pull_request_links agent_pull_request_facts \
  agent_capability_snapshots agent_capability_snapshot_facts \
  otel_traces otel_trace_spans \
  otel_traces_genai otel_genai_spans \
  llm_requests llm_request_facts; do
  require_datasource "$datasource"
done

query_json() {
  local query="$1"
  curl -fsS -G "$TB_HOST/v0/sql" \
    --data-urlencode "q=$query FORMAT JSON" \
    -H "Authorization: Bearer $TB_TOKEN"
}

export_each_row() {
  local query="$1"
  local file="$2"
  curl -fsS -G "$TB_HOST/v0/sql" \
    --data-urlencode "q=$query FORMAT JSONEachRow" \
    -H "Authorization: Bearer $TB_TOKEN" \
    -o "$file"
}

backfill_table() {
  local source="$1"
  local target="$2"
  local identity="$3"
  local file="$TMP_DIR/${target}.ndjson"
  local filter="$identity NOT IN (SELECT $identity FROM $target)"
  local missing

  missing="$(
    query_json "SELECT count() AS missing FROM $source FINAL WHERE $filter" |
      jq -r '.data[0].missing // 0'
  )"

  printf '%-38s missing=%s\n' "$target" "$missing"
  if [[ "$missing" == "0" || "$DRY_RUN" == "1" ]]; then
    return
  fi

  export_each_row "SELECT * FROM $source FINAL WHERE $filter" "$file"
  local rows
  rows="$(wc -l < "$file" | tr -d ' ')"
  if [[ "$rows" == "0" ]]; then
    echo "WARN: $source reported $missing missing rows but exported 0 rows" >&2
    return
  fi

  tb --cloud datasource append "$target" --file "$file"
}

echo "Tinybird clean fact backfill target: $TARGET_WORKSPACE"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry run: counting missing rows only."
fi

backfill_table agent_messages agent_message_facts "(OrgId, session_pk, message_pk)"
backfill_table agent_tool_events agent_tool_event_facts "(OrgId, session_pk, tool_use_pk)"
backfill_table agent_file_events agent_file_event_facts "(OrgId, session_pk, file_event_pk)"
backfill_table agent_pull_request_links agent_pull_request_facts "(OrgId, session_pk, pull_request_link_pk)"
backfill_table agent_capability_snapshots agent_capability_snapshot_facts "(OrgId, session_pk, capability_snapshot_pk)"
backfill_table otel_traces otel_trace_spans "(ApiKey, TraceId, SpanId)"
backfill_table otel_traces_genai otel_genai_spans "(ApiKey, TraceId, SpanId)"
backfill_table llm_requests llm_request_facts "(ApiKey, TraceId, SpanId)"

echo "Backfill complete."
