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
