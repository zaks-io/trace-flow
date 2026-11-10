#!/usr/bin/env bash
# Build the Worker the way deploys do and run verify-worker.ts against it in local workerd.
# `next build` alone cannot catch an OpenNext adapter that is incompatible with the Next.js
# version: Next 16.4.5 on OpenNext 1.20.6 built cleanly and then failed every uncached route.
set -euo pipefail
set -m # Give the dev server its own process group so cleanup also stops workerd.

cd "$(dirname "${BASH_SOURCE[0]}")/.."
port="${WEB_VERIFY_PORT:-8791}"
url="http://127.0.0.1:$port"
log="$(mktemp)"
vars="$(mktemp)"
server=

cleanup() {
  if [[ -n $server ]]; then
    kill -TERM -- "-$server" 2>/dev/null || true
    wait "$server" 2>/dev/null || true
  fi
  rm -f "$log" "$vars"
}
trap cleanup EXIT

fail() {
  echo "$1" >&2
  echo '--- Worker log ---' >&2
  cat "$log" >&2
  exit 1
}

# Another server on this port would answer the checks instead of the build under test.
if curl -s -o /dev/null -m 2 "$url/"; then
  echo "Port $port already serves HTTP. Set WEB_VERIFY_PORT to a free port." >&2
  exit 1
fi

# Without Auth0 config the middleware throws and redirects every page to /auth/login. Worker vars
# override values OpenNext embeds from .env files, so local runs match CI. These are the
# scripts/ci-check.sh placeholders, not credentials; the verifier never completes a sign-in.
cat >"$vars" <<EOF
APP_BASE_URL=$url
AUTH0_DOMAIN=test.auth0.com
AUTH0_CLIENT_ID=test-client-id
AUTH0_CLIENT_SECRET=test
AUTH0_SECRET=test-secret-at-least-32-characters-long
EOF

bunx opennextjs-cloudflare build
# The verify environment has no AI binding, so neither step needs Cloudflare credentials. The
# verifier never requests Markdown, the only path that calls AI.
bunx opennextjs-cloudflare populateCache local --env verify
bunx wrangler dev --env verify --env-file "$vars" --ip 127.0.0.1 --port "$port" \
  --show-interactive-dev-session=false >"$log" 2>&1 &
server=$!

for attempt in $(seq 120); do
  kill -0 "$server" 2>/dev/null || fail "Wrangler exited before the Worker became ready"
  curl -fs -o /dev/null -m 2 "$url/healthz" && break
  [[ $attempt == 120 ]] && fail "Worker did not become ready on port $port"
  sleep 1
done

bun run scripts/verify-worker.ts "$url" || fail 'Worker verification failed'
# A Wrangler that lost the port mid-run would mean another process answered the checks.
kill -0 "$server" 2>/dev/null || fail 'Wrangler exited during verification'
