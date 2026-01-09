# Convex Backend

Convex provides the real-time backend services for Trace Flow, handling user management, API keys, alerts, model pricing, and Tinybird token generation. It also exposes an MCP server for agent access to trace data.

## Why Convex

Convex was chosen for several reasons:

1. **Real-time by Default**: Queries automatically resubscribe, keeping the dashboard live without polling infrastructure.

2. **Type Safety**: End-to-end TypeScript with generated types means the frontend and backend schemas stay in sync.

3. **Auth0 Integration**: Native Auth0 support with role-based access control through token claims.

4. **Actions for External APIs**: HTTP actions make it easy to call Cloudflare, Tinybird, and OpenRouter APIs.

5. **Managed Infrastructure**: No database or server management required; scales automatically.

## Schema

### users

Stores authenticated users synced from Auth0.

| Field           | Type    | Purpose                            |
| --------------- | ------- | ---------------------------------- |
| tokenIdentifier | string  | Auth0 subject claim for matching   |
| email           | string  | User's email address               |
| name            | string? | Display name                       |
| picture         | string? | Profile picture URL                |
| enabled         | boolean | Whether user can access the system |

### apiKeys

API keys for proxy authentication.

| Field     | Type       | Purpose                   |
| --------- | ---------- | ------------------------- |
| key       | string     | The API key value (UUID)  |
| expiresAt | number     | Expiration timestamp (ms) |
| userId    | Id<users>? | Owner of the key          |
| name      | string?    | Friendly name             |

### modelPricing

Cost data for calculating request expenses.

| Field                    | Type   | Purpose                                 |
| ------------------------ | ------ | --------------------------------------- |
| provider                 | string | Provider name (openai, anthropic, etc.) |
| model                    | string | Model identifier                        |
| promptCostPerMillion     | number | Input token cost (microdollars/M)       |
| completionCostPerMillion | number | Output token cost (microdollars/M)      |
| source                   | string | Origin: manual, openrouter, or default  |

### alerts

User-defined alert rules for request monitoring.

| Field    | Type                  | Purpose                                           |
| -------- | --------------------- | ------------------------------------------------- |
| name     | string                | Display name                                      |
| field    | string                | Metric to monitor (duration_ms, cost_total, etc.) |
| operator | string                | Comparison (gt, gte, lt, lte, eq, neq)            |
| value    | number/string/boolean | Threshold value                                   |
| severity | string                | info, warning, or error                           |
| enabled  | boolean               | Whether alert is active                           |

### MCP Tables

Several tables support the Model Context Protocol server:

- **mcpSessions**: Active MCP sessions with state tracking
- **mcpRefreshTokens**: Stored refresh tokens for OAuth flow
- **mcpClients**: Registered OAuth clients
- **mcpAuthCodes**: Authorization codes for OAuth exchange

## Key Functions

### Tinybird Token Generation

`tinybird.generateToken` creates scoped JWTs for frontend Tinybird access:

1. Fetches user's API keys from database
2. Builds scope list with fixed_params containing API keys
3. Signs JWT with Tinybird admin token (HS256)
4. Returns short-lived token (10 min default)

The fixed_params ensure row-level security: queries only return data matching the user's API keys.

### API Key Sync to KV

When API keys are created or deleted, Convex syncs them to Cloudflare KV:

**Creation**:

1. Mutation inserts key into Convex
2. Schedules `cloudflare.syncKeyToKV` action
3. Action calls Cloudflare API to PUT key in KV

**Deletion**:

1. Mutation deletes key from Convex
2. Schedules `cloudflare.deleteKeyFromKV` action
3. Action calls Cloudflare API to DELETE key from KV

This two-phase approach ensures the Convex mutation completes quickly while the KV sync happens asynchronously.

### Pricing Sync

Model pricing follows a similar pattern:

1. Pricing is stored in Convex for dashboard display
2. On upsert, schedules sync to Cloudflare KV
3. Consumer worker reads pricing from KV for cost calculation

Sources of pricing data:

- **Manual**: Admin enters directly in dashboard
- **OpenRouter**: Bulk import via `importFromOpenRouter` action
- **Default**: Hardcoded common models via `syncDefaults`

## MCP Server

Convex exposes an MCP (Model Context Protocol) server for AI agent access:

### Protocol Support

- JSON-RPC 2.0 transport
- Protocol versions: 2024-11-05, 2025-03-26
- Implements initialize, ping, tools/list, tools/call

### Available Tools

**list_traces**: Query recent traces with filters

- Parameters: provider, model, status, limit, hours, cursor
- Returns: Paginated list of trace summaries

**get_trace**: Fetch single trace details

- Parameters: trace_id
- Returns: Full trace with spans and events

**get_trace_spans**: Get spans for a trace

- Parameters: trace_id, expand, span_names, min_duration_ms, etc.
- Returns: Filtered and sorted span list

**get_trace_events**: Get events for a trace

- Parameters: trace_id, span_id, event_names, limit, cursor
- Returns: Input/output events with attributes

### OAuth Integration

The MCP server supports OAuth 2.0 for authentication:

1. Client initiates authorization at `/authorize`
2. User redirected to Auth0 for login
3. Auth0 redirects back with code
4. Client exchanges code for tokens at `/token`
5. Tokens used for subsequent MCP requests

Refresh tokens are stored encrypted in Convex.

## HTTP Routes

Convex exposes HTTP endpoints for OAuth flow:

- `GET /authorize` - Initiate OAuth flow
- `POST /token` - Exchange code for tokens
- `POST /mcp` - MCP message endpoint

## Environment Variables

| Variable                     | Purpose                  |
| ---------------------------- | ------------------------ |
| `TINYBIRD_ADMIN_TOKEN`       | Signs Tinybird JWTs      |
| `TINYBIRD_WORKSPACE_ID`      | Workspace for JWT claims |
| `CLOUDFLARE_ACCOUNT_ID`      | For KV API calls         |
| `CLOUDFLARE_API_TOKEN`       | Auth for Cloudflare API  |
| `CLOUDFLARE_KV_NAMESPACE_ID` | Target KV namespace      |

## Key Files

- `packages/convex/schema.ts` - Database schema definitions
- `packages/convex/tinybird.ts` - JWT generation for Tinybird
- `packages/convex/apiKeys.ts` - API key CRUD operations
- `packages/convex/alerts.ts` - Alert rule management
- `packages/convex/modelPricing.ts` - Pricing data management
- `packages/convex/cloudflare.ts` - Cloudflare KV sync actions
- `packages/convex/mcp/handler.ts` - MCP message handling
- `packages/convex/mcp/tools/` - MCP tool implementations
