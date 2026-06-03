#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENVIRONMENT=""
DEPLOYMENT=""
PRIVATE_KEY_FILE=""
PUBLIC_KEY_FILE=""
GENERATE=0
OUTPUT_DIR=""
CONFIRM_PRODUCTION=0
VERIFY_URL=""
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage:
  scripts/configure-mcp-jwt-keys.sh \
    --environment <local|dev|preview|production> \
    --deployment <convex-deployment> \
    --generate

  scripts/configure-mcp-jwt-keys.sh \
    --environment <local|dev|preview|production> \
    --deployment <convex-deployment> \
    --private-key <private.pem> \
    --public-key <public.pem>

Options:
  --environment <name>       Environment label for the keypair.
  --deployment <deployment>  Convex deployment name/ref passed to `convex env set`.
  --generate                 Generate a new RSA keypair before setting env vars.
  --output-dir <dir>         Directory for generated PEMs. Defaults under .trace-flow/.
  --private-key <file>       Existing PKCS8 private key PEM.
  --public-key <file>        Existing SPKI public key PEM.
  --confirm-production       Required when --environment is production/prod.
  --verify-url <url>         Optional JWKS URL to check after setting vars.
  --dry-run                  Generate/validate keys but do not set Convex env vars.
  -h, --help                 Show this help.

Examples:
  scripts/configure-mcp-jwt-keys.sh \
    --environment production \
    --deployment laudable-bison-427 \
    --generate \
    --confirm-production \
    --verify-url https://connect.trace-flow.dev/.well-known/jwks.json

  scripts/configure-mcp-jwt-keys.sh \
    --environment preview \
    --deployment trace-flow-dev:preview \
    --private-key .trace-flow/mcp-jwt-keys/preview/key.pem \
    --public-key .trace-flow/mcp-jwt-keys/preview/pub.pem
EOF
}

log() {
  printf '[mcp-jwt] %s\n' "$*"
}

fail() {
  printf '[mcp-jwt] error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

run_quietly() {
  local err_file
  err_file="$(mktemp)"
  if ! "$@" 2>"$err_file"; then
    cat "$err_file" >&2
    rm -f "$err_file"
    fail "command failed: $1"
  fi
  rm -f "$err_file"
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

absolute_path() {
  local path="$1"
  if [[ "$path" = /* ]]; then
    printf '%s\n' "$path"
  else
    printf '%s/%s\n' "$(pwd)" "$path"
  fi
}

validate_pem() {
  local file="$1"
  local label="$2"
  [[ -f "$file" ]] || fail "$label key file not found: $file"
  [[ -s "$file" ]] || fail "$label key file is empty: $file"
  grep -q -- "-----BEGIN .* KEY-----" "$file" || fail "$label key is not a PEM key: $file"
}

validate_key_pair() {
  local private_public
  local public_canonical

  openssl pkey -in "$PRIVATE_KEY_FILE" -noout >/dev/null 2>&1 ||
    fail "private key is not a valid PKCS8 PEM: $PRIVATE_KEY_FILE"
  openssl pkey -pubin -in "$PUBLIC_KEY_FILE" -noout >/dev/null 2>&1 ||
    fail "public key is not a valid SPKI PEM: $PUBLIC_KEY_FILE"

  private_public="$(openssl pkey -in "$PRIVATE_KEY_FILE" -pubout 2>/dev/null)"
  public_canonical="$(openssl pkey -pubin -in "$PUBLIC_KEY_FILE" -pubout 2>/dev/null)"
  [[ "$private_public" == "$public_canonical" ]] ||
    fail "public key does not match private key"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --environment)
      ENVIRONMENT="${2:-}"
      shift 2
      ;;
    --deployment)
      DEPLOYMENT="${2:-}"
      shift 2
      ;;
    --generate)
      GENERATE=1
      shift
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --private-key)
      PRIVATE_KEY_FILE="${2:-}"
      shift 2
      ;;
    --public-key)
      PUBLIC_KEY_FILE="${2:-}"
      shift 2
      ;;
    --confirm-production)
      CONFIRM_PRODUCTION=1
      shift
      ;;
    --verify-url)
      VERIFY_URL="${2:-}"
      shift 2
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
[[ -n "$DEPLOYMENT" ]] || fail "--deployment is required"

ENVIRONMENT="$(normalize_environment "$ENVIRONMENT")"

if [[ "$ENVIRONMENT" == "production" && "$CONFIRM_PRODUCTION" != "1" ]]; then
  fail "production requires --confirm-production"
fi

if [[ "$GENERATE" == "1" && ( -n "$PRIVATE_KEY_FILE" || -n "$PUBLIC_KEY_FILE" ) ]]; then
  fail "use either --generate or --private-key/--public-key, not both"
fi

if [[ "$GENERATE" != "1" && ( -z "$PRIVATE_KEY_FILE" || -z "$PUBLIC_KEY_FILE" ) ]]; then
  fail "provide --generate or both --private-key and --public-key"
fi

require_command openssl
if [[ "$DRY_RUN" != "1" ]]; then
  require_command bunx
fi

if [[ "$GENERATE" == "1" ]]; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  OUTPUT_DIR="${OUTPUT_DIR:-.trace-flow/mcp-jwt-keys/$ENVIRONMENT/$stamp}"
  OUTPUT_DIR="$(absolute_path "$OUTPUT_DIR")"
  mkdir -p "$OUTPUT_DIR"
  chmod 700 "$OUTPUT_DIR"

  PRIVATE_KEY_FILE="$OUTPUT_DIR/mcp-jwt-private.pem"
  PUBLIC_KEY_FILE="$OUTPUT_DIR/mcp-jwt-public.pem"

  log "generating RSA keypair for $ENVIRONMENT"
  run_quietly openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$PRIVATE_KEY_FILE"
  run_quietly openssl pkey -in "$PRIVATE_KEY_FILE" -pubout -out "$PUBLIC_KEY_FILE"
  chmod 600 "$PRIVATE_KEY_FILE" "$PUBLIC_KEY_FILE"
else
  PRIVATE_KEY_FILE="$(absolute_path "$PRIVATE_KEY_FILE")"
  PUBLIC_KEY_FILE="$(absolute_path "$PUBLIC_KEY_FILE")"
fi

validate_pem "$PRIVATE_KEY_FILE" private
validate_pem "$PUBLIC_KEY_FILE" public
validate_key_pair

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry run: would set MCP_JWT_PRIVATE_KEY on Convex deployment $DEPLOYMENT"
  log "dry run: would set MCP_JWT_PUBLIC_KEY on Convex deployment $DEPLOYMENT"
  log "dry run complete for $ENVIRONMENT ($DEPLOYMENT)"
  exit 0
fi

log "setting MCP_JWT_PRIVATE_KEY on Convex deployment $DEPLOYMENT"
bunx convex env set --deployment "$DEPLOYMENT" MCP_JWT_PRIVATE_KEY --from-file "$PRIVATE_KEY_FILE"

log "setting MCP_JWT_PUBLIC_KEY on Convex deployment $DEPLOYMENT"
bunx convex env set --deployment "$DEPLOYMENT" MCP_JWT_PUBLIC_KEY --from-file "$PUBLIC_KEY_FILE"

if [[ -n "$VERIFY_URL" ]]; then
  require_command curl
  require_command jq
  log "checking JWKS endpoint: $VERIFY_URL"
  curl -fsS "$VERIFY_URL" | jq -e '.keys[0] | select(.kty == "RSA" and .alg == "RS256" and .use == "sig") | {kid, alg, kty, use}'
fi

log "configured MCP JWT keys for $ENVIRONMENT ($DEPLOYMENT)"
if [[ "$GENERATE" == "1" ]]; then
  log "generated PEMs are in $OUTPUT_DIR"
fi
