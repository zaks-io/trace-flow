#!/usr/bin/env bash
set -euo pipefail

tb_path="$(command -v tb)"
tb_python="$(head -n 1 "$tb_path")"
tb_python="${tb_python#\#!}"

if [[ ! -x "$tb_python" ]]; then
  echo "Tinybird CLI Python runtime is unavailable" >&2
  exit 1
fi

exec "$tb_python" scripts/ci/tinybird-local-fixture-tests.py "$@"
