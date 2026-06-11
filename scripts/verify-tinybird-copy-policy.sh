#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-.}"
cd "$ROOT_DIR"

failed=0

fail() {
  printf 'Tinybird copy policy failed: %s\n' "$1" >&2
  failed=1
}

declare -a roots=()
for root in datasources materializations pipes copies; do
  if [[ -d "$root" ]]; then
    roots+=("$root")
  fi
done

while IFS= read -r -d '' file; do
  is_copy=0
  has_schedule=0
  has_replace=0

  if grep -Eq '^TYPE[[:space:]]+COPY([[:space:]]|$)' "$file"; then
    is_copy=1
  fi
  if grep -Eq '^COPY_SCHEDULE([[:space:]]|$)' "$file"; then
    has_schedule=1
  fi
  if grep -Eq '^COPY_MODE[[:space:]]+replace([[:space:]]|$)' "$file"; then
    has_replace=1
  fi

  if [[ "$has_schedule" -eq 1 && "$has_replace" -eq 1 ]]; then
    fail "scheduled COPY_MODE replace is not allowed: $file"
  fi

  if [[ "$is_copy" -eq 1 ]]; then
    if [[ "$file" != copies/repair_*.pipe ]]; then
      fail "copy pipes must live under copies/ with a repair_* name: $file"
    fi
    if [[ "$has_schedule" -eq 1 ]]; then
      fail "repair copy pipes must be unscheduled: $file"
    fi
  elif [[ "$has_schedule" -eq 1 || "$has_replace" -eq 1 ]]; then
    fail "COPY_SCHEDULE/COPY_MODE replace directives are only allowed in unscheduled repair copy pipes: $file"
  fi
done < <(find materializations pipes copies -type f -name '*.pipe' -print0 2>/dev/null || true)

if [[ "${#roots[@]}" -gt 0 ]]; then
  copy_names="$(
    find "${roots[@]}" -type f -name '*_copy.*' -print
  )"
  if [[ -n "$copy_names" ]]; then
    fail "copy resources must use unscheduled copies/repair_* names:
$copy_names"
  fi
fi

if [[ -d copies ]]; then
  if [[ ! -f tinybird.config.json ]]; then
    fail "copies/ exists but tinybird.config.json is missing"
  elif ! jq -e '.include | index("copies")' tinybird.config.json >/dev/null; then
    fail 'copies/ exists but tinybird.config.json does not include "copies"'
  fi
fi

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

printf 'Tinybird copy policy passed\n'
