# Worker Architecture

The core model and agent data planes are split into six Cloudflare Workers: Proxy, Proxy Consumer,
Agent Ingest, Agent Consumer, Pipes API, and Raw API. Production also deploys Web, MCP, and Analyst
Sandbox Workers. This document explains why these responsibilities are separated and how the core
Workers communicate.

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
- Durable R2 delivery-envelope storage, including the encrypted Body Object when enabled
- Queue delivery-reference creation, publication, and scheduled republishing

### What It Does NOT Own

- Trace transformation (queue messages are raw capture data)
- Cost calculation or pricing lookups
- User management or authorization
- Any synchronous external calls that could add latency

### Communication

- **Inbound**: HTTP requests from clients (SDKs, agents)
- **Outbound**:
  - HTTP to LLM providers (OpenAI, Anthropic, etc.)
  - R2 for durable delivery envelopes
  - Cloudflare Queue for async processing
  - KV for API key validation

### Scaling Characteristics

The proxy is stateless and scales horizontally. Each request is independent. The main constraint is the 30-second execution limit for Workers, but LLM streaming responses rarely exceed this.

**Performance-critical path**: Everything from request receipt through response streaming. The stream
starts without waiting for analytics, but its terminal EOF waits for durable R2 intake. Queue
publication and recovery continue through `waitUntil()`.

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
- Delivery-envelope retrieval, canonical encrypted Body Object copy, and envelope completion
- Cost calculation using model pricing from KV
- OpenRouter pricing auto-fetch for unknown models
- Durable Object coordination for batch accumulation
- Tinybird insertion with retry logic

### What It Does NOT Own

- Body decryption or user-facing body reads (handled by Raw API)
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

**Responsibility**: Accept collector uploads, authenticate Collector Credentials, validate and normalize agent fact envelopes, claim session ownership, stage encrypted R2 deliveries, and enqueue tenant-bound references for the agent consumer.

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
- Bounded encrypted R2 delivery staging and stable retry identities
- Delivery admission checks and registration through `AGENT_CONSUMER`
- Reference publication through `AGENT_QUEUE.sendBatch`

### What It Does NOT Own

- Model pricing or cost calculation
- Tinybird writes
- User-facing API key auth
- LLM proxying

### Communication

- **Inbound**: `POST /v1/ingest` from Trace Flow CLI/Desktop collectors
- **Outbound**:
  - KV for Collector Credential lookup
  - Convex HTTP routes for compatibility policy and session ownership claims
  - Cloudflare Rate Limiting for per-org burst control
  - R2 for encrypted fact deliveries
  - Agent Consumer service for admission, receipt reuse, and registration
  - Cloudflare Queue for agent delivery references

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

## Agent Consumer Worker

**Location**: `apps/agent-consumer/`

**Responsibility**: Resolve encrypted agent deliveries, price Agent Message facts once, write versioned canonical facts, and publish bounded snapshots.

### What It Owns

- Queue consumption and message acknowledgment/retry
- Delivery reference validation and off-contract message rejection
- Agent Message pricing through the shared `MODEL_PRICING` KV catalog
- Row mapping for messages, tool events, file events, capability snapshots, pull request links, and review-unit attributions
- Bounded delivery receipts and organization write coordination
- Tinybird Events API insertion for versioned canonical facts
- Cross-date correction tombstones and uncertain-write receipt reconciliation
- Dirty-date tracking, bounded snapshot Copies, and atomic manifest publication
- Shared DLQ preservation and retained recovery records in `AGENT_FACT_BATCHER`

### What It Does NOT Own

- Collector Credential authentication
- Session ownership claims
- Raw transcript parsing
- LLM request trace spans
- Dashboard read APIs

### Communication

- **Inbound**: Delivery references from Agent Ingest and separate snapshot queue messages
- **Outbound**:
  - KV for model pricing lookup
  - R2 for encrypted delivery bodies and immutable priced row plans
  - Durable Objects for delivery receipts, organization revisions, and snapshot capacity
  - Tinybird Events API for canonical fact versions and manifests
  - Tinybird Copy and Jobs APIs for snapshot generation

### Scaling Characteristics

The consumer scales with `agent-ingest-{env}` queue depth and dispatches up to six deliveries at a
time. The organization coordinator serializes canonical writes and bounds active delivery references.
Delivery receipt state makes repeated references safe. Snapshot work uses a separate queue and admits
at most two generations globally. Off-contract ingest messages log an error and retry until they
dead-letter; DLQ acknowledgement waits for durable preservation.

### Configuration

Defined in `apps/agent-consumer/wrangler.jsonc`:

```jsonc
"queues": {
  "consumers": [{
    "queue": "agent-ingest-dev",
    "max_batch_size": 100,
    "max_batch_timeout": 5,
    "max_concurrency": 6,
    "max_retries": 5,
    "dead_letter_queue": "agent-ingest-dlq-dev"
  }]
},
"kv_namespaces": [{ "binding": "MODEL_PRICING", "id": "..." }],
"durable_objects": {
  "bindings": [
    { "name": "AGENT_DELIVERY", "class_name": "AgentDelivery" },
    { "name": "AGENT_DELIVERY_COORDINATOR", "class_name": "AgentDeliveryCoordinator" },
    { "name": "AGENT_SNAPSHOT_CAPACITY", "class_name": "SnapshotCapacity" },
    { "name": "AGENT_FACT_BATCHER", "class_name": "AgentFactBatcher" }
  ]
}
```

Production uses `trace-flow-agent-consumer`, `agent-ingest-prod`, `agent-ingest-dlq-prod`, and the production model-pricing namespace.

## Raw API Worker

**Location**: `apps/api/`

**Responsibility**: Serve request/response bodies from R2 to the web dashboard.

### What It Owns

- R2 body retrieval
- Request-scoped Body Access Token validation
- CORS handling for browser requests

### What It Does NOT Own

- Delivery-envelope creation (handled by Proxy) and canonical Body Object handoff (handled by Proxy
  Consumer)
- Trace queries (handled by Pipes API)
- User management
- Agent analytics ingest

### Communication

- **Inbound**: HTTP requests from web dashboard
- **Outbound**: R2 for body retrieval

### Why a Separate Worker?

The Raw API worker exists because:

1. **Secret separation**: Holds R2 body credentials but no Tinybird Pipe credentials
2. **Scoped authorization**: Accepts short-lived Body Access Tokens minted for one request and organization
3. **CORS requirements**: Browser requests need proper CORS headers
4. **Access pattern**: Bodies are fetched on-demand when viewing trace details, not during ingestion

### Configuration

Defined in `apps/api/wrangler.toml`:

```toml
[[r2_buckets]]
binding = "STORAGE"
bucket_name = "trace-flow-storage-dev"

[vars]
SENTRY_ENVIRONMENT = "development"
BODY_ENCRYPTION_KEY_ID = "v1"
```

## Web Worker (OpenNext)

**Location**: `apps/web/`

**Responsibility**: Serve the dashboard and provide the user interface.

### What It Owns

- Next.js SSR and static assets via OpenNext on Cloudflare Workers
- React-based dashboard UI
- LLM trace and agent analytics views

### What It Does NOT Own

- Backend API endpoints (uses Convex for backend logic)
- Body storage or retrieval (uses Raw API)
- Authentication state (uses Auth0)
- Agent fact ingestion

### Communication

- **Inbound**: Browser requests
- **Outbound**:
  - Convex for user data, API keys, collector credentials, alerts, Pipe Tokens, and Body Access Tokens
  - Pipes API for trace and agent queries
  - Raw API for body retrieval

### Deployment Architecture

The web worker uses `@opennextjs/cloudflare` to compile Next.js for the Cloudflare Workers runtime:

- Next.js App Router with SSR runs natively on Workers
- Static assets served via the Worker assets binding
- Same `--env development` / `--env production` deployment pattern as other workers

## Cross-Worker Communication

### Queue Messages (Proxy to Proxy Consumer)

The proxy stores the captured data in R2 and enqueues a small reference:

```typescript
interface TraceDeliveryMessage {
  type: 'delivery';
  key: `trace-deliveries/${string}`;
  sentry_trace_context?: SentryTraceContext;
}
```

The referenced `TraceDeliveryEnvelope` contains the transaction metadata and optional encrypted Body
Object. Proxy Consumer resolves it before building OpenTelemetry spans. Legacy inline LLM and OTLP
messages remain readable during the delivery-reference cutover.

### Agent Queue Messages (Agent Ingest to Agent Consumer)

The agent ingest worker accepts `AgentIngestEnvelope` uploads from collectors, stamps tenancy and
stable fact identities, and stores bounded encrypted deliveries in R2. The queue carries only a
registered reference:

```typescript
interface AgentDeliveryReference {
  type: 'agent-delivery';
  version: 1;
  key: string;
  org_id: string;
  sha256: string;
  created_at: number;
  expires_at: number;
  delivery_revision: number;
}
```

`AgentIngestQueueMessage` remains the validated decrypted fact payload inside the delivery. It is not
accepted as an inline queue message. The collector never sends trusted org/user IDs, cost, or final
Tinybird primary keys.

### R2 Keys (Proxy to API)

Pending and completed objects have separate keys:

- Pending envelope: `trace-deliveries/{environment-namespace}-{uuid}`
- Completed combined Body Object: `bodies/{requestId}`

Proxy creates the pending envelope. Proxy Consumer copies the already encrypted body to its completed
key before removing the envelope. Raw API reconstructs only the completed key from `requestId`.

### Shared Types

The `@trace-flow/types` package defines interfaces used across worker boundaries, ensuring type safety across queue boundaries:

- `TraceDeliveryEnvelope` / `TraceDeliveryMessage`: durable Proxy-to-Consumer handoff
- `QueueMessageUnion`: delivery references plus legacy inline message variants
- `TinybirdTrace`: OpenTelemetry-format trace for storage
- `SSEStreamData`: Parsed SSE events and timing
- `AgentIngestEnvelope`: Collector upload contract
- `AgentDeliveryReference`: Agent Ingest to Agent Consumer queue contract
- `AgentIngestQueueMessage`: Validated fact payload inside an encrypted agent delivery

## Failure Handling

### Proxy Failures

- A durable R2 intake failure returns a retryable error or fails the captured response before terminal
  EOF instead of claiming success
- Queue publication failures leave the delivery envelope in R2; the scheduled sweep republishes it
- Client disconnects, termination before durable intake, and capture-size limits remain explicit
  boundaries rather than unconditional delivery guarantees

### Proxy Consumer Failures

- Message processing failures trigger retry via `message.retry()`
- After `max_retries` (5), messages go to dead-letter queue
- Durable Object persists pending, rejected, and uncertain Tinybird writes in SQLite
- Only responses documented as definitely not written are automatically retried; ambiguous outcomes
  require reconciliation so a non-idempotent append is not duplicated

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

- Off-contract queue messages report an error, retry, and then dead-letter
- Invalid references and delivery dispatch failures retry
- Pricing misses produce null `cost_usd` when usage or pricing coverage is insufficient
- Uncertain Tinybird inserts wait for receipt reconciliation rather than blind retries
- Snapshot failures prevent publication of incomplete captured dates
- DLQ preservation failures retry; agent dead letters support explicit retirement without replay

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
