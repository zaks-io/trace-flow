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

check "published SQL must not use FINAL" \
  rg -n '\bFINAL\b' materializations pipes

check "Tinybird datasources must not use ReplacingMergeTree" \
  rg -n 'ENGINE "ReplacingMergeTree"' datasources

bash scripts/verify-tinybird-copy-policy.sh

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

printf 'Tinybird cost contract passed\n'
