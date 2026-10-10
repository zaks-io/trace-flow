#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
tb_path="$(command -v tb)"
tb_python="$(head -n 1 "$tb_path")"
tb_python="${tb_python#\#!}"
[[ -x "$tb_python" ]] || {
	echo 'Tinybird CLI runtime is unavailable' >&2
	exit 1
}
exec "$tb_python" scripts/bench/agent_snapshot_benchmark.py "$@"
