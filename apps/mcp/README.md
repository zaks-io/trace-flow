# MCP authorization

API-key authorization uses a per-isolate positive cache with a fixed 30-second
TTL. A hit can admit a new request with a revoked or expired key, removed MCP read
permission, or disabled user for at most 30 seconds after the authorization read
started. Hits never extend the deadline. Requests already admitted, including
open SSE connections, retain their existing lifetime behavior.

The cache holds at most 1,000 entries, evicting the oldest insertion at capacity.
Its keys are SHA-256 digests of API keys. Entries contain only the authorized user
ID, expiry, and a digest of the backend URL and shared secret. A backend change or
secret rotation forces a miss. Raw keys are sent only in the existing authorized
backend request body, never retained in the cache or added to telemetry.

Negative results, backend errors, and malformed responses are never cached. This
lets a newly granted permission take effect immediately and prevents an outage
from creating cached denials. Isolate eviction or deployment clears the cache;
there is no shared store and no distributed invalidation requirement.

## Remaining backend round trips

A cold API-key request makes one `/mcp-backend/authorize-api-key` call; a warm
request makes none. OAuth authorization follows its existing JWKS verification
path and does not use this cache.

Tool execution can also read `/mcp-backend/context` once per request. The backend
already shares that promise among `getUserContext`, `resolveKeyIds`, and
`listApiKeys`. Tools that query Tinybird additionally call `/mcp-backend/mint`.
These reads and minted tokens remain uncached across requests. Minting must
revalidate current membership atomically with the token's org binding, as
required by TRA-402. Combining those calls safely would require backend work;
this change leaves `packages/convex` and public tool response shapes untouched.

## Verification and rollout

The workerd tests exercise repeated POST requests, GET and DELETE, fixed expiry,
uncached denials, backend failures, configuration isolation, cache contents, and
exported Sentry envelopes and logs. The initialize, tools/list, list_api_keys
sequence now makes one authorization call instead of three.

On 2026-10-26, a direct request to the cloud dev authorize route configured in
`wrangler.toml` returned HTTP 404. The worktree dotenv's `CONVEX_SITE_URL` pointed
to a local server that refused connections, and the MCP backend/session secrets
and test API key were unset. A live dev proof requires the backend owner to
confirm and deploy the MCP backend routes to the intended dev Convex deployment,
then approval to deploy `trace-flow-mcp-dev` with its matching backend/session
secrets. Use a dev MCP-read key to send repeated requests within 30 seconds and
verify that only the first request emits an authorize span. No Worker or Convex
deployment is part of this change.

After deployment, compare seven days of Sentry spans using
`environment:prod span.description:"POST https://connect.trace-flow.dev/mcp-backend/authorize-api-key"`,
grouped by `transaction`. The 2026-10-26 baseline was 5,070 calls/week at about
200ms average and 400ms p95. Compare `environment:prod transaction:"POST /mcp"`
against its 206ms average baseline. Expect fewer authorization spans on repeat
requests in a warm isolate, with the remaining misses retaining backend latency.
Traffic spread across isolates and requests more than 30 seconds apart limit the
hit rate; the tests do not predict a production reduction percentage.
