#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
source "$(dirname "${BASH_SOURCE[0]}")/_tinybird.sh"

write_local_runtime_files() {
  ensure_tinybird_tokens

  write_runtime_file "$TRACE_FLOW_ROOT/apps/proxy/.dev.vars" <<EOF
CONVEX_SITE_URL=$TRACE_FLOW_CONVEX_SITE_URL
USAGE_SYNC_SECRET=$TRACE_FLOW_USAGE_SYNC_SECRET
BODY_ENCRYPTION_ROOT_KEY=$TRACE_FLOW_BODY_ENCRYPTION_ROOT_KEY
BODY_ENCRYPTION_KEY_ID=v1
AXIOM_TOKEN=
SENTRY_DSN=
EOF

  write_runtime_file "$TRACE_FLOW_ROOT/apps/proxy-consumer/.dev.vars" <<EOF
TINYBIRD_TOKEN=$TB_LOCAL_WORKSPACE_TOKEN
TINYBIRD_DATASOURCE=otel_trace_spans
TINYBIRD_HOST=$TRACE_FLOW_TINYBIRD_HOST
AXIOM_TOKEN=
SENTRY_DSN=
EOF

  write_runtime_file "$TRACE_FLOW_ROOT/apps/api/.dev.vars" <<EOF
CONVEX_SITE_URL=$TRACE_FLOW_CONVEX_SITE_URL
BODY_ENCRYPTION_ROOT_KEY=$TRACE_FLOW_BODY_ENCRYPTION_ROOT_KEY
BODY_ENCRYPTION_KEY_ID=v1
BODY_ACCESS_JWT_SECRET=$TRACE_FLOW_BODY_ACCESS_JWT_SECRET
AXIOM_TOKEN=
SENTRY_DSN=
EOF

  write_runtime_file "$TRACE_FLOW_ROOT/apps/pipes-api/.dev.vars" <<EOF
TINYBIRD_API_URL=$TRACE_FLOW_TINYBIRD_HOST
CONVEX_SITE_URL=$TRACE_FLOW_CONVEX_SITE_URL
PIPES_API_SHARED_SECRET=$TRACE_FLOW_USAGE_SYNC_SECRET
AXIOM_TOKEN=
SENTRY_DSN=
EOF

  write_runtime_file "$TRACE_FLOW_ROOT/apps/agent-ingest/.dev.vars" <<EOF
CONVEX_SITE_URL=$TRACE_FLOW_CONVEX_SITE_URL
AGENT_INGEST_SHARED_SECRET=$TRACE_FLOW_AGENT_INGEST_SHARED_SECRET
SENTRY_DSN=
EOF

  write_runtime_file "$TRACE_FLOW_ROOT/apps/agent-consumer/.dev.vars" <<EOF
TINYBIRD_TOKEN=$TB_LOCAL_WORKSPACE_TOKEN
TINYBIRD_HOST=$TRACE_FLOW_TINYBIRD_HOST
SENTRY_DSN=
EOF

  write_runtime_file "$TRACE_FLOW_ROOT/apps/web/.env.local" <<EOF
NEXT_PUBLIC_CONVEX_URL=$TRACE_FLOW_CONVEX_URL
NEXT_PUBLIC_API_URL=$TRACE_FLOW_API_URL
NEXT_PUBLIC_PIPES_API_URL=$TRACE_FLOW_PIPES_API_URL
NEXT_PUBLIC_RAW_API_URL=$TRACE_FLOW_RAW_API_URL
NEXT_PUBLIC_TINYBIRD_API_URL=$TRACE_FLOW_TINYBIRD_HOST
NEXT_PUBLIC_AUTH0_DOMAIN=test.auth0.com
NEXT_PUBLIC_AUTH0_CLIENT_ID=test-client-id
AUTH0_SECRET=$TRACE_FLOW_AUTH0_SECRET
AUTH0_CLIENT_SECRET=test-client-secret
APP_BASE_URL=$TRACE_FLOW_WEB_URL
EOF

  if [[ "${TRACE_FLOW_SKIP_TINYBIRD:-0}" != "1" ]]; then
    sync_tinybird_runtime_vars
  fi

  sync_runtime_env_var "$TRACE_FLOW_ROOT/apps/web/.env.local" \
    NEXT_PUBLIC_PIPES_API_URL "$TRACE_FLOW_PIPES_API_URL"
  sync_runtime_env_var "$TRACE_FLOW_ROOT/apps/web/.env.local" \
    NEXT_PUBLIC_RAW_API_URL "$TRACE_FLOW_RAW_API_URL"
  sync_runtime_env_var "$TRACE_FLOW_ROOT/apps/api/.dev.vars" \
    BODY_ACCESS_JWT_SECRET "$TRACE_FLOW_BODY_ACCESS_JWT_SECRET"
}

sync_tinybird_runtime_vars() {
  sync_runtime_env_var "$TRACE_FLOW_ROOT/apps/proxy-consumer/.dev.vars" \
    TINYBIRD_TOKEN "$TB_LOCAL_WORKSPACE_TOKEN"
  sync_runtime_env_var "$TRACE_FLOW_ROOT/apps/proxy-consumer/.dev.vars" \
    TINYBIRD_HOST "$TRACE_FLOW_TINYBIRD_HOST"

  sync_runtime_env_var "$TRACE_FLOW_ROOT/apps/pipes-api/.dev.vars" \
    TINYBIRD_API_URL "$TRACE_FLOW_TINYBIRD_HOST"

  sync_runtime_env_var "$TRACE_FLOW_ROOT/apps/agent-consumer/.dev.vars" \
    TINYBIRD_TOKEN "$TB_LOCAL_WORKSPACE_TOKEN"
  sync_runtime_env_var "$TRACE_FLOW_ROOT/apps/agent-consumer/.dev.vars" \
    TINYBIRD_HOST "$TRACE_FLOW_TINYBIRD_HOST"

  sync_runtime_env_var "$TRACE_FLOW_ROOT/apps/web/.env.local" \
    NEXT_PUBLIC_TINYBIRD_API_URL "$TRACE_FLOW_TINYBIRD_HOST"
}

cd "$TRACE_FLOW_ROOT"
write_local_runtime_files
start_tinybird_local

log "local environment is prepared"
log "run scripts/dev/convex.sh, scripts/dev/workers.sh, and scripts/dev/web.sh in separate terminals"
