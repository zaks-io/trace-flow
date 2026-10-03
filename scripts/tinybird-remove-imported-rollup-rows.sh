#!/usr/bin/env bash
# One-time Tinybird repair: delete one API key's imported-execution rows from the usage rollups.
#
# Before the rollup materializations gained `WHERE Source = 'proxy'`, Local proxy imports were
# summed into llm_usage_{hourly,daily,monthly} next to real proxy spend. This removes the rollup
# rows of an API key that only ever carried imported executions. The key is passed explicitly and
# is never derived from retained facts. The script refuses to delete unless:
#   - the API reports the expected workspace (the same TB_TOKEN/TB_HOST drive `tb --cloud`);
#   - every live rollup materialization filters to proxy traffic, so no new imported rows land;
#   - the key is pure imported data across its full rollup history (see purity_sql).
# The delete itself only matches rows with CostProxyCount = 0, so proxy traffic that reaches the
# key after the purity check survives: new rows carry it, and a background merge that blends it
# into an old imported row keeps that row (reported as partially repaired).
# Other keys' finalized aggregates are captured before and compared after the delete.
# Re-running is safe: the delete is scoped to the key and nothing is appended.
# Run it before the key's earliest imported request fact expires (7 days on hobby, 30 on pro);
# after that its rollup history can no longer be explained and the script refuses.
#
# Usage:
#   scripts/tinybird-remove-imported-rollup-rows.sh --dry-run <api-key>
#   TINYBIRD_IMPORTED_ROLLUP_REPAIR_APPROVED=trace_flow_dev \
#     scripts/tinybird-remove-imported-rollup-rows.sh <api-key>
#   TB_TARGET_WORKSPACE=trace_flow_prod \
#     TINYBIRD_IMPORTED_ROLLUP_REPAIR_APPROVED=trace_flow_prod_YYYYMMDD \
#     scripts/tinybird-remove-imported-rollup-rows.sh <api-key>
set -euo pipefail

TARGET_WORKSPACE="${TB_TARGET_WORKSPACE:-trace_flow_dev}"
GRAINS=(hourly daily monthly)
# Rollup buckets before imported ingestion began can only hold proxy traffic.
IMPORTED_INGESTION_START="2026-10-01 00:00:00"
# Coarse to fine, so an interrupted run leaves every remaining bucket backed by its finer rollup
# and a rerun still passes the purity check.
DELETE_ORDER=(monthly daily hourly)
# Local regression hook, run before each delete with the grain about to be deleted as $1.
TEST_HOOK="${TINYBIRD_IMPORTED_ROLLUP_REPAIR_TEST_HOOK:-}"
DRY_RUN=0

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi
if [[ $# -ne 1 ]]; then
  echo "Usage: $0 [--dry-run] <api-key>" >&2
  exit 2
fi
API_KEY="$1"

# The key is interpolated into SQL, so only accept stored key shapes.
if [[ ! "$API_KEY" =~ ^[A-Za-z0-9._:-]{1,128}$ ]]; then
  echo "Refusing imported rollup repair: API key has unexpected characters." >&2
  exit 1
fi

case "$TARGET_WORKSPACE" in
  trace_flow_dev | trace_flow_prod) ;;
  *)
    echo "Refusing imported rollup repair: unknown TB_TARGET_WORKSPACE '$TARGET_WORKSPACE'." >&2
    exit 1
    ;;
esac

if [[ "$TARGET_WORKSPACE" == "trace_flow_prod" && -n "$TEST_HOOK" ]]; then
  echo "Refusing imported rollup repair: the test hook is for Tinybird Local only." >&2
  exit 1
fi

if [[ "$DRY_RUN" == "0" ]]; then
  if [[ "$TARGET_WORKSPACE" == "trace_flow_prod" ]]; then
    # A stale or copied approval must not unlock a prod delete on another day.
    if [[ "${TINYBIRD_IMPORTED_ROLLUP_REPAIR_APPROVED:-}" != "trace_flow_prod_$(date -u +%Y%m%d)" ]]; then
      echo "Refusing prod imported rollup repair without today's TINYBIRD_IMPORTED_ROLLUP_REPAIR_APPROVED=trace_flow_prod_YYYYMMDD (UTC)." >&2
      exit 1
    fi
  elif [[ "${TINYBIRD_IMPORTED_ROLLUP_REPAIR_APPROVED:-}" != "$TARGET_WORKSPACE" ]]; then
    echo "Refusing dev imported rollup repair without TINYBIRD_IMPORTED_ROLLUP_REPAIR_APPROVED=$TARGET_WORKSPACE." >&2
    exit 1
  fi
fi

export CI="${CI:-1}"
export TB_VERSION_WARNING="${TB_VERSION_WARNING:-0}"

if [[ -z "${TB_TOKEN:-}" && -f ".tinyb" ]]; then
  TB_TOKEN="$(jq -r '.token' .tinyb)"
  if [[ -z "${TB_HOST:-}" ]]; then
    TB_HOST="$(jq -r '.host' .tinyb)"
  fi
fi
if [[ -z "${TB_TOKEN:-}" ]]; then
  echo "TB_TOKEN is required, or run from a workspace with .tinyb." >&2
  exit 1
fi
TB_HOST="${TB_HOST:-https://api.us-west-2.aws.tinybird.co}"
TB_HOST="${TB_HOST%/}"
# Exported so `tb --cloud` deletes in the workspace the API checks below just verified.
export TB_TOKEN TB_HOST

KEY="'$API_KEY'"
IMPORTED_FACTS="FROM llm_request_facts WHERE ApiKey = $KEY AND Source = 'imported_execution'"
IMPORTED_ROW="finalizeAggregation(CostProxyCount) = 0"
MIXED_ROW="finalizeAggregation(CostProxyCount) > 0 AND finalizeAggregation(RequestCount) > finalizeAggregation(CostProxyCount)"

api_get() {
  curl -fsS "$TB_HOST$1" -H "Authorization: Bearer $TB_TOKEN"
}

query_row() {
  curl -fsS -G "$TB_HOST/v0/sql" --data-urlencode "q=$1 FORMAT JSON" \
    -H "Authorization: Bearer $TB_TOKEN" | jq -c '.data[0]'
}

period() {
  case "$1" in
    hourly) echo toStartOfHour ;;
    daily) echo toStartOfDay ;;
    monthly) echo toStartOfMonth ;;
  esac
}

assert_workspace() {
  local name
  name="$(api_get /v1/workspace | jq -r '.name // empty')"
  if [[ "$name" != "$TARGET_WORKSPACE" ]]; then
    echo "Refusing imported rollup repair: token targets workspace '${name:-unknown}', not '$TARGET_WORKSPACE'." >&2
    exit 1
  fi
}

# Row counts cannot prove the filter is live, since aggregate groups absorb inserts.
assert_proxy_only_materializations() {
  local grain sql
  for grain in "${GRAINS[@]}"; do
    sql="$(api_get "/v0/pipes/materialize_llm_usage_$grain" | jq -r '[.nodes[].sql] | join("\n")')"
    if ! grep -Eiq "where[[:space:]]+source[[:space:]]*=[[:space:]]*'proxy'" <<<"$sql"; then
      echo "Refusing imported rollup repair: live materialize_llm_usage_$grain has no WHERE Source = 'proxy' filter. Deploy it first." >&2
      exit 1
    fi
  done
  echo "Live rollup materializations filter to proxy traffic."
}

# Buckets of one rollup whose requests differ from (finer) or exceed (facts) the same period.
bucket_requests() {
  echo "SELECT $(period "$2")(BucketStart) AS Period, countMerge(RequestCount) AS requests
    FROM llm_usage_$1 WHERE ApiKey = $KEY GROUP BY Period"
}

# Pure imported history: no proxy facts or proxy counts, no pre-import buckets, every bucket
# explained by imported facts received in that same hour, day, or month (so later imports cannot
# stand in for expired ones), daily and monthly buckets backed by the finer rollup (hourly rows
# expire after 90 days while daily and monthly survive), and no imported fact past its expiry.
# CostProxyCount alone is not enough: rows written before source-aware counts carry zero for
# proxy traffic after 2026-10-01 too.
purity_sql() {
  local grain start="toDateTime('$IMPORTED_INGESTION_START', 'UTC')"
  echo "WITH"
  for grain in "${GRAINS[@]}"; do
    cat <<SQL
    (SELECT toUInt32(count()) FROM llm_usage_$grain WHERE ApiKey = $KEY) AS ${grain}_rows,
    (SELECT toUInt32(countIf(BucketStart < $start)) FROM llm_usage_$grain WHERE ApiKey = $KEY) AS ${grain}_pre_import_rows,
    (SELECT toUInt32(sumMerge(CostProxyCount)) FROM llm_usage_$grain WHERE ApiKey = $KEY) AS ${grain}_proxy_count,
    (SELECT toUInt32(count()) FROM ($(bucket_requests "$grain" "$grain")) AS b
        LEFT JOIN (SELECT $(period "$grain")(toDateTime(ReceivedAt / 1000000000, 'UTC')) AS Period, count() AS facts
            $IMPORTED_FACTS GROUP BY Period) AS f USING Period
        WHERE b.requests > f.facts) AS ${grain}_unexplained,
SQL
  done
  cat <<SQL
    (SELECT toUInt32(count()) FROM ($(bucket_requests daily daily)) AS c
        LEFT JOIN ($(bucket_requests hourly daily)) AS f USING Period
        WHERE c.requests != f.requests) AS daily_unbacked,
    (SELECT toUInt32(count()) FROM ($(bucket_requests monthly monthly)) AS c
        LEFT JOIN ($(bucket_requests daily monthly)) AS f USING Period
        WHERE c.requests != f.requests) AS monthly_unbacked,
    (SELECT toUInt32(count()) FROM llm_request_facts WHERE ApiKey = $KEY AND Source = 'proxy') AS proxy_facts,
    (SELECT toUInt32(count()) $IMPORTED_FACTS) AS imported_facts,
    (SELECT min(RetentionExpiresAt) $IMPORTED_FACTS) AS earliest_expiry_ns
SELECT
    hourly_rows, daily_rows, monthly_rows,
    hourly_proxy_count + daily_proxy_count + monthly_proxy_count AS proxy_count,
    hourly_pre_import_rows + daily_pre_import_rows + monthly_pre_import_rows AS pre_import_rows,
    hourly_unexplained + daily_unexplained + monthly_unexplained AS unexplained_buckets,
    daily_unbacked + monthly_unbacked AS unbacked_buckets,
    proxy_facts, imported_facts,
    if(imported_facts = 0, '', toString(toDateTime(intDiv(earliest_expiry_ns, 1000000000), 'UTC'))) AS earliest_fact_expires,
    toUInt8(imported_facts > 0 AND now() >= toDateTime(intDiv(earliest_expiry_ns, 1000000000), 'UTC')) AS deadline_passed,
    toUInt8(proxy_count = 0 AND pre_import_rows = 0 AND proxy_facts = 0 AND unbacked_buckets = 0
        AND unexplained_buckets = 0 AND deadline_passed = 0) AS pure
SQL
}

assert_pure() {
  local result
  result="$(query_row "$(purity_sql)")"
  echo "Purity ($1): $result"
  if [[ "$(jq -r '.deadline_passed' <<<"$result")" == "1" ]]; then
    echo "Refusing imported rollup repair: '$API_KEY' has imported facts past expiry ($(jq -r '.earliest_fact_expires' <<<"$result") UTC); the repair deadline has passed." >&2
    exit 1
  fi
  if [[ "$(jq -r '.pure' <<<"$result")" != "1" ]]; then
    echo "Refusing imported rollup repair: '$API_KEY' has proxy or unexplained rollup history." >&2
    if [[ "$(jq -r '.unexplained_buckets' <<<"$result")" != "0" ]]; then
      echo "Some rollup buckets have no retained imported facts from the same period. If the key's imported facts have expired, the repair deadline has passed." >&2
    fi
    exit 1
  fi
}

# Physical rows for the key: deletable imported-only rows, and rows a merge blended from both.
residue() {
  local grain parts=()
  for grain in "${GRAINS[@]}"; do
    parts+=("(SELECT toUInt32(countIf($IMPORTED_ROW)) FROM llm_usage_$grain WHERE ApiKey = $KEY) AS ${grain}_imported_rows")
    parts+=("(SELECT toUInt32(countIf($MIXED_ROW)) FROM llm_usage_$grain WHERE ApiKey = $KEY) AS ${grain}_mixed_rows")
  done
  local IFS=,
  query_row "SELECT ${parts[*]}, hourly_imported_rows + daily_imported_rows + monthly_imported_rows AS imported_rows,
    hourly_mixed_rows + daily_mixed_rows + monthly_mixed_rows AS mixed_rows"
}

assert_no_mixed_rows() {
  if [[ "$(jq -r '.mixed_rows' <<<"$after_residue")" != "0" ]]; then
    echo "Imported rollup repair partially repaired '$API_KEY': merged rows contain both sources, so their proxy data is kept and an imported estimate remains in them." >&2
    exit 1
  fi
}

# Finalized aggregates for every other key. Buckets that closed before the run must stay identical;
# still-open buckets may only grow from live ingest.
capture_others() {
  local grain
  for grain in "${GRAINS[@]}"; do
    curl -fsS -G "$TB_HOST/v0/sql" -H "Authorization: Bearer $TB_TOKEN" --data-urlencode "q=SELECT
        concat(ApiKey, '|', toString(BucketStart), '|', Provider, '|', Model, '|', OperationName, '|',
            BaggageOperation, '|', BaggageUserId, '|', StatusCode) AS bucket_group,
        BucketStart < $(period "$grain")(toDateTime('$RUN_STARTED_AT', 'UTC')) AS closed,
        countMerge(RequestCount) AS request_count,
        toString(tuple(
            sumMerge(InputTokens), sumMerge(UncachedInputTokens), sumMerge(OutputTokens),
            sumMerge(CacheReadInputTokens), sumMerge(CacheCreationInputTokens), sumMerge(ReasoningTokens),
            sumMerge(InputCostMicrodollars), sumMerge(OutputCostMicrodollars),
            sumMerge(CacheReadCostMicrodollars), sumMerge(CacheCreationCostMicrodollars),
            sumMerge(ReasoningCostMicrodollars), sumMerge(PromptBaselineCostMicrodollars),
            sumMerge(CacheImpactCostMicrodollars), sumMerge(UpstreamCostMicrodollars),
            sumMerge(TotalCostMicrodollars), maxMerge(MaxDurationNano), sumMerge(UnclassifiedTokens),
            sumMerge(UsageCompleteCount), sumMerge(UsageInconsistentCount),
            sumMerge(UsageUnclassifiedCount), sumMerge(UsageMissingCount), sumMerge(CostPricedCount),
            sumMerge(CostPartialCount), sumMerge(CostUnpricedCount), sumMerge(CostPricedTokens),
            sumMerge(CostProxyCount))) AS aggregates
      FROM llm_usage_$grain
      WHERE ApiKey != $KEY
      GROUP BY ApiKey, BucketStart, Provider, Model, OperationName, BaggageOperation, BaggageUserId, StatusCode
      ORDER BY bucket_group FORMAT JSON" | jq '.data' > "$1/$grain.json"
  done
}

assert_others_unchanged() {
  local grain verdict
  for grain in "${GRAINS[@]}"; do
    verdict="$(jq -cn --slurpfile before "$SNAPSHOT_DIR/before/$grain.json" \
      --slurpfile after "$SNAPSHOT_DIR/after/$grain.json" '
        def closed($rows): [$rows[] | select(.closed == 1 or .closed == true)];
        def counts($rows): reduce $rows[] as $row ({}; .[$row.bucket_group] = ($row.request_count | tonumber));
        counts($before[0]) as $b | counts($after[0]) as $a
        | {closed_groups: (closed($before[0]) | length),
           closed_equal: (closed($before[0]) == closed($after[0])),
           shrunk_groups: ([$b | to_entries[] | select(($a[.key] // -1) < .value)] | length)}')"
    echo "Other keys in llm_usage_$grain: $verdict"
    if [[ "$(jq -r '.closed_equal and .shrunk_groups == 0' <<<"$verdict")" != "true" ]]; then
      echo "Imported rollup repair changed other keys in llm_usage_$grain. Investigate before any further repair." >&2
      exit 1
    fi
  done
}

echo "Tinybird imported rollup repair target: $TARGET_WORKSPACE"
assert_workspace
assert_proxy_only_materializations

before_residue="$(residue)"
echo "Rows for '$API_KEY' (before): $before_residue"
if [[ "$(jq -r '.imported_rows' <<<"$before_residue")" == "0" ]]; then
  if [[ "$(jq -r '.mixed_rows' <<<"$before_residue")" != "0" ]]; then
    echo "Refusing imported rollup repair: '$API_KEY' has no imported-only rows, and its remaining rows blend proxy and imported data." >&2
    exit 1
  fi
  echo "No imported-only rollup rows remain for '$API_KEY'; nothing to delete."
  exit 0
fi

assert_pure "before"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry run: not deleting rollup rows for '$API_KEY'."
  exit 0
fi

SNAPSHOT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/trace-flow-imported-rollup-repair.XXXXXX")"
trap 'rm -rf "$SNAPSHOT_DIR"' EXIT
mkdir -p "$SNAPSHOT_DIR/before" "$SNAPSHOT_DIR/after"
RUN_STARTED_AT="$(query_row "SELECT toString(now('UTC')) AS now" | jq -r '.now')"
capture_others "$SNAPSHOT_DIR/before"

assert_workspace
assert_pure "before delete"
for grain in "${DELETE_ORDER[@]}"; do
  if [[ -n "$TEST_HOOK" ]]; then
    bash -c "$TEST_HOOK" repair-test-hook "$grain"
  fi
  assert_workspace
  # tb puts the token in request URLs it logs on connection errors.
  tb --cloud datasource delete "llm_usage_$grain" \
    --sql-condition "ApiKey = $KEY AND $IMPORTED_ROW" --wait --yes 2>&1 |
    sed -E 's/token=[^&[:space:]]+/token=REDACTED/g'
done

after_residue="$(residue)"
echo "Rows for '$API_KEY' (after): $after_residue"
if [[ "$(jq -r '.imported_rows' <<<"$after_residue")" != "0" ]]; then
  echo "Imported rollup repair left imported-only rollup rows for '$API_KEY'." >&2
  exit 1
fi
capture_others "$SNAPSHOT_DIR/after"
assert_others_unchanged
assert_no_mixed_rows
echo "Imported rollup repair complete for '$API_KEY'."
