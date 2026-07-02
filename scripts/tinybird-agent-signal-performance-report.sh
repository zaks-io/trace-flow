#!/usr/bin/env bash
set -euo pipefail

scope="${1:---local}"
if [[ "$scope" != "--local" && "$scope" != "--cloud" ]]; then
  echo "Usage: $0 [--local|--cloud]" >&2
  exit 2
fi

export CI="${CI:-1}"
export TB_VERSION_WARNING="${TB_VERSION_WARNING:-0}"

tmp_output="$(mktemp "${TMPDIR:-/tmp}/trace-flow-agent-signal-perf.XXXXXX")"
trap 'rm -f "$tmp_output"' EXIT

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

run_probe() {
  local family="$1"
  local pipe="$2"
  local test_name="$3"
  local started_at
  local finished_at

  started_at="$(now_ms)"
  tb "$scope" test run "$test_name" >"$tmp_output" 2>&1 || {
    cat "$tmp_output" >&2
    echo "agent-signal-perf family=\"$family\" pipe=$pipe test=$test_name status=failed" >&2
    exit 1
  }
  finished_at="$(now_ms)"

  echo "agent-signal-perf family=\"$family\" pipe=$pipe test=$test_name elapsed_ms=$((finished_at - started_at)) status=passed"
}

run_probe "session risk" "agent_sessions_browser" "agent_sessions_browser"
run_probe "file hotspots" "agent_file_attention_top_files" "agent_file_attention_top_files"
run_probe "tool failures" "agent_failure_leaderboard" "agent_failure_leaderboard"
run_probe "repo baselines" "agent_notable_changes" "agent_notable_changes"
