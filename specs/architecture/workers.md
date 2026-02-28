# Worker Architecture

The platform is split into four Cloudflare Workers, each with a focused responsibility. This document explains why we chose this separation and how the workers communicate.

## Why Four Workers?

A single monolithic worker would be simpler to deploy but would create several problems:

1. **Conflicting execution models**: The proxy must respond in milliseconds; the consumer can take seconds to process batches
2. **Resource contention**: Queue processing consumes CPU that could affect proxy latency
3. **Deployment coupling**: A bug in trace processing would require redeploying the proxy
4. **Scaling mismatch**: Proxy scales with request volume; consumer scales with processing load

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

## Consumer Worker

**Location**: `apps/proxy-consumer/`

**Responsibility**: Process queue batches, transform into OpenTelemetry traces, calculate costs, and batch insert to Tinybird.

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

**Responsibility**: Serve the static dashboard and provide the user interface.

### What It Owns

- Next.js SSR and static assets via OpenNext on Cloudflare Workers
- React-based dashboard UI
- Tinybird query generation and execution
- Real-time data visualization

### What It Does NOT Own

- Backend API endpoints (uses Convex for backend logic)
- Body storage or retrieval (uses API worker)
- Authentication state (uses Auth0)

### Communication

- **Inbound**: Browser requests
- **Outbound**:
  - Convex for user data, API keys, alerts
  - Tinybird for trace queries (via JWT from Convex)
  - API worker for body retrieval

### Deployment Architecture

The web worker uses `@opennextjs/cloudflare` to compile Next.js for the Cloudflare Workers runtime:

- Next.js App Router with SSR runs natively on Workers
- Static assets served via the Worker assets binding
- Same `--env development` / `--env production` deployment pattern as other workers

## Cross-Worker Communication

### Queue Messages (Proxy to Consumer)

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
  requestBodyKey?: string;
  responseBodyKey?: string;
}
```

The consumer transforms this into OpenTelemetry traces, adding computed fields like cost.

### R2 Keys (Proxy to API)

Bodies are stored with predictable keys:

- Request: `requests/{requestId}`
- Response: `responses/{requestId}`

The API worker reconstructs these keys from the `requestId` parameter.

### Shared Types

The `@trace-flow/types` package defines interfaces used by both proxy and consumer, ensuring type safety across the queue boundary:

- `QueueMessage`: Raw capture data from proxy
- `TinybirdTrace`: OpenTelemetry-format trace for storage
- `SSEStreamData`: Parsed SSE events and timing

## Failure Handling

### Proxy Failures

- Observability failures are caught and logged; they never affect the client response
- R2 storage failures result in queue messages without body keys
- Queue send failures are logged; traces are lost (acceptable tradeoff for latency)

### Consumer Failures

- Message processing failures trigger retry via `message.retry()`
- After `max_retries` (5), messages go to dead-letter queue
- Tinybird insertion failures trigger retry with exponential backoff
- Durable Object persists unflushed traces in SQLite across restarts

### API Failures

- R2 retrieval failures return 404
- Auth failures return 401

## Environment Isolation

Each worker connects to environment-specific resources via `wrangler.toml`:

| Worker   | Dev Queue               | Dev R2 Bucket          | Dev KV                  |
| -------- | ----------------------- | ---------------------- | ----------------------- |
| Proxy    | trace-flow-requests-dev | trace-flow-storage-dev | trace-flow-api-keys-dev |
| Consumer | trace-flow-requests-dev | trace-flow-storage-dev | (model pricing)         |
| API      | -                       | trace-flow-storage-dev | -                       |

Production uses `-prod` suffixes. Preview uses `-preview` suffixes.
