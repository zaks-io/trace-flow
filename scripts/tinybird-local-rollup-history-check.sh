#!/usr/bin/env bash
# Tinybird Local proof that changing the usage rollup materializations keeps rollup history.
#
# 1. Deploys BASE_REF's Tinybird project to a scratch Local workspace named trace_flow_dev.
# 2. Seeds proxy and imported spans, then deletes their facts, leaving rollup rows that a
#    rebuild from facts could not recreate.
# 3. Deploys this checkout's project, whose rollup pipes use DEPLOYMENT_METHOD alter.
# 4. Asserts the seeded rollup aggregates are unchanged, new proxy facts still land, and new
#    imported facts stay out of the rollups.
# 5. Runs scripts/tinybird-remove-imported-rollup-rows.sh against the same Local workspace:
#    it must refuse a key with proxy history, remove an import-only key, and be re-runnable.
#
# Only Tinybird Local is touched: every request goes to http://localhost:7181 with a Local token.
# Usage: scripts/tinybird-local-rollup-history-check.sh [base-ref]   (default: origin/main)
set -euo pipefail

BASE_REF="${1:-origin/main}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_HOST="http://localhost:7181"
WORKSPACE="trace_flow_dev"
ROLLUPS=(llm_usage_hourly llm_usage_daily llm_usage_monthly)
export CI=1 TB_VERSION_WARNING=0
unset TB_TOKEN TB_HOST

local_tokens() { curl -fsS "$LOCAL_HOST/tokens"; }
admin_token() { local_tokens | jq -r '.admin_token'; }
user_token() { local_tokens | jq -r '.user_token'; }

workspace_field() {
  curl -fsS "$LOCAL_HOST/v1/user/workspaces?with_organization=true&token=$(admin_token)" |
    jq -r --arg name "$WORKSPACE" --arg field "$1" '.workspaces[] | select(.name == $name) | .[$field]'
}

delete_workspace() {
  local id
  id="$(workspace_field id)"
  [[ -n "$id" ]] || return 0
  curl -fsS -X DELETE \
    "$LOCAL_HOST/v1/workspaces/$id?token=$(user_token)&hard_delete_confirmation=yes" >/dev/null
}

curl -fsS "$LOCAL_HOST/tokens" >/dev/null || {
  echo "Tinybird Local is not running. Start it with 'tb local start'." >&2
  exit 1
}
if [[ -n "$(workspace_field id)" ]]; then
  echo "A Tinybird Local workspace named $WORKSPACE already exists; remove it before this check." >&2
  exit 1
fi

PROOF_DIR="$(mktemp -d "${TMPDIR:-/tmp}/trace-flow-rollup-history.XXXXXX")"
cleanup() {
  delete_workspace || true
  rm -rf "$PROOF_DIR"
}
trap cleanup EXIT

stage_project() {
  rm -rf "$PROOF_DIR/project"
  mkdir -p "$PROOF_DIR/project"
  if [[ "$1" == "worktree" ]]; then
    (cd "$ROOT_DIR" && tar -cf - tinybird.config.json datasources materializations pipes copies) |
      tar -xf - -C "$PROOF_DIR/project"
  else
    git -C "$ROOT_DIR" archive "$1" tinybird.config.json datasources materializations pipes copies |
      tar -xf - -C "$PROOF_DIR/project"
  fi
  # Outside git, `tb --local` uses the workspace named in the project's .tinyb.
  printf '{"name": "%s"}\n' "$WORKSPACE" > "$PROOF_DIR/project/.tinyb"
}

deploy() {
  echo "Deploying $1 to Tinybird Local workspace $WORKSPACE ..."
  (cd "$PROOF_DIR/project" && tb --local deploy > "$PROOF_DIR/deploy.log" 2>&1) || {
    tail -40 "$PROOF_DIR/deploy.log" >&2
    exit 1
  }
  TOKEN="$(workspace_field token)"
  [[ -n "$TOKEN" ]] || {
    echo "Deploy did not create Tinybird Local workspace $WORKSPACE." >&2
    exit 1
  }
}

query() {
  curl -fsS -G "$LOCAL_HOST/v0/sql" --data-urlencode "q=$1 FORMAT JSON" \
    -H "Authorization: Bearer $TOKEN" | jq -c '.data'
}

# One NDJSON span per argument: key|source|ISO received time|request id|total cost USD.
span_lines() {
  local spec key source received id cost received_ns
  for spec in "$@"; do
    IFS='|' read -r key source received id cost <<<"$spec"
    received_ns="$(jq -nr --arg t "$received" '($t | fromdateiso8601) * 1000000000 | tostring')"
    jq -nc --arg key "$key" --arg source "$source" --arg id "$id" --arg cost "$cost" \
      --argjson received "$received_ns" '{
        ApiKey: $key, Duration: 1000000000,
        "Events.Attributes": [], "Events.Name": [], "Events.Timestamp": [],
        "Links.Attributes": [], "Links.SpanId": [], "Links.TraceId": [], "Links.TraceState": [],
        ParentSpanId: "", ReceivedAt: $received, Timestamp: $received,
        ResourceAttributes: "{\"service.name\":\"rollup-history-check\"}",
        RetentionExpiresAt: 4102444800000000000, ServiceName: "rollup-history-check",
        SpanAttributes: ({
          "gen_ai.system": "openai", "gen_ai.request.model": "gpt-5",
          "gen_ai.usage.input_tokens": "100", "gen_ai.usage.output_tokens": "10",
          "gen_ai.cost.total": $cost, "trace_flow.source": $source
        } | tojson),
        SpanId: ($id + "000000000000")[0:16], SpanKind: "SPAN_KIND_SERVER", SpanName: "gpt-5",
        StatusCode: "STATUS_CODE_OK", StatusMessage: "", TierAtIngestion: "pro",
        TraceId: ($id + "00000000000000000000000000000000")[0:32], TraceState: ""
      }'
  done
}

append_spans() {
  curl -fsS -X POST "$LOCAL_HOST/v0/events?name=otel_trace_spans&wait=true" \
    -H "Authorization: Bearer $TOKEN" --data-binary "$(span_lines "$@")" |
    jq -e --argjson n "$#" '.successful_rows == $n and .quarantined_rows == 0' >/dev/null || {
    echo "Tinybird Local did not accept every seeded span." >&2
    exit 1
  }
}

rollup_snapshot() {
  local rollup sql=""
  for rollup in "${ROLLUPS[@]}"; do
    [[ -z "$sql" ]] || sql+=" UNION ALL "
    sql+="SELECT '$rollup' AS rollup, ApiKey, toString(BucketStart) AS bucket,
      toUInt32(countMerge(RequestCount)) AS requests, toUInt32(sumMerge(TotalCostMicrodollars)) AS cost,
      toUInt32(sumMerge(CostProxyCount)) AS proxy_count
      FROM $rollup GROUP BY ApiKey, BucketStart"
  done
  query "SELECT * FROM ($sql) ORDER BY rollup, ApiKey, bucket"
}

expect_equal() {
  if [[ "$2" != "$3" ]]; then
    echo "FAIL: $1" >&2
    echo "  expected: $3" >&2
    echo "  actual:   $2" >&2
    exit 1
  fi
  echo "PASS: $1"
}

rollup_keys() {
  query "SELECT groupUniqArray(ApiKey) AS keys FROM (
      SELECT ApiKey FROM llm_usage_hourly UNION ALL SELECT ApiKey FROM llm_usage_daily
      UNION ALL SELECT ApiKey FROM llm_usage_monthly) WHERE ApiKey LIKE '$1'" |
    jq -c '.[0].keys | sort'
}

run_repair() {
  TB_HOST="$LOCAL_HOST" TB_TOKEN="$TOKEN" TB_TARGET_WORKSPACE="$WORKSPACE" \
    TINYBIRD_IMPORTED_ROLLUP_REPAIR_APPROVED="$WORKSPACE" \
    "$ROOT_DIR/scripts/tinybird-remove-imported-rollup-rows.sh" "$@"
}

stage_project "$BASE_REF"
deploy "$BASE_REF"

# History: a mixed proxy and imported hour, an import-only key, and an unrelated proxy key.
append_spans \
  "hist_mixed|proxy|2026-09-15T10:05:00Z|a1|0.5" \
  "hist_mixed|imported_execution|2026-09-15T10:06:00Z|a2|0.25" \
  "hist_import|imported_execution|2026-10-01T11:00:00Z|a3|0.125" \
  "hist_other|proxy|2026-09-20T09:00:00Z|a4|1"
for ds in llm_request_facts otel_trace_spans; do
  (cd "$PROOF_DIR/project" &&
    tb --local datasource delete "$ds" --sql-condition "ApiKey LIKE 'hist_%'" --wait --yes >/dev/null)
done
expect_equal "seeded history has no facts" \
  "$(query "SELECT toUInt32(count()) AS n FROM llm_request_facts WHERE ApiKey LIKE 'hist_%'" | jq -c '.[0].n')" "0"
# A retained fact must neither vanish from nor be counted twice in the rollups by the redeploy.
# The import-only keys below keep their facts for the repair's gap and race regressions.
append_spans \
  "kept_proxy|proxy|2026-10-01T09:00:00Z|c1|3" \
  "gap_import|imported_execution|2026-10-01T13:00:00Z|d1|0.5" \
  "race_import|imported_execution|2026-10-01T12:00:00Z|e1|0.75" \
  "resume_import|imported_execution|2026-10-01T14:00:00Z|f1|0.5"
before="$(rollup_snapshot)"
expect_equal "old materializations rolled up imported history" \
  "$(jq -c '[.[] | select(.rollup == "llm_usage_hourly" and .ApiKey == "hist_mixed") | .requests]' <<<"$before")" "[2]"

stage_project worktree
deploy "the working tree"
for rollup in "${ROLLUPS[@]}"; do
  expect_equal "live materialize_$rollup filters to proxy" \
    "$(curl -fsS "$LOCAL_HOST/v0/pipes/materialize_$rollup" -H "Authorization: Bearer $TOKEN" |
      jq -r '[.nodes[].sql] | join(" ")' | grep -Eic "where[[:space:]]+source[[:space:]]*=[[:space:]]*'proxy'")" "1"
done
expect_equal "seeded rollup history survives the altered materializations" "$(rollup_snapshot)" "$before"

append_spans \
  "new_mixed|proxy|2026-10-02T10:05:00Z|b1|2" \
  "new_mixed|imported_execution|2026-10-02T10:06:00Z|b2|4" \
  "new_import|imported_execution|2026-10-02T10:07:00Z|b3|8"
expect_equal "new facts keep both sources" \
  "$(query "SELECT toUInt32(count()) AS n FROM llm_request_facts WHERE ApiKey LIKE 'new_%'" | jq -c '.[0].n')" "3"
after="$(rollup_snapshot)"
expect_equal "new proxy facts land in every rollup and imported facts do not" \
  "$(jq -c '[.[] | select(.ApiKey | startswith("new_")) | [.rollup, .ApiKey, .requests, .cost, .proxy_count]]' <<<"$after")" \
  '[["llm_usage_daily","new_mixed",1,2000000,1],["llm_usage_hourly","new_mixed",1,2000000,1],["llm_usage_monthly","new_mixed",1,2000000,1]]'
expect_equal "seeded history is unchanged by new inserts" \
  "$(jq -c '[.[] | select(.ApiKey | startswith("hist_"))]' <<<"$after")" \
  "$(jq -c '[.[] | select(.ApiKey | startswith("hist_"))]' <<<"$before")"

expect_repair_refused() {
  if run_repair "$1" >"$PROOF_DIR/repair.log" 2>&1; then
    echo "FAIL: repair accepted $1 ($2)" >&2
    exit 1
  fi
  expect_equal "repair refuses $1 ($2)" \
    "$(grep -Ec "${3:-has proxy or unexplained rollup history}" "$PROOF_DIR/repair.log")" "1"
}
expect_repair_refused hist_mixed "proxy history" "blend proxy and imported data|has proxy or unexplained rollup history"
expect_repair_refused hist_import "rollup requests with no retained imported facts"
append_spans "hist_import|imported_execution|2026-10-02T12:00:00Z|a6|0"
expect_repair_refused hist_import "a later import cannot explain an earlier rollup hour"

# Retaining the import-only key's fact explains its rollup history; the new fact skips rollups.
append_spans "hist_import|imported_execution|2026-10-01T11:00:00Z|a5|0"
run_repair hist_import
expect_equal "repair removes every rollup row for the import-only key" "$(rollup_keys 'hist_import')" "[]"
expect_equal "repair keeps every other key's rollup rows" \
  "$(rollup_snapshot | jq -c '[.[] | select(.ApiKey != "hist_import")]')" \
  "$(jq -c '[.[] | select(.ApiKey != "hist_import")]' <<<"$after")"
run_repair hist_import
echo "PASS: repair is safe to re-run"

# An expired hourly row with surviving daily and monthly rows leaves those buckets unbacked.
(cd "$PROOF_DIR/project" &&
  tb --local datasource delete llm_usage_hourly --sql-condition "ApiKey = 'gap_import'" --wait --yes >/dev/null)
expect_repair_refused gap_import "daily and monthly buckets without hourly rows"

# Resume: a run that stops after its first delete (monthly) must rerun to the same end state.
pre_resume="$(rollup_snapshot | jq -c '[.[] | select(.ApiKey != "resume_import")]')"
resume_status=0
# shellcheck disable=SC2016 # $1 is the hook's argument, expanded when the repair runs it.
TINYBIRD_IMPORTED_ROLLUP_REPAIR_TEST_HOOK='[ "$1" != daily ] || { echo "Test hook: interrupting before the daily delete."; exit 1; }' \
  run_repair resume_import >"$PROOF_DIR/resume.log" 2>&1 || resume_status=$?
expect_equal "resume: first run stops after the monthly delete" \
  "$resume_status:$(grep -c "Test hook: interrupting" "$PROOF_DIR/resume.log"):$(rollup_snapshot |
    jq -c '[.[] | select(.ApiKey == "resume_import") | .rollup]')" \
  '1:1:["llm_usage_daily","llm_usage_hourly"]'
run_repair resume_import
expect_equal "resume: rerun removes every rollup row for the key" "$(rollup_keys 'resume_import')" "[]"
expect_equal "resume: rerun keeps every other key's rollup rows" \
  "$(rollup_snapshot | jq -c '[.[] | select(.ApiKey != "resume_import")]')" "$pre_resume"

# Race: the key's first proxy request lands after the final purity check, before the delete.
# The guarded delete must keep it whether or not a merge blended it into the imported row.
span_lines "race_import|proxy|2026-10-01T12:30:00Z|e2|2" > "$PROOF_DIR/race-span.ndjson"
cat > "$PROOF_DIR/race-hook.sh" <<HOOK
curl -fsS -X POST "\$TB_HOST/v0/events?name=otel_trace_spans&wait=true" \\
  -H "Authorization: Bearer \$TB_TOKEN" --data-binary @"$PROOF_DIR/race-span.ndjson" >/dev/null
echo "Test hook: injected a proxy request for race_import."
HOOK
race_status=0
TINYBIRD_IMPORTED_ROLLUP_REPAIR_TEST_HOOK="[ \"\$1\" != monthly ] || bash '$PROOF_DIR/race-hook.sh'" \
  run_repair race_import >"$PROOF_DIR/race.log" 2>&1 || race_status=$?
grep -q "Test hook: injected" "$PROOF_DIR/race.log" || {
  cat "$PROOF_DIR/race.log" >&2
  echo "FAIL: race hook did not run" >&2
  exit 1
}
race_rows="$(rollup_snapshot | jq -c '[.[] | select(.ApiKey == "race_import") | [.rollup, .requests, .cost, .proxy_count]]')"
echo "race_import rollups after repair (exit $race_status): $race_rows"
expect_equal "race: proxy request survives in every rollup with its cost" \
  "$(jq -c '[.[] | select(.[3] == 1 and (([.[1], .[2]] == [1, 2000000]) or ([.[1], .[2]] == [2, 2750000])))] | length' <<<"$race_rows")" "3"
if [[ "$race_status" == "0" ]]; then
  expect_equal "race: clean outcome removed the imported estimate everywhere" \
    "$race_rows" '[["llm_usage_daily",1,2000000,1],["llm_usage_hourly",1,2000000,1],["llm_usage_monthly",1,2000000,1]]'
else
  expect_equal "race: merged outcome reports partial repair" \
    "$(grep -c "partially repaired" "$PROOF_DIR/race.log")" "1"
fi
echo "Rollup history check passed against $BASE_REF."
