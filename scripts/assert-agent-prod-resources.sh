#!/usr/bin/env bash
# Guard: fail if the production agent Workers would deploy dev-named resources.
#
# TRA-110 makes the agent ingest/consumer pipeline production-real. The failure mode this guards
# against is a Production deploy that silently binds dev queues/KV/worker names or the dev rate-limit
# namespace — exactly the pre-TRA-110 state (flat dev config deployed from the Production workflow).
#
# It renders each Worker's *resolved* production config via `wrangler deploy --env production
# --dry-run` and asserts the output contains no forbidden dev tokens. Rendering (not grepping the
# source file) is deliberate: it also catches env-inheritance mistakes where a top-level dev binding
# leaks into the named environment.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Tokens that must never appear in a resolved production agent Worker config:
#   *-dev resource names, the dev rate-limit namespace 2006 (prod uses 2007), and the dev KV
#   namespace IDs (COLLECTOR_CREDS f945ee3d…, MODEL_PRICING 25a35f…) — catches a prod env block that
#   accidentally inherited a top-level dev binding.
FORBIDDEN='agent-ingest-dev|agent-ingest-dlq-dev|trace-flow-agent-ingest-dev|trace-flow-agent-consumer-dev|"?2006"?|25a35f71a8d64884a8e8935056880dba|f945ee3d71954ffabd364e3db385d3ab'

fail=0

check_worker() {
  local app="$1"
  echo "Checking apps/${app} production config ..."
  local rendered
  rendered="$(cd "apps/${app}" && bunx wrangler deploy --env production --dry-run 2>&1)"

  if grep -nEi "${FORBIDDEN}" <<<"${rendered}"; then
    echo "ERROR: apps/${app} production deploy references a dev resource (see matches above)." >&2
    fail=1
  else
    echo "  ok: no dev resources in apps/${app} production config"
  fi
}

check_worker agent-ingest
check_worker agent-consumer

if [[ "${fail}" -ne 0 ]]; then
  echo "Production agent Worker config is bound to dev resources. Refusing to deploy." >&2
  exit 1
fi

echo "Production agent Worker configs are clean (no dev resources)."
