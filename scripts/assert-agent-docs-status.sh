#!/usr/bin/env bash
# Guard: the Agent Conversation Analytics docs must not claim the feature is production-ready while
# the production gates (P1-P5, TRA-109) are still open.
#
# The failure mode this guards against is documentation drift: a doc edit that flips "not
# production-ready" to an affirmative claim before the ingest/CLI/dashboard/CI/observability gates
# are actually green (exactly the pre-TRA-109 state, where a dev harness was described as shipped).
#
# A CI script can't introspect live multi-job gate status, so the gate is a single source-of-truth
# sentinel in ROADMAP.md: AGENT_ANALYTICS_PRODUCTION_READY. While it is `false`, affirmative
# "production-ready" assertions in the agent docs are forbidden. Negated or conditional phrasing
# ("not production-ready", "production-ready only when ...") is always allowed. When the feature
# actually ships, flip the sentinel to `true` and this guard stops forbidding the claim.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

DOCS_DIR="docs/guides/agent-conversation-analytics"
ROADMAP="${DOCS_DIR}/ROADMAP.md"

if [[ ! -f "$ROADMAP" ]]; then
  echo "ERROR: ${ROADMAP} not found." >&2
  exit 1
fi

# Single source of truth. Default to not-ready if the sentinel is missing, so deleting it can't
# silently disable the guard.
sentinel="$(grep -oE 'AGENT_ANALYTICS_PRODUCTION_READY:[[:space:]]*(true|false)' "$ROADMAP" | head -1 | awk -F: '{gsub(/[[:space:]]/,"",$2); print $2}')"
sentinel="${sentinel:-false}"

if [[ "$sentinel" == "true" ]]; then
  echo "Sentinel AGENT_ANALYTICS_PRODUCTION_READY=true; affirmative production-ready claims allowed."
  exit 0
fi

# Affirmative claim = a present-tense assertion ("is/are/now/fully/it's production-ready"). This is
# intentionally narrow so honest phrasing survives: a line is exonerated if it carries ANY negation
# or conditional qualifier (not / never / only / once / when / until / after / unless), or is an HTML
# comment (the sentinel's own machinery). English is too varied to match the negative cases by
# adjacency, so we flag the affirmative shape and then drop any line that is qualified anywhere.
affirmative='(^|[^[:alnum:]])(is|now|fully|are|it.?s)[[:space:]]+production[- ]ready([^[:alnum:]]|$)'
exonerated='(<!--|-->|[^[:alnum:]](not|never|isn.?t|aren.?t|only|once|when|until|after|unless)[^[:alnum:]])'

fail=0
while IFS= read -r -d '' file; do
  if matches="$(grep -inE "$affirmative" "$file")"; then
    filtered="$(grep -ivE "$exonerated" <<<"$matches" || true)"
    if [[ -n "$filtered" ]]; then
      echo "ERROR: ${file} asserts the feature is production-ready while AGENT_ANALYTICS_PRODUCTION_READY=false:" >&2
      awk '{print "  " $0}' <<<"$filtered" >&2
      fail=1
    fi
  fi
done < <(find "$DOCS_DIR" -name '*.md' -print0)

if [[ "$fail" -ne 0 ]]; then
  echo >&2
  echo "Either reword to negated/conditional phrasing, or flip the sentinel in ${ROADMAP} once the" >&2
  echo "P1-P5 production gates (TRA-109) are actually green." >&2
  exit 1
fi

echo "Agent analytics docs make no premature production-ready claim (sentinel=false)."
