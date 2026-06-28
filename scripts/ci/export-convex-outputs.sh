#!/usr/bin/env bash
set -euo pipefail

convex_url="${NEXT_PUBLIC_CONVEX_URL:-}"

if [[ -z "$convex_url" ]]; then
  echo "NEXT_PUBLIC_CONVEX_URL is not set" >&2
  exit 1
fi

if [[ "$convex_url" != https://*.convex.cloud ]]; then
  echo "NEXT_PUBLIC_CONVEX_URL must be a Convex cloud URL: $convex_url" >&2
  exit 1
fi

convex_site_url="${convex_url%.convex.cloud}.convex.site"

{
  printf 'convex_url=%s\n' "$convex_url"
  printf 'convex_site_url=%s\n' "$convex_site_url"
} >> "$GITHUB_OUTPUT"
