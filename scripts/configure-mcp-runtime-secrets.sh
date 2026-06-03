#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENVIRONMENT=""
CONVEX_DEPLOYMENT=""
WORKER_ENV=""
BACKEND_SECRET_FILE=""
SESSION_SECRET_FILE=""
GENERATED_BACKEND_SECRET=0
GENERATED_SESSION_SECRET=0
CONFIRM_PRODUCTION=0
DRY_RUN=0

TMP_DIR=""

usage() {
  cat <<'EOF'
Usage:
  scripts/configure-mcp-runtime-secrets.sh \
    --environment <local|dev|preview|production> \
    --convex-deployment <convex-deployment>

Options:
  --environment <name>            Environment label for the secrets.
  --convex-deployment <target>    Convex deployment name/ref passed to `convex env set`.
  --worker-env <name>             Wrangler env for apps/mcp. Defaults from --environment.
  --backend-secret-file <file>    Existing MCP_BACKEND_SHARED_SECRET file.
  --session-secret-file <file>    Existing MCP_SESSION_SECRET file.
  --confirm-production            Required when --environment is production/prod.
  --dry-run                       Generate/validate secrets but do not set remote secrets.
  -h, --help                      Show this help.

What it sets:
  Convex deployment:
    MCP_BACKEND_SHARED_SECRET

  Cloudflare Worker apps/mcp:
    MCP_BACKEND_SHARED_SECRET
    MCP_SESSION_SECRET

Examples:
  scripts/configure-mcp-runtime-secrets.sh \
    --environment production \
    --convex-deployment laudable-bison-427 \
    --confirm-production

  scripts/configure-mcp-runtime-secrets.sh \
    --environment preview \
    --convex-deployment trace-flow-dev:preview \
    --worker-env preview
EOF
}

log() {
  printf '[mcp-secrets] %s\n' "$*"
}

fail() {
  printf '[mcp-secrets] error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}

trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

normalize_environment() {
  case "$1" in
    local) printf 'local' ;;
    dev | development) printf 'development' ;;
    preview) printf 'preview' ;;
    prod | production) printf 'production' ;;
    *) fail "unknown environment '$1'; expected local, dev, preview, or production" ;;
  esac
}

default_worker_env() {
  case "$1" in
    local | development) printf '' ;;
    preview) printf 'preview' ;;
    production) printf 'production' ;;
    *) fail "cannot derive worker env for '$1'" ;;
  esac
}

absolute_path() {
  local path="$1"
  if [[ "$path" = /* ]]; then
    printf '%s\n' "$path"
  else
    printf '%s/%s\n' "$(pwd)" "$path"
  fi
}

secret_file_size() {
  wc -c <"$1" | awk '{ print $1 }'
}

validate_secret_file() {
  local file="$1"
  local label="$2"
  local size

  [[ -f "$file" ]] || fail "$label secret file not found: $file"
  [[ -s "$file" ]] || fail "$label secret file is empty: $file"

  size="$(secret_file_size "$file")"
  [[ "$size" -ge 32 ]] || fail "$label secret must be at least 32 bytes"
  if LC_ALL=C grep -q '[^[:print:]]' "$file"; then
    fail "$label secret contains non-printable bytes"
  fi
  if grep -q '[[:space:]]' "$file"; then
    fail "$label secret must not contain whitespace"
  fi
}

write_generated_secret() {
  local file="$1"
  openssl rand -base64 48 | tr -d '\n' >"$file"
  chmod 600 "$file"
}

set_convex_secret() {
  local name="$1"
  local file="$2"

  log "setting $name on Convex deployment $CONVEX_DEPLOYMENT"
  bunx convex env set --deployment "$CONVEX_DEPLOYMENT" "$name" --from-file "$file"
}

set_worker_secret() {
  local name="$1"
  local file="$2"
  local cmd=(bunx wrangler secret put "$name")

  if [[ -n "$WORKER_ENV" ]]; then
    cmd+=(--env "$WORKER_ENV")
  fi

  log "setting $name on Cloudflare Worker apps/mcp${WORKER_ENV:+ env $WORKER_ENV}"
  (cd apps/mcp && "${cmd[@]}" <"$file")
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --environment)
      ENVIRONMENT="${2:-}"
      shift 2
      ;;
    --convex-deployment | --deployment)
      CONVEX_DEPLOYMENT="${2:-}"
      shift 2
      ;;
    --worker-env)
      WORKER_ENV="${2:-}"
      shift 2
      ;;
    --backend-secret-file)
      BACKEND_SECRET_FILE="${2:-}"
      shift 2
      ;;
    --session-secret-file)
      SESSION_SECRET_FILE="${2:-}"
      shift 2
      ;;
    --confirm-production)
      CONFIRM_PRODUCTION=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ -n "$ENVIRONMENT" ]] || fail "--environment is required"
[[ -n "$CONVEX_DEPLOYMENT" ]] || fail "--convex-deployment is required"

ENVIRONMENT="$(normalize_environment "$ENVIRONMENT")"

if [[ "$ENVIRONMENT" == "production" && "$CONFIRM_PRODUCTION" != "1" ]]; then
  fail "production requires --confirm-production"
fi

if [[ -z "$WORKER_ENV" ]]; then
  WORKER_ENV="$(default_worker_env "$ENVIRONMENT")"
fi

require_command openssl
if [[ "$DRY_RUN" != "1" ]]; then
  require_command bunx
fi

umask 077
TMP_DIR="$(mktemp -d)"

if [[ -z "$BACKEND_SECRET_FILE" ]]; then
  BACKEND_SECRET_FILE="$TMP_DIR/mcp-backend-shared-secret"
  write_generated_secret "$BACKEND_SECRET_FILE"
  GENERATED_BACKEND_SECRET=1
  log "generated ephemeral MCP_BACKEND_SHARED_SECRET"
else
  BACKEND_SECRET_FILE="$(absolute_path "$BACKEND_SECRET_FILE")"
fi

if [[ -z "$SESSION_SECRET_FILE" ]]; then
  SESSION_SECRET_FILE="$TMP_DIR/mcp-session-secret"
  write_generated_secret "$SESSION_SECRET_FILE"
  GENERATED_SESSION_SECRET=1
  log "generated ephemeral MCP_SESSION_SECRET"
else
  SESSION_SECRET_FILE="$(absolute_path "$SESSION_SECRET_FILE")"
fi

validate_secret_file "$BACKEND_SECRET_FILE" MCP_BACKEND_SHARED_SECRET
validate_secret_file "$SESSION_SECRET_FILE" MCP_SESSION_SECRET

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry run: would set MCP_BACKEND_SHARED_SECRET on Convex deployment $CONVEX_DEPLOYMENT"
  log "dry run: would set MCP_BACKEND_SHARED_SECRET on Cloudflare Worker apps/mcp${WORKER_ENV:+ env $WORKER_ENV}"
  log "dry run: would set MCP_SESSION_SECRET on Cloudflare Worker apps/mcp${WORKER_ENV:+ env $WORKER_ENV}"
  log "dry run complete for $ENVIRONMENT"
  exit 0
fi

set_convex_secret MCP_BACKEND_SHARED_SECRET "$BACKEND_SECRET_FILE"
set_worker_secret MCP_BACKEND_SHARED_SECRET "$BACKEND_SECRET_FILE"
set_worker_secret MCP_SESSION_SECRET "$SESSION_SECRET_FILE"

log "configured MCP runtime secrets for $ENVIRONMENT"
if [[ "$GENERATED_BACKEND_SECRET" == "1" || "$GENERATED_SESSION_SECRET" == "1" ]]; then
  log "generated secrets were ephemeral and have not been recorded"
else
  log "provided secret files were used; no generated secrets were recorded"
fi
