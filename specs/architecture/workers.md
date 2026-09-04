# Worker Architecture

The primary observability runtime is split into six Cloudflare Workers, each with a focused responsibility. This document explains why we chose this separation and how those workers communicate. The repo also has an MCP Worker for agent access to trace data; it is a separate read-side integration, not part of the proxy or collector ingestion paths.

## Why Separate Workers?

A single monolithic worker would be simpler to deploy but would create several problems:

1. **Conflicting execution models**: The proxy must respond in milliseconds; consumers can take seconds to process batches
2. **Resource contention**: Queue processing consumes CPU that could affect proxy latency
3. **Different auth boundaries**: LLM proxy API keys, dashboard Auth0 JWTs, and Collector Credentials are separate security domains
4. **Deployment coupling**: A bug in trace or agent-fact processing would require redeploying the proxy
5. **Scaling mismatch**: Proxy and ingest workers scale with request volume; consumers scale with processing load

Splitting into focused workers provides isolation, independent scaling, and cleaner failure domains.

## Proxy Worker

**Location**: `apps/proxy/`

**Responsibility**: Accept client LLM requests, forward to providers, stream responses, and capture data without adding latency.

### What It Owns

- Route resolution: mapping `/openai/*`, `/anthropic/*`, etc. to provider URLs
- API key authentication via KV namespace lookup
- Request/response body capture during streaming
- SSE parsing for streaming responses (time-to-first-token, content blocks)
- R2 storage of bodies
- Queue message creation and send

### What It Does NOT Own

- Trace transformation (queue messages are raw capture data)
- Cost calculation or pricing lookups
- User management or authorization
- Any synchronous external calls that could add latency

### Communication

- **Inbound**: HTTP requests from clients (SDKs, agents)
- **Outbound**:
  - HTTP to LLM providers (OpenAI, Anthropic, etc.)
  - R2 for body storage
  - Cloudflare Queue for async processing
  - KV for API key validation

### Scaling Characteristics

The proxy is stateless and scales horizontally. Each request is independent. The main constraint is the 30-second execution limit for Workers, but LLM streaming responses rarely exceed this.

**Performance-critical path**: Everything from request receipt to response streaming. All observability operations happen in `waitUntil()` after the response completes.

### Configuration

Defined in `apps/proxy/wrangler.toml`:

```toml
[[queues.producers]]
queue = "trace-flow-requests-dev"
binding = "REQUEST_QUEUE"

[[r2_buckets]]
binding = "STORAGE"
bucket_name = "trace-flow-storage-dev"

[[kv_namespaces]]
binding = "API_KEYS"
id = "30c9a31ff3af4b408b4d64b8ecfa98a5"
```

## Proxy Consumer Worker

**Location**: `apps/proxy-consumer/`

**Responsibility**: Process LLM trace queue batches, transform them into OpenTelemetry traces, calculate costs, and batch insert to Tinybird.

### What It Owns

- Queue consumption and message acknowledgment
- Trace transformation (queue message to OpenTelemetry format)
- Cost calculation using model pricing from KV
- OpenRouter pricing auto-fetch for unknown models
- Durable Object coordination for batch accumulation
- Tinybird insertion with retry logic

### What It Does NOT Own

- R2 body reading (bodies are stored by proxy, read by API worker)
- Real-time processing guarantees (batching introduces latency)
- User-facing APIs
- Agent conversation facts

### Communication

- **Inbound**: Queue messages from proxy worker
- **Outbound**:
  - Durable Objects for trace batching
  - KV for model pricing lookup
  - Tinybird Events API for trace insertion

### Scaling Characteristics

Queue consumers scale based on queue depth. Cloudflare automatically adjusts concurrency up to the configured `max_concurrency` (20). Each consumer processes up to 100 messages per batch.

**Key constraint**: Tinybird insertion latency. The Durable Object batching pattern aggregates traces to minimize API calls.

### Configuration

Defined in `apps/proxy-consumer/wrangler.toml`:

```toml
[[queues.consumers]]
queue = "trace-flow-requests-dev"
max_batch_size = 100
max_batch_timeout = 5
max_concurrency = 20
max_retries = 5
dead_letter_queue = "trace-flow-requests-dlq-dev"

[[durable_objects.bindings]]
name = "TRACE_BATCHER"
class_name = "TraceBatcher"
```

### TraceBatcher Durable Object

The `TraceBatcher` is a Durable Object that:

1. Accepts traces from queue consumers
2. Stores them in local SQLite until reaching batch size (10,000) or timeout (5 seconds)
3. Flushes to Tinybird in bulk
4. Uses alarms for time-based flushing
5. Persists unflushed traces across restarts

Sharding by API key hash distributes load across multiple instances:

```typescript
const shardId = calculateShardId(apiKey, NUM_SHARDS);
const batcherId = env.TRACE_BATCHER.idFromName(`batcher-${shardId}`);
```

## Agent Ingest Worker

**Location**: `apps/agent-ingest/`

**Responsibility**: Accept collector uploads, authenticate Collector Credentials, validate and normalize agent fact envelopes, claim session ownership, and enqueue sub-128 KiB fact messages for the agent consumer.

Agent analytics is still not production-ready until the gates in `docs/guides/agent-conversation-analytics/ROADMAP.md` are complete.

### What It Owns

- Collector Credential authentication via `COLLECTOR_CREDS` KV
- Convex-owned compatibility policy enforcement for desktop/parser versions
- Per-org ingest rate limiting via `AGENT_INGEST_LIMITER`
- Gzip body inflation with request-size caps
- Envelope shape validation
- Server-side re-redaction of free-text excerpts
- Stable `session_pk`, row `*_pk`, and `repo_fingerprint` assembly
- First-writer Agent Session ownership claims through Convex
- Queue chunking and `sendBatch` enqueue to `AGENT_QUEUE`

### What It Does NOT Own

- Model pricing or cost calculation
- Tinybird writes
- User-facing API key auth
- LLM proxying
- Conversation Archive R2 storage. Agent Ingest envelopes are fact-only; Archive JSONL uses the separately enrolled durable archive path defined by ADR 0012.

### Communication

- **Inbound**: `POST /v1/ingest` from Trace Flow CLI/Desktop collectors
- **Outbound**:
  - KV for Collector Credential lookup
  - Convex HTTP routes for compatibility policy and session ownership claims
  - Cloudflare Rate Limiting for per-org burst control
  - Cloudflare Queue for agent fact messages

### Configuration

Defined in `apps/agent-ingest/wrangler.jsonc`:

```jsonc
"kv_namespaces": [{ "binding": "COLLECTOR_CREDS", "id": "..." }],
"queues": {
  "producers": [{ "queue": "agent-ingest-dev", "binding": "AGENT_QUEUE" }]
},
"ratelimits": [{ "name": "AGENT_INGEST_LIMITER", "namespace_id": "2006" }]
```

Production uses `trace-flow-agent-ingest`, `collector.trace-flow.dev`, the production `COLLECTOR_CREDS` namespace, and `agent-ingest-prod`.

## Archive API Worker (Planned)

**Target location**: `apps/archive-api/`

**Production origin**: `https://archive.trace-flow.dev`

**Current scaffold**: Authorization-boundary Worker only. Uploads require an active
Collector Credential plus a current Convex enrollment and Source decision. Export and
deletion routes exist as fail-closed Archive Export Grant placeholders. Authorized
uploads return `501 persistence_not_implemented`. This slice does not persist archive
data, mint grants, write R2, run ledgers, encrypt, provision routes, or enable
production.

**Target responsibility**: Serve the complete Conversation Archive data plane without
adding transcript content or archive key material to Agent Ingest or Raw API.

### Planned ownership (not shipped)

- Pro entitlement and 100 GB archive-cap enforcement
- Archive Spool upload acknowledgement
- Session-ledger-controlled Archive Chunk and manifest writes
- Archive Session Ledger Durable Objects for concurrent upload ordering and retry deduplication
- Independent versioned Archive Encryption Keys and rotation
- Short-lived owner Archive Export Grant validation and bounded decrypted export reads
- Archive Contribution and whole-archive deletion
- The dedicated Agent Archive R2 bucket
- Authenticated internal publication of durable acknowledgements, Storage Budget values, and
  lifecycle transitions to the Convex Archive Status projection

### What It Does NOT Own

- Parsed fact ingest or `AGENT_QUEUE`
- Tinybird reads, writes, or credentials
- Proxy Body Objects or `BODY_ENCRYPTION_ROOT_KEY`
- Analyst Sandbox storage

## Agent Consumer Worker

**Location**: `apps/agent-consumer/`

**Responsibility**: Drain the agent ingest queue, price Agent Message facts, map typed facts into Tinybird rows, dedupe by stable fact identity, and write `agent_*` datasources.

### What It Owns

- Queue consumption and message acknowledgment/retry
- Queue contract validation
- Agent Message pricing through the shared `MODEL_PRICING` KV catalog
- Row mapping for messages, tool events, file events, capability snapshots, and pull request links
- Org-sharded `AGENT_FACT_BATCHER` Durable Object coordination
- Tinybird Events API insertion for `agent_*` datasources
- Repair-signal detection for same-key changed facts

### What It Does NOT Own

- Collector Credential authentication
- Session ownership claims
- Raw transcript parsing
- LLM request trace spans
- Dashboard read APIs

### Communication

- **Inbound**: Queue messages from Agent Ingest
- **Outbound**:
  - KV for model pricing lookup
  - Durable Objects for fact dedupe and insert batching
  - Tinybird Events API for `agent_*` datasources

### Scaling Characteristics

The consumer scales with `agent-ingest-{env}` queue depth. It processes up to 100 messages per batch, uses bounded concurrency, and retries contributing messages when the fact ledger or Tinybird insert path fails. Duplicate redelivery is absorbed by the Durable Object ledger before Tinybird insert.

### Configuration

Defined in `apps/agent-consumer/wrangler.jsonc`:

```jsonc
"queues": {
  "consumers": [{
    "queue": "agent-ingest-dev",
    "max_batch_size": 100,
    "max_batch_timeout": 5,
    "max_concurrency": 10,
    "max_retries": 5,
    "dead_letter_queue": "agent-ingest-dlq-dev"
  }]
},
"kv_namespaces": [{ "binding": "MODEL_PRICING", "id": "..." }],
"durable_objects": {
  "bindings": [{ "name": "AGENT_FACT_BATCHER", "class_name": "AgentFactBatcher" }]
}
```

Production uses `trace-flow-agent-consumer`, `agent-ingest-prod`, `agent-ingest-dlq-prod`, and the production model-pricing namespace.

## API Worker

**Location**: `apps/api/`

**Responsibility**: Serve request/response bodies from R2 to the web dashboard.

### What It Owns

- R2 body retrieval
- Auth0 JWT validation for web dashboard access
- CORS handling for browser requests

### What It Does NOT Own

- Body storage (handled by proxy)
- Trace queries (handled by frontend to Tinybird directly)
- User management
- Agent analytics ingest

### Communication

- **Inbound**: HTTP requests from web dashboard
- **Outbound**: R2 for body retrieval

### Why a Separate Worker?

The API worker exists because:

1. **Auth separation**: Uses Auth0 JWT validation (user identity), not API key auth
2. **CORS requirements**: Browser requests need proper CORS headers
3. **Access pattern**: Bodies are fetched on-demand when viewing trace details, not during ingestion

### Configuration

Defined in `apps/api/wrangler.toml`:

```toml
[[r2_buckets]]
binding = "STORAGE"
bucket_name = "trace-flow-storage-dev"

[vars]
AUTH0_DOMAIN = "auth0.zaks.io"
AUTH0_CLIENT_ID = "iyvisDUHrcsFGZYWdxZrX7LH8rtnT50W"
```

## Web Worker (OpenNext)

**Location**: `apps/web/`

**Responsibility**: Serve the dashboard and provide the user interface.

### What It Owns

- Next.js SSR and static assets via OpenNext on Cloudflare Workers
- React-based dashboard UI
- Tinybird query generation and execution
- LLM trace and agent analytics views

### What It Does NOT Own

- Backend API endpoints (uses Convex for backend logic)
- Body storage or retrieval (uses API worker)
- Authentication state (uses Auth0)
- Agent fact ingestion

### Communication

- **Inbound**: Browser requests
- **Outbound**:
  - Convex for user data, API keys, collector credentials, alerts, and Tinybird JWTs
  - Tinybird for trace and agent queries
  - API worker for body retrieval

### Deployment Architecture

The web worker uses `@opennextjs/cloudflare` to compile Next.js for the Cloudflare Workers runtime:

- Next.js App Router with SSR runs natively on Workers
- Static assets served via the Worker assets binding
- Same `--env development` / `--env production` deployment pattern as other workers

## Cross-Worker Communication

### Queue Messages (Proxy to Proxy Consumer)

The proxy enqueues structured messages containing all captured data:

```typescript
interface QueueMessage {
  requestId: string;
  apiKey: string;
  targetUrl: string;
  timing: {
    requestStart: number;
    requestSent: number;
    firstTokenReceived?: number;
    responseComplete: number;
  };
  tokens?: { promptTokens?: number; completionTokens?: number };
  sseStreamData?: SSEStreamData;
}
```

The proxy consumer transforms this into OpenTelemetry traces, adding computed fields like cost.

### Agent Queue Messages (Agent Ingest to Agent Consumer)

The agent ingest worker accepts `AgentIngestEnvelope` uploads from collectors and enqueues `AgentIngestQueueMessage` chunks:

```typescript
interface AgentIngestQueueMessage {
  type: 'agent';
  source: 'claude' | 'codex' | 'cursor';
  parser_version: string;
  desktop_version: string;
  collector_batch_id: string;
  tenancy: {
    org_id: string;
    user_id: string;
    collector_id: string;
    collector_credential_id: string;
  };
  facts: AgentIngestQueueFacts;
  enqueued_at: number;
}
```

The ingest worker stamps tenancy and final row identities. The collector never sends trusted org/user IDs, cost, or final Tinybird primary keys.

### R2 Keys (Proxy to API)

Bodies are stored with predictable keys:

- Combined payload: `bodies/{requestId}`

The API worker reconstructs this key from the `requestId` parameter.

### Shared Types

The `@trace-flow/types` package defines interfaces used across worker boundaries, ensuring type safety across queue boundaries:

- `QueueMessage`: Raw capture data from proxy
- `TinybirdTrace`: OpenTelemetry-format trace for storage
- `SSEStreamData`: Parsed SSE events and timing
- `AgentIngestEnvelope`: Collector upload contract
- `AgentIngestQueueMessage`: Agent ingest to agent consumer contract

## Failure Handling

### Proxy Failures

- Observability failures are caught and logged; they never affect the client response
- R2 storage failures result in queue messages without body keys
- Queue send failures are logged; traces are lost (acceptable tradeoff for latency)

### Proxy Consumer Failures

- Message processing failures trigger retry via `message.retry()`
- After `max_retries` (5), messages go to dead-letter queue
- Tinybird insertion failures trigger retry with exponential backoff
- Durable Object persists unflushed traces in SQLite across restarts

### Agent Ingest Failures

- Invalid Collector Credentials return 401
- Invalid envelopes return 400
- Oversized bodies return 413
- Unsupported desktop/parser versions return 426
- Missing compatibility policy returns retryable 503
- Session claim outages return retryable 503
- Rate-limit violations return 429
- Queue enqueue failures return retryable 503

### Agent Consumer Failures

- Malformed queue messages retry and then dead-letter
- Pricing misses produce null `cost_usd` when usage or pricing coverage is insufficient
- Fact ledger failures retry all contributing queue messages
- Tinybird insert failures keep rows pending in `AGENT_FACT_BATCHER` SQLite and retry on the next flush

### API Failures

- R2 retrieval failures return 404
- Auth failures return 401

## Environment Isolation

Each worker connects to environment-specific resources via its Wrangler config:

| Worker         | Dev Queue               | Dev R2 Bucket          | Dev KV                  |
| -------------- | ----------------------- | ---------------------- | ----------------------- |
| Proxy          | trace-flow-requests-dev | trace-flow-storage-dev | trace-flow-api-keys-dev |
| Proxy Consumer | trace-flow-requests-dev | -                      | model pricing           |
| Agent Ingest   | agent-ingest-dev        | -                      | collector credentials   |
| Agent Consumer | agent-ingest-dev        | -                      | model pricing           |
| API            | -                       | trace-flow-storage-dev | user/org access cache   |
| Web            | -                       | -                      | -                       |

Production uses production resource names. Preview support is worker-specific and follows each `wrangler` config and GitHub Actions workflow.
