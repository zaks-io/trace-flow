#!/usr/bin/env bash
# Disposable Self-Contained Local stack with mock sign-in (the "local stack").
#
#   scripts/dev/local-stack.sh up               start everything and print URLs
#   scripts/dev/local-stack.sh status           show processes and URLs
#   scripts/dev/local-stack.sh login-url EMAIL  print a one-step sign-in URL
#   scripts/dev/local-stack.sh seed [EMAIL]     load fixture data for a signed-in user's org
#   scripts/dev/local-stack.sh logs NAME        follow a service log
#   scripts/dev/local-stack.sh down [--purge]   stop everything; --purge also deletes all data,
#                                               including Tinybird Local data shared with start.sh
#
# A mock OIDC issuer (mock-oidc.ts) replaces Auth0, Convex runs as a self-hosted
# Docker backend, Tinybird Local holds analytics data, and a KV bridge Worker
# (kv-bridge.ts) receives Convex's KV syncs. Every generated value lives under
# .trace-flow/local-stack/; linked .env.local and .dev.vars files are never written,
# and their values never reach the stack. Names and ports are fixed, so one stack
# runs per Docker engine.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
source "$(dirname "${BASH_SOURCE[0]}")/_tinybird.sh"

STACK_DIR="${TRACE_FLOW_LOCAL_STACK_DIR:-$TRACE_FLOW_STATE_DIR/local-stack}"
STACK_LOG_DIR="$STACK_DIR/logs"
STACK_PID_DIR="$STACK_DIR/pids"
STACK_SECRETS="$STACK_DIR/secrets.env"
STACK_CONVEX_CLI_DIR="$STACK_DIR/convex-cli"

WEB_PORT="${TRACE_FLOW_LOCAL_STACK_WEB_PORT:-3000}"
PROXY_PORT="${TRACE_FLOW_LOCAL_STACK_PROXY_PORT:-8787}"
PIPES_PORT="${TRACE_FLOW_LOCAL_STACK_PIPES_PORT:-8788}"
RAW_API_PORT="${TRACE_FLOW_LOCAL_STACK_RAW_API_PORT:-8789}"
AGENT_INGEST_PORT="${TRACE_FLOW_LOCAL_STACK_AGENT_INGEST_PORT:-8790}"
KV_BRIDGE_PORT="${TRACE_FLOW_LOCAL_STACK_KV_BRIDGE_PORT:-8791}"
CONVEX_PORT="${TRACE_FLOW_LOCAL_STACK_CONVEX_PORT:-3210}"
CONVEX_SITE_PORT="${TRACE_FLOW_LOCAL_STACK_CONVEX_SITE_PORT:-3211}"
OIDC_PORT="${TRACE_FLOW_LOCAL_STACK_OIDC_PORT:-3230}"

CONVEX_IMAGE="${TRACE_FLOW_LOCAL_STACK_CONVEX_IMAGE:-ghcr.io/get-convex/convex-backend:latest}"
CONVEX_CONTAINER="trace-flow-local-convex"
CONVEX_VOLUME="trace-flow-local-convex"
DOCKER_NETWORK="trace-flow-local"
OIDC_CLIENT_ID="trace-flow-local"
DEFAULT_EMAIL="${TRACE_FLOW_LOCAL_STACK_EMAIL:-dev@trace-flow.local}"

# Local KV is keyed by namespace id, so Convex must name the ids the Workers bind
# outside named environments. start_workers checks these against the configs.
API_KEYS_KV_ID="30c9a31ff3af4b408b4d64b8ecfa98a5"
COLLECTOR_CREDS_KV_ID="f945ee3d71954ffabd364e3db385d3ab"
MODEL_PRICING_KV_ID="25a35f71a8d64884a8e8935056880dba"

# Reviewers open the stack from other machines, so public URLs use the tailnet
# name when one exists. Server-to-server calls stay on loopback.
detect_public_host() {
  if [[ -n "${TRACE_FLOW_LOCAL_STACK_HOST:-}" ]]; then
    printf '%s' "$TRACE_FLOW_LOCAL_STACK_HOST"
    return
  fi
  local dns_name=""
  if command_exists tailscale; then
    dns_name="$(tailscale status --self --json 2>/dev/null | json_expr "(data.Self?.DNSName ?? '').replace(/\\.\$/, '')" || true)"
  fi
  printf '%s' "${dns_name:-127.0.0.1}"
}

PUBLIC_HOST="$(detect_public_host)"
WEB_URL="http://$PUBLIC_HOST:$WEB_PORT"
PROXY_URL="http://$PUBLIC_HOST:$PROXY_PORT"
PIPES_URL="http://$PUBLIC_HOST:$PIPES_PORT"
RAW_API_URL="http://$PUBLIC_HOST:$RAW_API_PORT"
AGENT_INGEST_URL="http://$PUBLIC_HOST:$AGENT_INGEST_PORT"
CONVEX_URL="http://$PUBLIC_HOST:$CONVEX_PORT"
CONVEX_SITE_URL="http://$PUBLIC_HOST:$CONVEX_SITE_PORT"
OIDC_ISSUER="http://$PUBLIC_HOST:$OIDC_PORT/"
LOCAL_CONVEX_URL="http://127.0.0.1:$CONVEX_PORT"
LOCAL_CONVEX_SITE_URL="http://127.0.0.1:$CONVEX_SITE_PORT"

random_hex() {
  od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
}

# A secret added to this list later is appended to an existing stack's file.
ensure_secret() {
  grep -q "^$1=" "$STACK_SECRETS" || printf '%s=%s\n' "$1" "$2" >>"$STACK_SECRETS"
}

ensure_secrets() {
  mkdir -p "$STACK_DIR"
  # Every generated secret file lives below this directory, so none is readable
  # by other users even before its own chmod.
  chmod 700 "$STACK_DIR"
  touch "$STACK_SECRETS"
  chmod 600 "$STACK_SECRETS"
  ensure_secret AUTH0_SECRET "$(random_hex 32)"
  ensure_secret OIDC_CLIENT_SECRET "$(random_hex 24)"
  ensure_secret CONVEX_INSTANCE_SECRET "$(random_hex 32)"
  ensure_secret PIPES_API_SHARED_SECRET "$(random_hex 24)"
  ensure_secret USAGE_SYNC_SECRET "$(random_hex 24)"
  ensure_secret AGENT_INGEST_SHARED_SECRET "$(random_hex 24)"
  ensure_secret BODY_ACCESS_JWT_SECRET "$(random_hex 32)"
  ensure_secret BODY_ENCRYPTION_ROOT_KEY "$(head -c 32 /dev/urandom | base64)"
  ensure_secret MCP_JWT_SECRET "$(random_hex 32)"
  ensure_secret MCP_BACKEND_SHARED_SECRET "$(random_hex 24)"
  ensure_secret KV_BRIDGE_TOKEN "$(random_hex 24)"
  set -a
  # shellcheck disable=SC1090
  source "$STACK_SECRETS"
  set +a
}

wait_for_http() {
  local name="$1" url="$2" timeout="${3:-120}"
  local deadline=$((SECONDS + timeout))
  until curl -s -o /dev/null "$url"; do
    if ((SECONDS > deadline)); then
      fail "$name did not respond at $url within ${timeout}s (see $STACK_LOG_DIR/$name.log)"
    fi
    if [[ -f "$STACK_PID_DIR/$name.pid" ]] && ! kill -0 "$(cat "$STACK_PID_DIR/$name.pid")" 2>/dev/null; then
      tail -n 40 "$STACK_LOG_DIR/$name.log" >&2 || true
      fail "$name exited during startup (see $STACK_LOG_DIR/$name.log)"
    fi
    sleep 1
  done
}

# Another server on a stack port would answer the health checks, so `up` would
# report success with URLs that reach someone else's app.
require_free_port() {
  if (exec 3<>"/dev/tcp/127.0.0.1/$2") 2>/dev/null; then
    fail "port $2 for $1 is already in use; stop that server or set TRACE_FLOW_LOCAL_STACK_*_PORT"
  fi
}

process_running() {
  local pid_file="$STACK_PID_DIR/$1.pid"
  [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

# Each service runs in its own session so `down` can stop its whole process tree.
start_process() {
  local name="$1"
  shift
  mkdir -p "$STACK_LOG_DIR" "$STACK_PID_DIR"
  if process_running "$name"; then
    log "$name is already running"
    return 0
  fi
  log "starting $name"
  setsid nohup "$@" >"$STACK_LOG_DIR/$name.log" 2>&1 </dev/null &
  echo "$!" >"$STACK_PID_DIR/$name.pid"
}

stop_process() {
  local name="$1" pid_file="$STACK_PID_DIR/$1.pid"
  [[ -f "$pid_file" ]] || return 0
  local pid
  pid="$(cat "$pid_file")"
  # A crashed leader can leave children such as workerd holding a port.
  if kill -0 -- "-$pid" 2>/dev/null; then
    log "stopping $name"
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 -- "-$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

# The project deploys to a workspace named after a hash of the project path, not
# the default workspace behind `tb local`'s tokens. Convex signs read JWTs and
# the consumers write spans with that workspace's own admin token.
resolve_tinybird_project_workspace() {
  local admin_token workspace_name workspace
  admin_token="$(curl -sf "$TRACE_FLOW_TINYBIRD_HOST/tokens" | json_expr "data.admin_token ?? ''")"
  workspace_name="Tinybird_Local_Build_$(printf '%s' "$TRACE_FLOW_ROOT" | sha256sum | cut -d' ' -f1)"
  workspace="$(curl -sf "$TRACE_FLOW_TINYBIRD_HOST/v1/user/workspaces?with_organization=true&token=$admin_token" |
    json_expr "JSON.stringify(data.workspaces.find((w) => w.name === '$workspace_name') ?? {})")"
  local member_token
  member_token="$(printf '%s' "$workspace" | json_expr "data.token ?? ''")"
  TINYBIRD_WORKSPACE_ID="$(printf '%s' "$workspace" | json_expr "data.id ?? ''")"
  # The listing returns the user's admin token; JWTs must be signed with the
  # token Tinybird names "workspace admin token".
  TINYBIRD_WORKSPACE_TOKEN="$(curl -sf -H "Authorization: Bearer $member_token" "$TRACE_FLOW_TINYBIRD_HOST/v0/tokens" |
    json_expr "data.tokens.find((t) => t.name === 'workspace admin token')?.token ?? ''")"
  [[ -n "$TINYBIRD_WORKSPACE_TOKEN" && -n "$TINYBIRD_WORKSPACE_ID" ]] ||
    fail "Tinybird workspace $workspace_name was not found after deploy"
}

start_tinybird() {
  TRACE_FLOW_SKIP_TB_BUILD=1 start_tinybird_local
  # Without an explicit token, tb deploys to a workspace named after the git branch,
  # so switching branches would hide the seeded data. With one, it always uses
  # the project-path workspace that resolve_tinybird_project_workspace reads.
  log "deploying Tinybird project to Tinybird Local"
  local default_token
  default_token="$(curl -sf "$TRACE_FLOW_TINYBIRD_HOST/tokens" | json_expr "data.workspace_admin_token ?? ''")"
  TB_VERSION_WARNING=0 tb --local --token "$default_token" deploy --wait --auto
  resolve_tinybird_project_workspace
}

# Refuses a Convex backend that another checkout's stack started, rather than
# replacing its functions and environment or deleting its container.
check_stack_owner() {
  local owner
  owner="$(docker inspect -f '{{index .Config.Labels "trace-flow.local-stack.root"}}' "$CONVEX_CONTAINER" 2>/dev/null)" ||
    return 0
  [[ -z "$owner" || "$owner" == "$TRACE_FLOW_ROOT" ]] ||
    fail "the local stack belongs to $owner; run 'scripts/dev/local-stack.sh down' there first"
}

# Rootless Docker's host gateway cannot reach services on the host
# (--disable-host-loopback), so containers use the host's own address there.
docker_host_address() {
  if docker info --format '{{join .SecurityOptions ","}}' 2>/dev/null | grep -q rootless; then
    ip -4 route get 1.1.1.1 | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }'
  else
    printf 'host-gateway'
  fi
}

start_convex() {
  # Tinybird Local publishes only on host loopback, so Convex reaches it by name.
  docker network inspect "$DOCKER_NETWORK" >/dev/null 2>&1 || docker network create "$DOCKER_NETWORK" >/dev/null
  if ! docker inspect -f '{{json .NetworkSettings.Networks}}' tinybird-local | grep -q "\"$DOCKER_NETWORK\""; then
    docker network connect "$DOCKER_NETWORK" tinybird-local
  fi
  if [[ -z "$(docker ps -q --filter "name=^${CONVEX_CONTAINER}$")" ]]; then
    docker rm -f "$CONVEX_CONTAINER" >/dev/null 2>&1 || true
    log "starting Convex backend container"
    local host_address
    host_address="$(docker_host_address)"
    [[ -n "$host_address" ]] || fail "could not find an address for containers to reach this host"
    local add_hosts=(--add-host "host.docker.internal:$host_address")
    # The backend fetches the issuer's OIDC metadata from inside the container.
    [[ "$PUBLIC_HOST" =~ ^[0-9.]+$ ]] || add_hosts+=(--add-host "$PUBLIC_HOST:$host_address")
    printf 'INSTANCE_SECRET=%s\n' "$CONVEX_INSTANCE_SECRET" >"$STACK_DIR/convex-container.env"
    chmod 600 "$STACK_DIR/convex-container.env"
    docker run -d \
      --name "$CONVEX_CONTAINER" \
      --label "trace-flow.local-stack.root=$TRACE_FLOW_ROOT" \
      --network "$DOCKER_NETWORK" \
      "${add_hosts[@]}" \
      -p "0.0.0.0:$CONVEX_PORT:3210" \
      -p "0.0.0.0:$CONVEX_SITE_PORT:3211" \
      -v "$CONVEX_VOLUME:/convex/data" \
      -e INSTANCE_NAME=trace-flow-local \
      --env-file "$STACK_DIR/convex-container.env" \
      -e CONVEX_CLOUD_ORIGIN="$CONVEX_URL" \
      -e CONVEX_SITE_ORIGIN="$CONVEX_SITE_URL" \
      -e DISABLE_BEACON=true \
      "$CONVEX_IMAGE" >/dev/null
  fi
  wait_for_http convex "$LOCAL_CONVEX_URL/version" 120

  # The Convex CLI rewrites .env.local in its working directory, so it runs from a
  # private directory instead of the repo root, whose .env.local may be a linked
  # secrets file.
  mkdir -p "$STACK_CONVEX_CLI_DIR"
  local functions_dir
  functions_dir="$(node -e "console.log(require('node:path').relative(process.argv[1], process.argv[2]))" \
    "$STACK_CONVEX_CLI_DIR" "$TRACE_FLOW_ROOT/packages/convex")"
  node -e "
    const fs = require('node:fs');
    const config = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    config.functions = process.argv[2];
    fs.writeFileSync(process.argv[3], JSON.stringify(config, null, 2));
  " "$TRACE_FLOW_ROOT/convex.json" "$functions_dir" "$STACK_CONVEX_CLI_DIR/convex.json"
  # The CLI requires a package.json; it resolves `convex` from the repo's node_modules.
  node -e "
    const fs = require('node:fs');
    const version = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).devDependencies.convex;
    const pkg = { name: 'trace-flow-local-convex', private: true, dependencies: { convex: version } };
    fs.writeFileSync(process.argv[2], JSON.stringify(pkg, null, 2));
  " "$TRACE_FLOW_ROOT/package.json" "$STACK_CONVEX_CLI_DIR/package.json"

  local admin_key
  admin_key="$(docker exec "$CONVEX_CONTAINER" ./generate_admin_key.sh | tail -n 1)"
  cat >"$STACK_CONVEX_CLI_DIR/.env.local" <<EOF
CONVEX_SELF_HOSTED_URL=$LOCAL_CONVEX_URL
CONVEX_SELF_HOSTED_ADMIN_KEY=$admin_key
EOF
  chmod 600 "$STACK_CONVEX_CLI_DIR/.env.local"

  cat >"$STACK_DIR/convex.env" <<EOF
AUTH0_DOMAIN=$OIDC_ISSUER
AUTH0_CLIENT_ID=$OIDC_CLIENT_ID
AUTH0_CLIENT_SECRET=$OIDC_CLIENT_SECRET
APP_URL=$WEB_URL
APP_BASE_URL=$WEB_URL
TINYBIRD_API_URL=http://tinybird-local:7181
TINYBIRD_ADMIN_TOKEN=$TINYBIRD_WORKSPACE_TOKEN
TINYBIRD_WORKSPACE_ID=$TINYBIRD_WORKSPACE_ID
PIPES_API_SHARED_SECRET=$PIPES_API_SHARED_SECRET
USAGE_SYNC_SECRET=$USAGE_SYNC_SECRET
AGENT_INGEST_SHARED_SECRET=$AGENT_INGEST_SHARED_SECRET
BODY_ACCESS_JWT_SECRET=$BODY_ACCESS_JWT_SECRET
MCP_JWT_SECRET=$MCP_JWT_SECRET
MCP_BACKEND_SHARED_SECRET=$MCP_BACKEND_SHARED_SECRET
SPLITCH_API_KEY=local-stack-placeholder
CLOUDFLARE_API_BASE_URL=http://host.docker.internal:$KV_BRIDGE_PORT
CLOUDFLARE_ACCOUNT_ID=local
CLOUDFLARE_API_TOKEN=$KV_BRIDGE_TOKEN
CLOUDFLARE_KV_NAMESPACE_ID=$API_KEYS_KV_ID
CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID=$COLLECTOR_CREDS_KV_ID
CLOUDFLARE_PRICING_KV_NAMESPACE_ID=$MODEL_PRICING_KV_ID
EOF
  chmod 600 "$STACK_DIR/convex.env"

  log "setting Convex environment"
  convex_cli env set --force --from-file "$STACK_DIR/convex.env" >/dev/null
  log "pushing Convex functions"
  convex_cli dev --once --typecheck disable --codegen disable --tail-logs disable
}

# The CLI reads the self-hosted URL and admin key from its directory's .env.local,
# so exported deployment settings must not take precedence over them.
convex_cli() {
  (cd "$STACK_CONVEX_CLI_DIR" && env -u CONVEX_DEPLOYMENT -u CONVEX_DEPLOY_KEY \
    -u CONVEX_SELF_HOSTED_URL -u CONVEX_SELF_HOSTED_ADMIN_KEY bunx convex "$@")
}

start_oidc() {
  process_running oidc || require_free_port oidc "$OIDC_PORT"
  start_process oidc env \
    MOCK_OIDC_ISSUER="$OIDC_ISSUER" \
    MOCK_OIDC_PORT="$OIDC_PORT" \
    MOCK_OIDC_CLIENT_ID="$OIDC_CLIENT_ID" \
    MOCK_OIDC_KEY_PATH="$STACK_DIR/oidc-signing-key.json" \
    MOCK_OIDC_DEFAULT_EMAIL="$DEFAULT_EMAIL" \
    bun "$TRACE_FLOW_DEV_DIR/mock-oidc.ts"
  wait_for_http oidc "http://127.0.0.1:$OIDC_PORT/.well-known/openid-configuration" 30
}

# wrangler passes --env-file only to the first -c config; the others read the
# .dev.vars beside their config, which a worktree may link to cloud dev credentials.
# Each Worker therefore runs from a mirror of its app directory whose .dev.vars
# holds only the stack's values for that app. Prints the mirrored config path.
mirror_worker() {
  local app="$1" mirror="$STACK_DIR/workers/$1" entry
  rm -rf "$mirror"
  mkdir -p "$mirror"
  for entry in "$TRACE_FLOW_ROOT/apps/$app"/* "$TRACE_FLOW_ROOT/apps/$app"/.[!.]*; do
    case "${entry##*/}" in .dev.vars* | .env* | .wrangler) continue ;; esac
    if [[ -e "$entry" ]]; then ln -s "$entry" "$mirror/"; fi
  done
  worker_vars "$app" >"$mirror/.dev.vars"
  chmod 600 "$mirror/.dev.vars"
  local config
  for config in "$mirror/wrangler.toml" "$mirror/wrangler.jsonc"; do
    if [[ -e "$config" ]]; then
      printf '%s' "$config"
      return
    fi
  done
  fail "apps/$app has no wrangler config"
}

# Each Worker gets only the variables it reads, so the stack keeps production's
# secret boundaries; pipes-api never sees body keys, for example.
worker_vars() {
  local vars=(AXIOM_TOKEN= SENTRY_DSN=)
  case "$1" in
    proxy)
      vars+=("CONVEX_SITE_URL=$LOCAL_CONVEX_SITE_URL" "USAGE_SYNC_SECRET=$USAGE_SYNC_SECRET"
        "BODY_ENCRYPTION_ROOT_KEY=$BODY_ENCRYPTION_ROOT_KEY" BODY_ENCRYPTION_KEY_ID=v1)
      ;;
    proxy-consumer)
      vars+=("TINYBIRD_TOKEN=$TINYBIRD_WORKSPACE_TOKEN" TINYBIRD_DATASOURCE=otel_trace_spans
        "TINYBIRD_HOST=$TRACE_FLOW_TINYBIRD_HOST")
      ;;
    agent-ingest)
      vars+=("CONVEX_SITE_URL=$LOCAL_CONVEX_SITE_URL" "AGENT_INGEST_SHARED_SECRET=$AGENT_INGEST_SHARED_SECRET"
        "BODY_ENCRYPTION_ROOT_KEY=$BODY_ENCRYPTION_ROOT_KEY" BODY_ENCRYPTION_KEY_ID=v1)
      ;;
    agent-consumer)
      vars+=("TINYBIRD_TOKEN=$TINYBIRD_WORKSPACE_TOKEN" "TINYBIRD_HOST=$TRACE_FLOW_TINYBIRD_HOST"
        "BODY_ENCRYPTION_ROOT_KEY=$BODY_ENCRYPTION_ROOT_KEY")
      ;;
    pipes-api)
      vars+=("CONVEX_SITE_URL=$LOCAL_CONVEX_SITE_URL" "PIPES_API_SHARED_SECRET=$PIPES_API_SHARED_SECRET"
        "TINYBIRD_API_URL=$TRACE_FLOW_TINYBIRD_HOST" "LOCAL_DEV_ORIGINS=$WEB_URL")
      ;;
    api)
      vars+=("CONVEX_SITE_URL=$LOCAL_CONVEX_SITE_URL" "BODY_ENCRYPTION_ROOT_KEY=$BODY_ENCRYPTION_ROOT_KEY"
        BODY_ENCRYPTION_KEY_ID=v1 "BODY_ACCESS_JWT_SECRET=$BODY_ACCESS_JWT_SECRET" "LOCAL_DEV_ORIGINS=$WEB_URL")
      ;;
    *) fail "no local stack variables defined for apps/$1" ;;
  esac
  printf '%s\n' "${vars[@]}"
}

check_kv_namespace() {
  grep -q "$2" "$TRACE_FLOW_ROOT/apps/$1"/wrangler.* ||
    fail "apps/$1 no longer binds KV namespace $2; update the ids in $0"
}

# Prints the bridge's config path.
write_kv_bridge_config() {
  local dir="$STACK_DIR/workers/kv-bridge" id bindings=()
  mkdir -p "$dir"
  for id in "$API_KEYS_KV_ID" "$COLLECTOR_CREDS_KV_ID" "$MODEL_PRICING_KV_ID"; do
    bindings+=("{ \"binding\": \"KV_$id\", \"id\": \"$id\" }")
  done
  cat >"$dir/wrangler.jsonc" <<EOF
{
  "name": "trace-flow-local-kv-bridge",
  "main": "$TRACE_FLOW_DEV_DIR/kv-bridge.ts",
  "compatibility_date": "2024-11-27",
  "kv_namespaces": [$(
    IFS=,
    printf '%s' "${bindings[*]}"
  )]
}
EOF
  printf 'KV_BRIDGE_TOKEN=%s\n' "$KV_BRIDGE_TOKEN" >"$dir/.dev.vars"
  chmod 600 "$dir/.dev.vars"
  printf '%s' "$dir/wrangler.jsonc"
}

start_workers() {
  check_kv_namespace proxy "$API_KEYS_KV_ID"
  check_kv_namespace agent-ingest "$COLLECTOR_CREDS_KV_ID"
  check_kv_namespace proxy-consumer "$MODEL_PRICING_KV_ID"

  # Queue producers and their consumers must share a process. The browser-facing
  # read Workers get their own ports because the proxy does not route to them.
  # Processes share persisted state, so each starts only after the previous one is
  # serving; concurrent SQLite recovery fails with SQLITE_BUSY.
  start_wrangler workers "$PROXY_PORT" 9330 proxy proxy-consumer
  start_wrangler agent-ingest "$AGENT_INGEST_PORT" 9333 agent-ingest agent-consumer
  start_wrangler pipes-api "$PIPES_PORT" 9331 pipes-api
  start_wrangler raw-api "$RAW_API_PORT" 9332 api
  # The Convex container reaches the bridge through the Docker host gateway.
  start_wrangler kv-bridge "$KV_BRIDGE_PORT" 9334 kv-bridge
}

# Starts one `wrangler dev` process for the given apps; the first serves the port.
# A running process keeps its mirrors, since rebuilding them breaks its bundles.
start_wrangler() {
  local name="$1" port="$2" inspector_port="$3" app configs=()
  shift 3
  if process_running "$name"; then
    log "$name is already running"
    return 0
  fi
  require_free_port "$name" "$port"
  for app in "$@"; do
    if [[ "$app" == kv-bridge ]]; then
      configs+=(-c "$(write_kv_bridge_config)")
    else
      configs+=(-c "$(mirror_worker "$app")")
    fi
  done
  # Bun isolates workspace installs, so use the version an app pins.
  start_process "$name" "$TRACE_FLOW_ROOT/apps/proxy/node_modules/.bin/wrangler" dev \
    --ip 0.0.0.0 --port "$port" --inspector-port "$inspector_port" \
    --persist-to "$STACK_DIR/wrangler" --show-interactive-dev-session=false "${configs[@]}"
  wait_for_http "$name" "http://127.0.0.1:$port/" 120
}

# Next loads apps/web's dotenv files, which may be linked to cloud dev
# credentials, but never overrides a variable already in the environment, even an
# empty one. Web therefore starts from an empty environment with every key those
# files define blanked, then the stack's values. Only key names are read.
write_web_env() {
  local file key
  {
    for file in .env .env.local .env.development .env.development.local; do
      [[ -f "$TRACE_FLOW_ROOT/apps/web/$file" ]] || continue
      sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' \
        "$TRACE_FLOW_ROOT/apps/web/$file"
    done
  } | sort -u | while read -r key; do printf '%s=\n' "$key"; done
  printf '%s\n' \
    "APP_BASE_URL=$WEB_URL" \
    "AUTH0_DOMAIN=$OIDC_ISSUER" \
    "AUTH0_CLIENT_ID=$OIDC_CLIENT_ID" \
    "AUTH0_CLIENT_SECRET=$OIDC_CLIENT_SECRET" \
    "AUTH0_SECRET=$AUTH0_SECRET" \
    "NEXT_PUBLIC_AUTH0_DOMAIN=$OIDC_ISSUER" \
    "NEXT_PUBLIC_AUTH0_CLIENT_ID=$OIDC_CLIENT_ID" \
    "NEXT_PUBLIC_CONVEX_URL=$CONVEX_URL" \
    "NEXT_PUBLIC_API_URL=$PROXY_URL" \
    "NEXT_PUBLIC_PIPES_API_URL=$PIPES_URL" \
    "NEXT_PUBLIC_RAW_API_URL=$RAW_API_URL" \
    "NEXT_PUBLIC_TINYBIRD_API_URL=$TRACE_FLOW_TINYBIRD_HOST" \
    "TRACE_FLOW_ALLOWED_DEV_ORIGINS=$PUBLIC_HOST"
}

start_web() {
  if process_running web; then
    log "web is already running"
    return 0
  fi
  require_free_port web "$WEB_PORT"
  local env_file="$STACK_DIR/web.env"
  write_web_env >"$env_file"
  chmod 600 "$env_file"
  # shellcheck disable=SC2016 # expanded by the inner shell
  start_process web env -i HOME="$HOME" PATH="$PATH" LANG="${LANG:-C.UTF-8}" TMPDIR="${TMPDIR:-/tmp}" \
    bash -c 'set -a && source "$1" && set +a && cd "$2" && exec bunx next dev -H 0.0.0.0 -p "$3"' \
    web "$env_file" "$TRACE_FLOW_ROOT/apps/web" "$WEB_PORT"
  wait_for_http web "http://127.0.0.1:$WEB_PORT/" 180
}

login_url() {
  local email="${1:-$DEFAULT_EMAIL}"
  local encoded
  encoded="$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$email")"
  printf '%s/auth/login?login_hint=%s&returnTo=%%2Fapp\n' "$WEB_URL" "$encoded"
}

print_urls() {
  cat <<EOF

  Web            $WEB_URL
  Sign in        $(login_url)
  Mock issuer    $OIDC_ISSUER
  Convex         $CONVEX_URL  (site $CONVEX_SITE_URL)
  Proxy          $PROXY_URL
  Pipes API      $PIPES_URL
  Raw API        $RAW_API_URL
  Agent ingest   $AGENT_INGEST_URL
  Tinybird       $TRACE_FLOW_TINYBIRD_HOST (local only)
  Logs           $STACK_LOG_DIR

EOF
}

cmd_up() {
  require_command docker
  require_command bun
  require_command node
  require_command tb
  start_docker_if_possible || fail "Docker is not running"
  cd "$TRACE_FLOW_ROOT"
  check_stack_owner
  ensure_secrets
  start_tinybird
  start_oidc
  start_convex
  start_workers
  start_web
  log "local stack is up"
  print_urls
}

cmd_down() {
  local purge=0
  [[ "${1:-}" == "--purge" ]] && purge=1
  check_stack_owner
  for name in web kv-bridge raw-api pipes-api agent-ingest workers oidc; do
    stop_process "$name"
  done
  if docker ps -aq --filter "name=^${CONVEX_CONTAINER}$" | grep -q .; then
    log "removing Convex backend container"
    docker rm -f "$CONVEX_CONTAINER" >/dev/null
  fi
  if command_exists tb && tinybird_local_running; then
    log "stopping Tinybird Local"
    TB_VERSION_WARNING=0 tb local stop >/dev/null 2>&1 || warn "could not stop Tinybird Local"
  fi
  if ((purge)); then
    log "deleting local stack data"
    docker volume rm "$CONVEX_VOLUME" >/dev/null 2>&1 || true
    docker rm -f tinybird-local >/dev/null 2>&1 || true
    docker network rm "$DOCKER_NETWORK" >/dev/null 2>&1 || true
    # Tinybird Local writes its volume as root; delete it from inside a container.
    if [[ -d "$TRACE_FLOW_STATE_DIR/tinybird" ]]; then
      docker run --rm -v "$TRACE_FLOW_STATE_DIR:/state" --entrypoint sh tinybirdco/tinybird-local:latest \
        -c 'rm -rf /state/tinybird' || warn "could not delete $TRACE_FLOW_STATE_DIR/tinybird"
    fi
    rm -rf "$STACK_DIR" "$TRACE_FLOW_DEV_ENV"
  fi
  log "local stack is down"
}

cmd_seed() {
  tinybird_local_running || fail "Tinybird Local is not running; run scripts/dev/local-stack.sh up"
  resolve_tinybird_project_workspace
  TRACE_FLOW_ROOT="$TRACE_FLOW_ROOT" \
    STACK_CONVEX_CLI_DIR="$STACK_CONVEX_CLI_DIR" \
    STACK_EMAIL="$DEFAULT_EMAIL" \
    TRACE_FLOW_TINYBIRD_HOST="$TRACE_FLOW_TINYBIRD_HOST" \
    TINYBIRD_WORKSPACE_TOKEN="$TINYBIRD_WORKSPACE_TOKEN" \
    node "$TRACE_FLOW_DEV_DIR/local-stack-seed.mjs" "$@"
}

cmd_status() {
  for name in oidc workers agent-ingest pipes-api raw-api kv-bridge web; do
    if process_running "$name"; then
      printf '  %-12s running (pid %s)\n' "$name" "$(cat "$STACK_PID_DIR/$name.pid")"
    else
      printf '  %-12s stopped\n' "$name"
    fi
  done
  printf '  %-12s %s\n' convex "$(docker ps --filter "name=^${CONVEX_CONTAINER}$" --format '{{.Status}}' | grep . || echo stopped)"
  printf '  %-12s %s\n' tinybird "$(tinybird_local_running && echo running || echo stopped)"
  print_urls
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down "${2:-}" ;;
  status) cmd_status ;;
  login-url) login_url "${2:-}" ;;
  seed) cmd_seed "${@:2}" ;;
  logs) tail -n 200 -f "$STACK_LOG_DIR/${2:?usage: local-stack.sh logs <oidc|workers|agent-ingest|pipes-api|raw-api|kv-bridge|web>}.log" ;;
  *)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
