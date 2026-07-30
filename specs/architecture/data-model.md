# Data Model Architecture

Trace Flow uses two databases with distinct purposes: Tinybird (ClickHouse) for high-volume trace analytics and Convex for user management and configuration. This document explains why we chose this split and how the data models are designed.

## Why Two Databases?

A single database could handle both traces and user data, but the access patterns are fundamentally different:

| Characteristic   | Traces (Tinybird)           | Users/Config (Convex)         |
| ---------------- | --------------------------- | ----------------------------- |
| Write pattern    | Append-only, high volume    | CRUD, low volume              |
| Read pattern     | Time-range aggregations     | Point lookups, real-time sync |
| Consistency      | Eventual (seconds)          | Strong (immediate)            |
| Scale            | Millions of rows/day        | Thousands of rows total       |
| Query complexity | Complex aggregations, GROUP | Simple filters, joins         |

Using the right tool for each workload provides better performance and simpler code.

## Tinybird (Trace Storage)

Tinybird provides managed ClickHouse with an HTTP API for ingestion and SQL queries. Traces are stored in OpenTelemetry format.

### Primary Datasource: `otel_trace_spans`

Defined in `datasources/otel_trace_spans.datasource`:

```
SCHEMA >
    `ReceivedAt` Int64 `json:$.ReceivedAt`,
    `Timestamp` Int64 `json:$.Timestamp`,
    `TraceId` String `json:$.TraceId`,
    `SpanId` String `json:$.SpanId`,
    `ParentSpanId` String `json:$.ParentSpanId`,
    `TraceState` String `json:$.TraceState`,
    `SpanName` LowCardinality(String) `json:$.SpanName`,
    `SpanKind` LowCardinality(String) `json:$.SpanKind`,
    `ServiceName` LowCardinality(String) `json:$.ServiceName`,
    `ResourceAttributes` String `json:$.ResourceAttributes`,
    `SpanAttributes` String `json:$.SpanAttributes`,
    `Duration` Int64 `json:$.Duration`,
    `StatusCode` LowCardinality(String) `json:$.StatusCode`,
    `StatusMessage` String `json:$.StatusMessage`,
    `ApiKey` LowCardinality(String) `json:$.ApiKey`,
    `Events.Timestamp` Array(Int64),
    `Events.Name` Array(String),
    `Events.Attributes` Array(String),
    `Links.TraceId` Array(String),
    `Links.SpanId` Array(String),
    `Links.TraceState` Array(String),
    `Links.Attributes` Array(String)

ENGINE "MergeTree"
ENGINE_SORTING_KEY "ReceivedAt, ApiKey, TraceId, SpanId"
ENGINE_PARTITION_KEY "toYYYYMMDD(toDateTime(ReceivedAt / 1000000000))"
ENGINE_TTL "toDateTime(ReceivedAt / 1000000000) + INTERVAL 90 DAY"
```

### Schema Design Decisions

#### Sorting Key: `ReceivedAt, ApiKey, TraceId, SpanId`

The sorting key determines physical data layout and query performance:

1. **ReceivedAt first**: Most queries filter by time range. Putting timestamp first enables efficient time-based scans.
2. **ApiKey second**: Every query is scoped to a user's API keys (row-level security). This enables efficient filtering after time range.
3. **TraceId, SpanId last**: For drilling into specific traces after filtering.

#### Partition Key: Daily Partitions

```
ENGINE_PARTITION_KEY "toYYYYMMDD(toDateTime(ReceivedAt / 1000000000))"
```

Daily partitions provide:

- **Efficient TTL**: Entire partitions are dropped, not individual rows
- **Query isolation**: Date range queries only scan relevant partitions
- **Manageable count**: ~90 partitions for 90-day retention

#### TTL: 90-Day Retention

```
ENGINE_TTL "toDateTime(ReceivedAt / 1000000000) + INTERVAL 90 DAY"
```

Automatic cleanup keeps storage costs manageable. Old partitions are dropped entirely.

#### LowCardinality Columns

Columns with few unique values use `LowCardinality(String)`:

- `SpanName`, `SpanKind`, `ServiceName`: Repeated per span
- `StatusCode`: Only a few possible values (OK, ERROR, UNSET)
- `ApiKey`: Each user has few keys

This provides dictionary encoding, reducing storage and improving query performance.

#### JSON Attributes as Strings

`ResourceAttributes` and `SpanAttributes` are stored as JSON strings:

```
`SpanAttributes` String `json:$.SpanAttributes`
```

This enables:

- Flexible schema evolution (new attributes without migrations)
- Query-time extraction via ClickHouse JSON functions
- No column explosion from dynamic attributes

Common attributes are extracted into the materialized view for indexed access.

### Materialized View: `otel_genai_spans`

Defined in `datasources/otel_genai_spans.datasource`:

```
DESCRIPTION >
    Materialized view with extracted GenAI semantic convention attributes.
    Provides indexed columns for efficient filtering on operation, provider, and model.

SCHEMA >
    // ... all columns from otel_trace_spans, plus:
    `OperationName` LowCardinality(String),
    `Provider` LowCardinality(String),
    `Model` LowCardinality(String)

ENGINE_SORTING_KEY "ReceivedAt, ApiKey, OperationName, TraceId, SpanId"
```

The materialized view:

- Extracts common GenAI attributes into indexed columns
- Provides efficient filtering by operation, provider, and model
- Uses different sorting key optimized for GenAI queries

### Span Attributes

Traces store rich metadata in `SpanAttributes` following OpenTelemetry GenAI semantic conventions:

| Attribute                              | Purpose                            |
| -------------------------------------- | ---------------------------------- |
| `gen_ai.system`                        | Provider name (openai, anthropic)  |
| `gen_ai.request.model`                 | Requested model                    |
| `gen_ai.response.model`                | Actual model used                  |
| `gen_ai.operation.name`                | Operation type (chat, embeddings)  |
| `gen_ai.usage.input_tokens`            | Prompt tokens                      |
| `gen_ai.usage.output_tokens`           | Completion tokens                  |
| `gen_ai.usage.reasoning_tokens`        | Reasoning tokens (o1, etc.)        |
| `gen_ai.usage.cache_read_input_tokens` | Cached input tokens                |
| `gen_ai.server.time_to_first_token`    | TTFT in milliseconds               |
| `gen_ai.tokens_per_second`             | Generation speed                   |
| `gen_ai.cost.total`                    | Computed cost in microdollars      |
| `gen_ai.finish_reason`                 | Why generation stopped             |
| `baggage.*`                            | W3C baggage propagated from client |

### Events

Span events capture significant moments within a span:

| Event Name                   | Purpose                      |
| ---------------------------- | ---------------------------- |
| `output.time_to_first_token` | First content chunk received |
| `input.system`               | System prompt provided       |
| `input.text`                 | User text content            |
| `input.tool_result`          | Tool result provided         |
| `output.text`                | Text content generated       |
| `output.thinking`            | Reasoning content            |
| `output.tool_use`            | Tool call generated          |

## Tinybird (Agent Analytics Storage)

Agent Conversation Analytics uses separate typed datasources. Agent conversations are not proxied LLM requests, so they are not forced through `otel_trace_spans`.

### Base Fact Tables

The agent consumer writes five base fact tables:

| Datasource                        | Grain                                           | Purpose                                                               |
| --------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| `agent_message_facts`             | one agent message or model-call turn            | Tokens, model labels, coverage, estimated cost                        |
| `agent_tool_event_facts`          | one reconciled tool invocation                  | Tool names, command families, status, duration, redacted excerpts     |
| `agent_file_event_facts`          | one repo-relative file touch                    | File attention and hotspots without absolute local paths              |
| `agent_capability_snapshot_facts` | one conversation-visible capability observation | Privacy-safe counts and hashes for later context-surface analysis     |
| `agent_pull_request_facts`        | one canonical Pull Request link observation     | Passive PR attribution evidence without local GitHub or provider auth |

The ingest worker stamps `OrgId`, `UserId`, `collector_id`, stable `session_pk`, row `*_pk`, and `repo_fingerprint` before enqueueing. The collector sends source-visible IDs and parsed facts only; it never sends trusted tenancy, final primary keys, or cost.

### Agent Serving Tables

Derived tables keep dashboard and MCP reads bounded:

| Datasource                           | Grain                                | Purpose                                           |
| ------------------------------------ | ------------------------------------ | ------------------------------------------------- |
| `agent_session_summaries`            | one Agent Session                    | Session outliers, cost totals, duration, coverage |
| `agent_usage_hourly` / `_daily`      | time bucket by org/source/repo/model | Cost, token, cache, message, and session trends   |
| `agent_tool_usage_hourly` / `_daily` | time bucket by org/source/repo/tool  | Tool mix and failure-rate trends                  |
| `agent_repositories`                 | one normalized repo identity         | Repo lookup and filter support                    |

ADR 0019 adds the next derived signal layer (`agent_session_signals`, file-attention signals, repo rollups, and daily baselines). Product endpoints should read bounded serving models instead of broad raw fact scans.

### Agent Schema Decisions

- Agent fact tables use stable source-derived identities so duplicate collector uploads do not inflate counts.
- `AGENT_FACT_BATCHER` keeps a Durable Object SQLite ledger keyed by `(OrgId, fact type, fact id)`. Exact duplicates are skipped; same-key changed facts become repair signals.
- Numeric token and cache columns are non-null. Missing source data is represented by `token_coverage` and `cache_coverage`.
- `cost_usd` is the only nullable metric column because pricing can be missing or coverage can be insufficient.
- File paths are repo-relative or coarse categories such as `outside_repo`; no stored path should contain a home directory or username.
- Agent Ingest is fact-only. Its legacy optional `raw_session_bundles` wire slots are unused and slated for removal; the planned lossless path sends Archive JSONL from an enrolled Collector to the separate Archive API defined by ADR 0012.

## Convex (User/Config Storage)

Convex provides real-time backend-as-a-service with strong consistency and reactive queries.

### Schema Overview

Defined in `packages/convex/schema.ts`:

```typescript
export default defineSchema({
  users: defineTable({ ... }),
  apiKeys: defineTable({ ... }),
  modelPricing: defineTable({ ... }),
  alerts: defineTable({ ... }),
  collectorCredentials: defineTable({ ... }),
  agentSessionOwners: defineTable({ ... }),
  collectorCompatibilityPolicy: defineTable({ ... }),
  mcpSessions: defineTable({ ... }),
  mcpRefreshTokens: defineTable({ ... }),
  mcpClients: defineTable({ ... }),
  mcpAuthCodes: defineTable({ ... }),
});
```

### Users Table

```typescript
users: defineTable({
  tokenIdentifier: v.string(), // Auth0 subject identifier
  email: v.string(),
  name: v.optional(v.string()),
  picture: v.optional(v.string()),
  enabled: v.boolean(),
}).index('by_token_identifier', ['tokenIdentifier']);
```

Created on first login via Auth0. The `enabled` flag allows soft-disabling users.

### API Keys Table

```typescript
apiKeys: defineTable({
  key: v.string(), // UUID, stored in KV for proxy validation
  expiresAt: v.number(),
  userId: v.optional(v.id('users')),
  name: v.optional(v.string()), // User-assigned label
}).index('by_user_id', ['userId']);
```

API keys serve as the bridge between databases:

1. **Created in Convex**: User generates key via dashboard
2. **Synced to KV**: Cloudflare action writes to Workers KV for proxy auth
3. **Stored in traces**: `ApiKey` column in Tinybird traces
4. **Used for row-level security**: JWT `fixed_params` filters by user's keys

### Model Pricing Table

```typescript
modelPricing: defineTable({
  provider: v.string(),
  model: v.string(),
  promptCostPerMillion: v.number(),
  completionCostPerMillion: v.number(),
  cacheReadCostPerMillion: v.optional(v.number()),
  cacheWriteCostPerMillion: v.optional(v.number()),
  reasoningCostPerMillion: v.optional(v.number()),
  source: v.union(v.literal('manual'), v.literal('openrouter'), v.literal('default')),
  updatedAt: v.number(),
})
  .index('by_provider', ['provider'])
  .index('by_provider_model', ['provider', 'model']);
```

Pricing data is used by the Proxy Consumer and Agent Consumer to calculate costs. Sources:

- **manual**: Admin-entered pricing
- **openrouter**: Auto-fetched from OpenRouter API
- **default**: Fallback defaults

Pricing is synced to a KV namespace for fast lookup during queue processing.

### Alerts Table

```typescript
alerts: defineTable({
  name: v.string(),
  field: v.string(), // e.g., "latency", "error_rate"
  operator: v.string(), // e.g., ">", "<", "=="
  value: v.union(v.number(), v.string(), v.boolean()),
  severity: v.string(),
  enabled: v.boolean(),
  userId: v.id('users'),
  createdAt: v.number(),
  updatedAt: v.number(),
}).index('by_user_id', ['userId']);
```

Alert definitions stored for future alerting implementation.

### MCP Tables

Tables supporting Model Context Protocol (MCP) server functionality:

```typescript
mcpSessions: defineTable({ ... })      // Active MCP sessions
mcpRefreshTokens: defineTable({ ... }) // OAuth refresh tokens
mcpClients: defineTable({ ... })       // Registered OAuth clients
mcpAuthCodes: defineTable({ ... })     // OAuth authorization codes
```

These support Claude Desktop and other MCP clients accessing trace data.

## Data Relationships

### API Keys as Foreign Keys

API keys connect the two databases:

```
┌─────────────────────────┐
│        Convex           │
├─────────────────────────┤
│ users                   │
│   └─> apiKeys (userId)  │
└───────────┬─────────────┘
            │
            │ key (UUID)
            │
            ▼
┌─────────────────────────┐
│       Tinybird          │
├─────────────────────────┤
│ otel_trace_spans             │
│   ApiKey column         │
└─────────────────────────┘
```

### Row-Level Security Flow

1. User authenticates via Auth0
2. Convex fetches user's API keys from `apiKeys` table
3. Convex generates Tinybird JWT with `fixed_params: { api_keys: "key1,key2" }`
4. Tinybird queries automatically filter: `WHERE ApiKey IN (splitByChar(',', {api_keys}))`

```typescript
// In Convex tinybird.ts
const scopesWithApiKeys = args.scopes.map((scope) => ({
  ...scope,
  fixed_params: {
    api_keys: userApiKeys.join(',') || '__NO_KEYS__',
  },
}));
```

The sentinel value `__NO_KEYS__` prevents matching empty strings when a user has no API keys.

Agent pipes also receive `org_id` as a fixed parameter. Agent rows are scoped by organization rather than by user-facing API key because Collector Credentials are not API keys and never appear in API-key filters.

### Collector Credentials And Agent Ownership

Collector Credentials are hidden credentials for the CLI/Desktop collector. They are separate from user-facing API keys:

```typescript
collectorCredentials: defineTable({
  hashedSecret: v.string(),
  orgId: v.id('organizations'),
  userId: v.id('users'),
  collectorId: v.string(),
  status: v.union(v.literal('active'), v.literal('revoked')),
  expiresAt: v.number(),
});
```

Convex syncs active credential hashes to the `COLLECTOR_CREDS` KV namespace for Agent Ingest lookup. The plaintext secret is returned once at mint time and lives in the collector's credential store.

Agent Session ownership is claimed separately:

```typescript
agentSessionOwners: defineTable({
  orgId: v.id('organizations'),
  sessionPk: v.string(),
  userId: v.id('users'),
  collectorId: v.string(),
  claimedAt: v.number(),
}).index('by_org_session', ['orgId', 'sessionPk']);
```

This keeps session identity stable across credential rotation while preventing the same `OrgId + session_pk` from being silently overwritten by another user.

## Query Patterns

### Time-Range Aggregation (Tinybird)

```sql
SELECT
  toStartOfHour(toDateTime(Timestamp / 1000000000)) as hour,
  count() as requests,
  avg(Duration / 1000000) as avg_latency_ms
FROM otel_trace_spans
WHERE ReceivedAt BETWEEN {start} AND {end}
  AND ApiKey IN splitByChar(',', {api_keys})
GROUP BY hour
ORDER BY hour
```

### Trace Lookup (Tinybird)

```sql
SELECT *
FROM otel_trace_spans
WHERE TraceId = {trace_id}
  AND ApiKey IN splitByChar(',', {api_keys})
ORDER BY Timestamp
```

### User Data (Convex)

```typescript
// Real-time reactive query
const apiKeys = useQuery(api.apiKeys.list);

// Point mutation
await ctx.db.insert('apiKeys', {
  key: crypto.randomUUID(),
  expiresAt: args.expiresAt,
  userId: user._id,
});
```

### Agent Sessions (Tinybird)

```sql
SELECT *
FROM agent_session_summaries
WHERE OrgId = {org_id}
ORDER BY LastEventAt DESC
LIMIT 100
```

Agent dashboard and MCP surfaces should prefer serving tables and bounded pipes over broad scans of base facts. Raw `agent_*_facts` reads are for diagnostics and derivation, not the default product contract.

## Data Lifecycle

### Trace Data

1. **Creation**: Consumer worker inserts via Tinybird Events API
2. **Retention**: 90 days (TTL on partition)
3. **Deletion**: Automatic via ClickHouse TTL mechanism

### User Data

1. **Creation**: On first Auth0 login
2. **Updates**: Via Convex mutations (real-time)
3. **Deletion**: Manual (GDPR compliance)

### API Keys

1. **Creation**: User generates via dashboard
2. **Sync**: Convex action writes to Cloudflare KV
3. **Expiration**: Checked at proxy validation time
4. **Deletion**: User revokes; Convex action removes from KV

### Agent Facts

1. **Creation**: Agent Consumer inserts via Tinybird Events API after `AGENT_FACT_BATCHER` dedupe
2. **Retention**: Base facts and serving aggregates follow the one-year agent analytics retention model
3. **Duplication**: Same-key same-content facts are skipped before Tinybird
4. **Repair**: Same-key changed-content facts are recorded as repair signals for explicit rebuild paths

### Collector Credentials

1. **Creation**: Convex mints a hidden Collector Credential for CLI/Desktop
2. **Sync**: Convex syncs the hashed secret to `COLLECTOR_CREDS` KV
3. **Use**: Agent Ingest authenticates the raw secret against the hash
4. **Revocation**: Convex marks the credential revoked and removes it from KV

## Schema Evolution

### Tinybird

New attributes can be added to `SpanAttributes` JSON without schema changes. For new indexed columns:

1. Create new materialized view with additional columns
2. Use `FORWARD_QUERY` for zero-downtime migration
3. Switch queries to new view
4. Drop old view

### Convex

Schema changes are managed via Convex's migration system:

1. Add new optional fields first
2. Backfill data if needed
3. Make fields required after backfill
4. Convex validates schema at deploy time
