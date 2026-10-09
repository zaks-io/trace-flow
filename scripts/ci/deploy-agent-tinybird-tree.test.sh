#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT
cat > "$TEST_DIR/tb" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "--cloud --output json deploy --check --allow-destructive-operations" ]]; then
  printf '%s\n' "$TEST_RESULT"
elif [[ "$*" == "--cloud deploy --allow-destructive-operations" ]]; then
  [[ "$EXPECT_DESTRUCTIVE" == "1" ]]
  if [[ "$EXPECT_DESTRUCTIVE" == "1" && "$TINYBIRD_CLEANUP_APPROVED" == "trace_flow_prod_20261009" ]]; then test -f "$TEST_MARKER.receipt"; fi
  touch "$TEST_MARKER"
elif [[ "$*" == "--cloud deploy" ]]; then
  [[ "$EXPECT_DESTRUCTIVE" == "0" ]]
  if [[ "$EXPECT_DESTRUCTIVE" == "1" && "$TINYBIRD_CLEANUP_APPROVED" == "trace_flow_prod_20261009" ]]; then test -f "$TEST_MARKER.receipt"; fi
  touch "$TEST_MARKER"
else
  echo "Unexpected tb call: $*" >&2
  exit 1
fi
FAKE
chmod +x "$TEST_DIR/tb"
REAL_NODE="$(command -v node)"
export REAL_NODE
cat > "$TEST_DIR/node" <<'FAKE_NODE'
#!/usr/bin/env bash
if [[ "$1" == */tinybird-cleanup-receipt.mjs ]]; then
  if [[ "$2" == consume ]]; then
    [[ "${TEST_RECEIPT_FAIL:-0}" == "0" ]] || exit 1
    touch "$TEST_MARKER.receipt"
    echo 42
  fi
  if [[ "$2" == check ]]; then printf '%s\n' "${TEST_CONSUMED:-false}"; fi
else
  exec "$REAL_NODE" "$@"
fi
FAKE_NODE
chmod +x "$TEST_DIR/node"
cd "$ROOT_DIR"
run_deploy() {
  PATH="$TEST_DIR:$PATH" TB_TARGET_WORKSPACE=trace_flow_prod TB_SKIP_BUILD=1 \
    TEST_MARKER="$TEST_DIR/applied" TEST_RESULT="$1" EXPECT_DESTRUCTIVE="$2" \
    TINYBIRD_CLEANUP_APPROVED="$3" bash scripts/deploy-agent-tinybird.sh >/dev/null 2>&1
}
initial='{"deleted_datasource_names":["agent_messages"],"deleted_pipe_names":[],"deleted_data_connector_names":[]}'
clean='{"deleted_datasource_names":[],"deleted_pipe_names":[],"deleted_data_connector_names":[]}'
later='{"deleted_datasource_names":["agent_message_fact_versions"],"deleted_pipe_names":[],"deleted_data_connector_names":[]}'
run_deploy "$initial" 1 trace_flow_prod_20261009
test -f "$TEST_DIR/applied"
rm "$TEST_DIR/applied"
run_deploy "$clean" 0 trace_flow_prod_20261009
test -f "$TEST_DIR/applied"
rm "$TEST_DIR/applied"
if run_deploy "$later" 1 trace_flow_prod_20261009; then
  echo 'Reused approval allowed a later destructive deploy' >&2; exit 1
fi
test ! -f "$TEST_DIR/applied"
if run_deploy "$initial" 1 ''; then
  echo 'Unapproved destructive deploy was allowed' >&2; exit 1
fi
test ! -f "$TEST_DIR/applied"
echo 'Tinybird direct deploy and approval gates passed'

rm -f "$TEST_DIR/applied"
if TEST_CONSUMED=true run_deploy "$initial" 1 trace_flow_prod_20261009; then
  echo 'Consumed approval was reused for a restored retired resource' >&2; exit 1
fi
test ! -f "$TEST_DIR/applied"

if TEST_RECEIPT_FAIL=1 run_deploy "$initial" 1 trace_flow_prod_20261009; then
  echo 'Cleanup applied without durable approval consumption' >&2; exit 1
fi
test ! -f "$TEST_DIR/applied"
