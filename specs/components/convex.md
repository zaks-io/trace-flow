# Convex Backend

Convex is Trace Flow's control plane. It owns users, organizations, API keys, Collector Credentials,
billing state, model pricing, Tinybird JWT minting, MCP OAuth state, and the agent-ingest control
endpoints that Workers call.

Convex is not the analytics data plane. Trace and agent rows live in Tinybird, request/response
bodies live in R2, and queue processing lives in Cloudflare Workers.

## Responsibilities

- Sync Auth0 users into Trace Flow users and organizations.
- Manage organization-scoped proxy API keys and sync active keys to Cloudflare KV.
- Mint and revoke hidden Collector Credentials for CLI/Desktop collector ingest.
- Sync active Collector Credential hashes to the `COLLECTOR_CREDS` KV namespace.
- Serve agent-ingest compatibility policy and Agent Session ownership claims.
- Mint short-lived Tinybird JWTs with read-side fixed parameters.
- Store billing, subscription, usage, invites, alerts, and admin state.
- Host the MCP OAuth/control-plane backend.

## Core Tables

| Table                          | Purpose                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| `users`                        | Auth0-backed users and org membership pointer                           |
| `organizations`                | Tenant boundary for API keys, Collector Credentials, billing, and reads |
| `organizationMembers`          | Membership relation and role state                                      |
| `apiKeys`                      | User-facing proxy credentials synced to `API_KEYS` KV                   |
| `collectorCredentials`         | Hidden collector credentials, stored as hashes and audit metadata       |
| `agentSessionOwners`           | Stable ownership claims for `(org, source, vendor session)` tuples      |
| `collectorCompatibilityPolicy` | Active collector version/capability policy used by Agent Ingest         |
| `modelPricing`                 | Pricing catalog synced to `MODEL_PRICING` KV                            |
| `subscriptions` and `usage`    | Billing status, quota, and visibility-window inputs                     |
| `costAlerts` tables            | Cost alert config, attempts, and delivery state                         |
| MCP tables                     | OAuth clients, auth codes, sessions, and refresh tokens                 |

## API Key Control Plane

User-facing API keys authenticate proxied LLM requests through `X-Trace-Flow-Api-Key`.

Flow:

1. The Web app calls Convex mutations in `packages/convex/apiKeys.ts`.
2. Convex writes the key record under the user's organization.
3. Convex schedules Cloudflare KV sync through `packages/convex/integrations/cloudflare.ts`.
4. The Proxy validates the key from the `API_KEYS` namespace.
5. Tinybird trace and LLM usage reads use Convex-minted JWTs with `fixed_params.api_keys`.

API keys are not Collector Credentials and cannot authorize collector ingest.

## Collector Credential Control Plane

Collector Credentials authenticate the CLI/Desktop upload path.

Flow:

1. CLI/Desktop starts the device login flow through Convex HTTP routes in `packages/convex/http.ts`
   and `packages/convex/collectorLogin.ts`.
2. Convex mints a one-time collector secret, stores only its hash, and returns the secret to the
   local client.
3. Convex syncs active credential hashes to Cloudflare KV through
   `packages/convex/integrations/cloudflare.ts`.
4. Agent Ingest checks `X-Trace-Flow-Collector-Secret` against `COLLECTOR_CREDS`.
5. Revocation changes Convex state and removes the active KV entry.

Collector Credentials never appear in `fixed_params.api_keys`, API-key lists, cost alerts, or proxy
auth. Rotating or replacing a Collector Credential must not fragment Agent Session identity.

## Agent Ingest Control Endpoints

Agent Ingest calls Convex server-side endpoints with `AGENT_INGEST_SHARED_SECRET`:

- compatibility policy: current accepted collector versions and capabilities
- session ownership: batch claim/lookup for canonical Agent Session owner fields

Those endpoints keep tenancy and session ownership server-authoritative. The collector does not send
trusted `org_id`, `user_id`, cost, or final Tinybird primary keys.

## Tinybird JWT Generation

`packages/convex/integrations/tinybird.ts` signs short-lived Tinybird JWTs with the admin token.

Every scope gets a fixed-param envelope:

- `api_keys` and `retention_days` for proxied LLM trace and usage pipes
- `org_id` for agent analytics pipes

The same helper is used by the Web app token action and the MCP internal token path so neither can
mint an unscoped token by accident. Sentinel values are emitted for empty key/org states.

## MCP Backend

Convex owns MCP OAuth/control-plane state:

- OAuth authorization and token exchange
- registered clients
- MCP sessions and refresh tokens
- Tinybird JWT minting for MCP tools

The MCP Worker verifies access tokens and routes tool calls, but Convex owns durable OAuth state.

## Environment Variables

| Variable                                  | Purpose                                           |
| ----------------------------------------- | ------------------------------------------------- |
| `TINYBIRD_ADMIN_TOKEN`                    | Signs read JWTs and supports admin Tinybird calls |
| `TINYBIRD_WORKSPACE_ID`                   | Tinybird JWT workspace claim                      |
| `TINYBIRD_API_URL`                        | Tinybird API host                                 |
| `CLOUDFLARE_ACCOUNT_ID`                   | Cloudflare API target account                     |
| `CLOUDFLARE_API_TOKEN`                    | Cloudflare KV sync fallback token                 |
| `CLOUDFLARE_KV_NAMESPACE_ID`              | Proxy API key KV namespace                        |
| `CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID` | Collector Credential KV namespace                 |
| `AGENT_INGEST_SHARED_SECRET`              | Shared secret for agent-ingest HTTP actions       |
| `CLOUDFLARE_ANALYTICS_API_TOKEN`          | Preferred Analytics Engine read token             |
| `CLOUDFLARE_ANALYTICS_DATASET`            | Analytics Engine dataset for admin explorer       |
| Auth0 and Stripe values                   | Auth, subscriptions, and billing                  |

## Key Files

- `packages/convex/schema.ts` - table definitions and indexes
- `packages/convex/auth/` - users, organizations, invites, and Auth0 helpers
- `packages/convex/apiKeys.ts` - proxy API key CRUD
- `packages/convex/collectorCredentials.ts` - Collector Credential mint/list/revoke primitives
- `packages/convex/collectorLogin.ts` - CLI/Desktop device-flow mint path
- `packages/convex/agentSessionOwners.ts` - Agent Session ownership claim logic
- `packages/convex/collectorCompatibilityPolicy.ts` - active collector compatibility policy
- `packages/convex/integrations/tinybird.ts` - Tinybird JWT generation
- `packages/convex/integrations/cloudflare.ts` - KV sync actions
- `packages/convex/billing/` - subscriptions, usage, pricing, and Stripe integration
- `packages/convex/costAlerts.ts` - alert config and delivery state
- `packages/convex/http.ts` - HTTP routes, MCP routes, collector login, and agent-ingest actions
- `packages/convex/mcp/` - MCP OAuth/control-plane implementation
