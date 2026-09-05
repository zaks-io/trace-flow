#!/usr/bin/env bash
# Production smoke test for the Agent Conversation Analytics cloud ingest path.
#
# Runs scripts/agent-ingest-smoke.mjs under bun (the script imports the Worker's TS surrogate-key
# derivation, so it must run under bun, not node). The credential and org JWT must come from the real
# authenticated control plane — see docs/guides/agent-conversation-analytics/runbook.md#smoke-envelope.
#
# Required env (see the .mjs header for the full list):
#   TRACE_FLOW_INGEST_URL, TRACE_FLOW_SMOKE_COLLECTOR_SECRET, TRACE_FLOW_SMOKE_ORG_JWT,
#   TRACE_FLOW_TINYBIRD_HOST
# Queue-depth checks use CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID from the environment.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

exec bun scripts/agent-ingest-smoke.mjs "$@"
