# Web Worker

The Web app is a Next.js App Router dashboard deployed to Cloudflare Workers through OpenNext. It is
the authenticated read surface for proxied LLM traces, LLM usage, operations, billing, admin tools,
and Agent Conversation Analytics.

## Responsibilities

- Authenticate users with Auth0 and initialize Convex user/org state.
- Render trace, request, usage, operation, alert, billing, and admin views.
- Render `/app/agents` from Tinybird `agent_*` pipes using org-scoped JWTs minted by Convex.
- Fetch request/response bodies from the API Worker with Auth0 bearer tokens.
- Serve public documentation from `apps/web/public`.

The Web app does not write trace rows, agent facts, request/response bodies, API keys, or Collector
Credentials directly. It calls Convex or read-side Workers for those boundaries.

## Tech Stack

- Next.js App Router
- OpenNext for Cloudflare Workers deployment
- React 19
- Tailwind CSS
- shadcn/ui and Radix primitives
- TanStack Query
- Convex React client
- Auth0

## Main Routes

| Route                     | Purpose                                                   |
| ------------------------- | --------------------------------------------------------- |
| `/app`                    | LLM usage dashboard and onboarding state                  |
| `/app/requests`           | Individual proxied LLM requests                           |
| `/app/traces`             | Trace-level span groups                                   |
| `/app/trace/[traceId]`    | Span tree, timing, events, and body viewer                |
| `/app/operations`         | Operation/provider/model/user analytics                   |
| `/app/agents`             | Agent session, tool, repo, token, cost, and failure views |
| `/app/api-keys`           | User-facing proxy API key management                      |
| `/app/alerts`             | Cost and usage alert configuration                        |
| `/app/pricing`            | Model pricing management                                  |
| `/app/settings/billing`   | Stripe billing and subscription state                     |
| `/app/admin/*`            | Admin-only operational surfaces                           |
| `/docs/*` and public root | Public docs and marketing surfaces                        |

## Data Fetching

### Tinybird Reads

`apps/web/src/hooks/useTinybirdQuery.ts` calls `apps/web/src/lib/tinybird.ts`, which:

1. asks Convex action `api.integrations.tinybird.generateToken` for a short-lived JWT
2. calls the selected Tinybird Pipe
3. refreshes once on Tinybird auth failure
4. lets TanStack Query own cache and retry behavior

Convex stamps both API-key and org row-security parameters onto Tinybird scopes:

- LLM trace and usage pipes filter by `api_keys` plus `retention_days`.
- Agent analytics pipes filter by `org_id` and do not use Collector Credential IDs or API keys as the
  read identity.

### Body Reads

Trace detail fetches stored bodies from the API Worker. The API Worker validates the Auth0 token,
checks organization membership against R2 object metadata, applies the current visibility window, and
decrypts the stored body payload.

### Agent Analytics

`/app/agents` reads these Tinybird pipe families:

- `agent_usage_summary`
- `agent_usage_timeseries`
- `agent_usage_breakdown`
- `agent_sessions_browser`
- `agent_failure_leaderboard`
- `agent_tool_period_delta`
- `agent_repo_directory`

Agent analytics remains under the production-readiness gate in
`docs/guides/agent-conversation-analytics/ROADMAP.md`. The route exists, but launch requires the
normal-user collector flow, smoke verification, truth states, and alerts in that roadmap.

## Convex Integration

The dashboard uses Convex for:

- authenticated user and organization membership
- API key CRUD and KV sync scheduling
- Collector Credential list/revoke surfaces
- model pricing and pricing KV sync
- billing, subscriptions, and usage state
- cost alerts
- Tinybird JWT minting
- admin actions

## Environment Variables

| Variable                                  | Purpose                                     |
| ----------------------------------------- | ------------------------------------------- |
| `NEXT_PUBLIC_CONVEX_URL`                  | Convex deployment URL baked into the build  |
| `NEXT_PUBLIC_AUTH0_DOMAIN`                | Auth0 tenant domain                         |
| `NEXT_PUBLIC_AUTH0_CLIENT_ID`             | Auth0 application ID                        |
| `NEXT_PUBLIC_API_URL`                     | API Worker URL for body fetching            |
| `NEXT_PUBLIC_TINYBIRD_API_URL`            | Tinybird API endpoint                       |
| `NEXT_PUBLIC_SENTRY_DSN`                  | Browser Sentry DSN                          |
| `NEXT_PUBLIC_LAUNCHDARKLY_CLIENT_SIDE_ID` | LaunchDarkly client-side ID                 |
| `NEXT_PUBLIC_DEPLOY_ID`                   | Build/deploy identifier                     |
| `APP_BASE_URL`                            | Canonical Web origin for server-side checks |
| `AUTH0_SECRET`                            | Auth0 session encryption secret             |
| `AUTH0_CLIENT_SECRET`                     | Auth0 app client secret                     |

## Key Files

- `apps/web/src/app/app/layout.tsx` - authenticated app shell
- `apps/web/src/app/app/AppLayoutClient.tsx` - client-side dashboard layout wrapper
- `apps/web/src/components/AppSidebar.tsx` - app navigation
- `apps/web/src/hooks/useTinybirdQuery.ts` - Tinybird query hook
- `apps/web/src/lib/tinybird.ts` - Tinybird token and fetch helper
- `apps/web/src/lib/bodies.ts` - API Worker body fetch helper
- `apps/web/src/app/app/agents/page.tsx` - Agent analytics route
- `apps/web/src/components/agents/` - Agent analytics UI and query composition
- `apps/web/src/components/usage/` - LLM usage dashboard
- `apps/web/src/components/requests/` - request list and detail panel
- `apps/web/src/components/traces/` - trace list and trace detail
