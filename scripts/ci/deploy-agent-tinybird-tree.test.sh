#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT
cat > "$TEST_DIR/tb" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_CALLS"
case "$*" in
  '--cloud --output json deploy --check')
    printf '%s\n' "$TEST_RESULT"
    exit "$TEST_CHECK_STATUS"
    ;;
  '--cloud --output json deploy --check --allow-destructive-operations')
    printf '%s\n' "${TEST_RECHECK_RESULT:-$TEST_RESULT}"
    exit "${TEST_RECHECK_STATUS:-0}"
    ;;
  '--cloud deploy --allow-destructive-operations')
    [[ "$EXPECT_DESTRUCTIVE" == 1 ]]
    touch "$TEST_MARKER"
    ;;
  '--cloud deploy')
    [[ "$EXPECT_DESTRUCTIVE" == 0 ]]
    touch "$TEST_MARKER"
    ;;
  *) echo "Unexpected tb call: $*" >&2; exit 1 ;;
esac
FAKE
chmod +x "$TEST_DIR/tb"
cd "$ROOT_DIR"
run_deploy() {
  rm -f "$TEST_DIR/applied" "$TEST_DIR/calls"
  PATH="$TEST_DIR:$PATH" TB_TARGET_WORKSPACE="${TEST_WORKSPACE:-trace_flow_prod}" TB_SKIP_BUILD=1 \
    TEST_MARKER="$TEST_DIR/applied" TEST_CALLS="$TEST_DIR/calls" TEST_RESULT="$1" \
    EXPECT_DESTRUCTIVE="$2" TEST_CHECK_STATUS="$3" \
    bash scripts/deploy-agent-tinybird.sh "${@:4}" >"$TEST_DIR/output" 2>&1
}
retired='{"deleted_datasource_names":["agent_messages"],"deleted_pipe_names":[],"deleted_data_connector_names":[],"token_changes":[]}'
clean='{"deleted_datasource_names":[],"deleted_pipe_names":[],"deleted_data_connector_names":[],"token_changes":[]}'
unlisted='{"deleted_datasource_names":["agent_messages","agent_message_fact_versions"],"deleted_pipe_names":[],"deleted_data_connector_names":[],"token_changes":[]}'
for TEST_WORKSPACE in trace_flow_prod trace_flow_dev; do
  export TEST_WORKSPACE
  run_deploy "$retired" 1 1
  test -f "$TEST_DIR/applied"
  test "$(wc -l < "$TEST_DIR/calls")" -eq 3
  run_deploy "$clean" 0 0
  test -f "$TEST_DIR/applied"
  if rg -q -- '--allow-destructive-operations' "$TEST_DIR/calls"; then exit 1; fi
  run_deploy "$retired" 1 1 --check
  test ! -f "$TEST_DIR/applied"
  test "$(wc -l < "$TEST_DIR/calls")" -eq 2
  for mode in apply check; do
    args=()
    if [[ "$mode" == check ]]; then args=(--check); fi
    if run_deploy "$unlisted" 1 1 "${args[@]}"; then
      echo 'Unlisted deletion was allowed' >&2; exit 1
    fi
    test ! -f "$TEST_DIR/applied"
    rg -q 'agent_message_fact_versions' "$TEST_DIR/output"
    test "$(wc -l < "$TEST_DIR/calls")" -eq 1
  done
  if run_deploy "$clean" 0 1; then echo 'Failed check was ignored' >&2; exit 1; fi
  test ! -f "$TEST_DIR/applied"
  if TEST_RECHECK_STATUS=1 run_deploy "$retired" 1 1; then
    echo 'Failed flagged validation was ignored' >&2; exit 1
  fi
  test ! -f "$TEST_DIR/applied"
  if TEST_RECHECK_RESULT="$unlisted" run_deploy "$retired" 1 1; then
    echo 'Changed deletion inventory was ignored' >&2; exit 1
  fi
  test ! -f "$TEST_DIR/applied"
done
echo 'Tinybird manifest guard passed for PR checks and direct deployment'
