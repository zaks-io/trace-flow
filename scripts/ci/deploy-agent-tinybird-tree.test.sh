#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CURRENT_REF="844d8f0313af18ac73ad60bdbe7f81dc3d8f019d"
LEGACY_REF="11613a4619444adb0e27abc3df958cebb43cc280"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/trace-flow-deploy-tree-test.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT

cat > "$TEST_DIR/tb" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$*" != "--cloud deploy --check" ]]; then
  echo "Unexpected fake tb invocation: $*" >&2
  exit 1
fi

assert_ref_file() {
  local ref="$1"
  local path="$2"
  cmp -s <(git -C "$TEST_ROOT" show "$ref:$path") "$PWD/$path" || {
    echo "Generated tree did not preserve $path from $ref" >&2
    exit 1
  }
}

assert_ref_file_with_append_token() {
  local ref="$1"
  local path="$2"
  local directive="TOKEN trace_flow_agent_facts_append APPEND"
  [[ "$(grep -Fxc "$directive" "$PWD/$path")" == "1" ]] || {
    echo "Generated tree did not declare the exact append token in $path" >&2
    exit 1
  }
  if git -C "$TEST_ROOT" show "$ref:$path" | grep -Fxq "$directive"; then
    assert_ref_file "$ref" "$path"
    return
  fi
  cmp -s <(git -C "$TEST_ROOT" show "$ref:$path") <(grep -Fvx "$directive" "$PWD/$path") || {
    echo "Generated tree changed preserved schema while adding a token to $path" >&2
    exit 1
  }
}

assert_repo_file() {
  local path="$1"
  cmp -s "$TEST_ROOT/$path" "$PWD/$path" || {
    echo "Generated tree did not preserve repo definition $path" >&2
    exit 1
  }
}

assert_ref_file_with_append_token "$LEGACY_REF" datasources/agent_messages.datasource
assert_ref_file "$LEGACY_REF" datasources/otel_traces.datasource
assert_ref_file "$LEGACY_REF" pipes/llm_requests_mv.pipe
[[ ! -e pipes/agent_sessions_copy.pipe ]] || {
  echo "Generated tree retained a scheduled legacy Copy pipe" >&2
  exit 1
}

if [[ "$TEST_PHASE" == "expand" ]]; then
  assert_ref_file "$CURRENT_REF" pipes/agent_usage_summary.pipe
  assert_ref_file_with_append_token "$CURRENT_REF" datasources/agent_message_facts.datasource
else
  assert_repo_file pipes/agent_usage_summary.pipe
  assert_repo_file datasources/agent_message_facts.datasource
fi

assert_repo_file pipes/agent_delivery_receipt.pipe
assert_repo_file pipes/agent_snapshot_job.pipe
node "$TEST_ROOT/scripts/ci/configure-agent-tinybird-tokens.mjs" --validate-datafiles "$PWD" >/dev/null

touch "$TEST_MARKER"
EOF
chmod +x "$TEST_DIR/tb"

run_phase() {
  local phase="$1"
  local current_ref="${2:-$CURRENT_REF}"
  local marker="$TEST_DIR/${3:-$phase}.passed"
  PATH="$TEST_DIR:$PATH" \
    TEST_ROOT="$ROOT_DIR" \
    TEST_PHASE="$phase" \
    TEST_MARKER="$marker" \
    CURRENT_REF="$current_ref" \
    LEGACY_REF="$LEGACY_REF" \
    TB_TOKEN=test-only \
    TB_SKIP_BUILD=1 \
    TB_TARGET_WORKSPACE=trace_flow_prod \
    TINYBIRD_DEPLOY_PHASE="$phase" \
    TINYBIRD_CURRENT_REF="$current_ref" \
    TINYBIRD_LEGACY_REF="$LEGACY_REF" \
    bash "$ROOT_DIR/scripts/deploy-agent-tinybird.sh" --check >/dev/null
  [[ -f "$marker" ]] || {
    echo "Fake Tinybird check did not inspect the $phase tree" >&2
    exit 1
  }
}

cd "$ROOT_DIR"

set +e
incomplete_output="$(
  TB_TARGET_WORKSPACE=trace_flow_prod \
    TINYBIRD_DEPLOY_PHASE=expand \
    TINYBIRD_CURRENT_REF="$CURRENT_REF" \
    TINYBIRD_LEGACY_REF="$CURRENT_REF" \
    TINYBIRD_VALIDATE_DEPLOY_TREE_ONLY=1 \
    bash "$ROOT_DIR/scripts/deploy-agent-tinybird.sh" 2>&1
)"
incomplete_exit_code=$?
set -e
if [[ "$incomplete_exit_code" -eq 0 || "$incomplete_output" != *"does not contain required legacy Tinybird files"* ]]; then
  echo "Incomplete legacy inventory was not rejected" >&2
  exit 1
fi

run_phase expand
run_phase switch
run_phase expand HEAD expand-with-declared-tokens

echo "Tinybird deploy tree preservation passed (expand, repeat expand, and switch)"
