#!/usr/bin/env bash
# Non-production placeholder values only — safe for local `next build` / prerender checks.
# AUTH0_* dummies are not real credentials; override any var by exporting it before `bun run ci:check`.
set -euo pipefail
export NEXT_PUBLIC_CONVEX_URL="${NEXT_PUBLIC_CONVEX_URL:-https://test.convex.cloud}"
export NEXT_PUBLIC_AUTH0_DOMAIN="${NEXT_PUBLIC_AUTH0_DOMAIN:-test.auth0.com}"
export NEXT_PUBLIC_AUTH0_CLIENT_ID="${NEXT_PUBLIC_AUTH0_CLIENT_ID:-test-client-id}"
export NEXT_PUBLIC_TINYBIRD_API_URL="${NEXT_PUBLIC_TINYBIRD_API_URL:-https://api.tinybird.co}"
export AUTH0_DOMAIN="${AUTH0_DOMAIN:-test.auth0.com}"
export AUTH0_CLIENT_ID="${AUTH0_CLIENT_ID:-test-client-id}"
export AUTH0_SECRET="${AUTH0_SECRET:-test-secret-at-least-32-characters-long}"
export AUTH0_CLIENT_SECRET="${AUTH0_CLIENT_SECRET:-test}"
export BODY_ACCESS_JWT_SECRET="${BODY_ACCESS_JWT_SECRET:-test-body-access-secret-at-least-32-characters-long}"
bun run duplicates:check
exec bun run check
