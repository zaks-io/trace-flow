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

bunx opennextjs-cloudflare build
# The verify environment has no AI binding, so neither step needs Cloudflare credentials. The
# verifier never requests Markdown, the only path that calls AI.
bunx opennextjs-cloudflare populateCache local --env verify
bunx wrangler dev --env verify --ip 127.0.0.1 --port "$port" --show-interactive-dev-session=false \
  >"$log" 2>&1 &
server=$!
trap 'kill -TERM -- "-$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true; rm -f "$log"' EXIT

for attempt in $(seq 120); do
  kill -0 "$server" 2>/dev/null || fail "Wrangler exited before the Worker became ready"
  curl -fs -o /dev/null -m 2 "$url/healthz" && break
  [[ $attempt == 120 ]] && fail "Worker did not become ready on port $port"
  sleep 1
done

bun run scripts/verify-worker.ts "$url" || fail 'Worker verification failed'
# A Wrangler that lost the port mid-run would mean another process answered the checks.
kill -0 "$server" 2>/dev/null || fail 'Wrangler exited during verification'
