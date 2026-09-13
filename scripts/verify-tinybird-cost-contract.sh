#!/usr/bin/env bash
set -euo pipefail

failed=0

check() {
  local label="$1"
  shift
  local output
  if output="$("$@" 2>/dev/null)" && [[ -n "$output" ]]; then
    printf 'Tinybird cost contract failed: %s\n%s\n' "$label" "$output" >&2
    failed=1
  fi
}

final_violations="$(rg -n '\bFINAL\b' materializations pipes \
  | grep -Ev '^(pipes/agent_(context_call_buckets_hourly|repositories|session_file_signals|session_signals|session_summaries|tool_usage_daily|tool_usage_hourly|usage_daily|usage_hourly)_published|pipes/agent_(cost_by_depth|review_unit_costs|delivery_receipt|fact_identity_day|snapshot_manifest_latest|priced_usage))\.pipe:' || true)"
if [[ -n "$final_violations" ]]; then
  printf 'Tinybird cost contract failed: FINAL is limited to bounded version/snapshot reads\n%s\n' "$final_violations" >&2
  failed=1
fi

rmt_violations="$(rg -n 'ENGINE "ReplacingMergeTree"' datasources \
  | grep -Ev '^datasources/agent_.*(_versions|_snapshots)\.datasource:|^datasources/agent_(delivery_receipts|fact_identity_days|snapshot_manifest)\.datasource:' || true)"
if [[ -n "$rmt_violations" ]]; then
  printf 'Tinybird cost contract failed: ReplacingMergeTree is limited to version and snapshot resources\n%s\n' "$rmt_violations" >&2
  failed=1
fi

if ! rg -q 'LIMIT \{\{ Int32\(limit, 10\) \}\}' pipes/llm_usage_by_model.pipe; then
  printf 'Tinybird cost contract failed: llm_usage_by_model must honor the requested limit\n' >&2
  failed=1
fi

bash scripts/verify-tinybird-copy-policy.sh

declare -a roots=()
for root in datasources materializations pipes copies; do
  if [[ -d "$root" ]]; then
    roots+=("$root")
  fi
done

if [[ "${#roots[@]}" -gt 0 ]]; then
  check "Tinybird resource names must not keep migration suffixes" \
    find "${roots[@]}" -type f \( -name '*_copy.*' -o -name '*_mv.*' -o -name '*_v2.*' -o -name '*_v3.*' -o -name '*_clean.*' -o -name '*_next.*' -o -name '*_tmp.*' -o -name '*_migration.*' \) -print
fi

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

printf 'Tinybird cost contract passed\n'
