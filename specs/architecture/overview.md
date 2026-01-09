# System Architecture Overview

Trace Flow is an LLM observability platform that captures, processes, and visualizes AI request/response data. The system is designed around a single guiding principle: **never add latency to the user's LLM requests**.

## System Diagram

```
                                    +------------------+
                                    |   LLM Provider   |
                                    | (OpenAI, etc.)   |
                                    +--------^---------+
                                             |
                                             | 2. Forward request
                                             |
+-------------+     1. Request      +--------+---------+
|   Client    +-------------------->|      Proxy       |
| (SDK/Agent) |<--------------------+     Worker       |
+-------------+     4. Stream       +--------+---------+
                    response                 |
                                             | 3. Async capture
                                             |    (waitUntil)
                              +--------------+--------------+
                              |              |              |
                              v              v              |
                         +----+----+   +-----+-----+        |
                         |   R2   |   | Cloudflare |        |
                         | Bucket |   |   Queue    |        |
                         +---------+   +-----+-----+        |
                                             |              |
                                             | 5. Batch     |
                                             |    consume   |
                                             v              |
                                      +------+------+       |
                                      |  Consumer   |<------+
                                      |   Worker    |
                                      +------+------+
                                             |
                                             | 6. Insert traces
                                             v
                                      +------+------+
                                      |  Tinybird   |
                                      | (ClickHouse)|
                                      +------+------+
                                             |
                                             | 7. Query traces
                                             v
+-------------+      8. Fetch       +--------+---------+
|     Web     |<--------------------|     Convex       |
|  Dashboard  |                     | (JWT generation) |
+------+------+                     +------------------+
       |
       | 9. Fetch bodies
       v
+------+------+
|    API      |
|   Worker    |
+------+------+
       |
       v
+------+------+
|     R2      |
|   Bucket    |
+-------------+
```

## Core Design Principles

### Zero-Latency Capture

The proxy worker streams responses to clients immediately while capturing data asynchronously. This is achieved through:

- **Stream duplication**: Using `ReadableStream.tee()` to duplicate the request body
- **Transform streams**: Capturing response chunks without blocking the stream
- **Deferred processing**: All storage and queue operations happen in `c.executionCtx.waitUntil()`, which runs after the response completes

### Queue-Based Decoupling

The proxy and consumer workers are decoupled via Cloudflare Queues. This separation provides:

- **Failure isolation**: Consumer failures don't affect proxy latency or reliability
- **Batching efficiency**: Consumer processes up to 100 messages at a time
- **Retry semantics**: Automatic retries with dead-letter queue for failed messages
- **Independent scaling**: Proxy scales for request volume; consumer scales for processing

### Append-Only Analytics

Trace data flows in one direction: proxy to queue to Tinybird. There are no updates or deletes in the hot path. This enables:

- **High write throughput**: Tinybird (ClickHouse) is optimized for append-only workloads
- **Simple consistency model**: No need for distributed transactions
- **Efficient queries**: MergeTree engine with time-based partitioning

## Data Flow

### 1. Request Capture (Proxy Worker)

When a client sends an LLM request through the proxy:

1. **Authentication**: Validate API key against KV namespace
2. **Route resolution**: Map path prefix (e.g., `/openai/`) to provider base URL
3. **Stream duplication**: Split request body into proxy stream and capture stream
4. **Forward request**: Send to LLM provider, stream response back immediately
5. **Async capture**: In `waitUntil()`, store bodies to R2 and enqueue metadata

The proxy handles both streaming (SSE) and non-streaming responses, extracting timing metrics like time-to-first-token from SSE events.

### 2. Queue Processing (Consumer Worker)

The consumer receives batches of queue messages and:

1. **Route messages**: Shard by API key hash for Durable Object affinity
2. **Build traces**: Transform queue messages into OpenTelemetry-format traces
3. **Calculate costs**: Look up model pricing from KV and compute costs
4. **Batch to Durable Object**: Send traces to a `TraceBatcher` Durable Object

### 3. Trace Batching (Durable Object)

Each `TraceBatcher` instance:

1. **Buffers traces**: Store in SQLite until batch is full or timeout triggers
2. **Flush to Tinybird**: Send batches of up to 10,000 traces via Events API
3. **Handle failures**: Retry with exponential backoff, preserve traces in SQLite on failure

### 4. Visualization (Web Dashboard)

The web dashboard queries trace data:

1. **JWT generation**: Convex generates short-lived Tinybird JWTs with row-level security
2. **Direct queries**: Frontend queries Tinybird directly (no backend proxy)
3. **Body retrieval**: When viewing trace details, fetch bodies from API worker

## Key Architectural Patterns

### Streaming with Capture

```typescript
// Duplicate request body for proxy and capture
const [streamToProxy, streamToCapture] = request.body?.tee() ?? [null, null];

// Forward to provider immediately
const response = await fetch(targetUrl, { body: streamToProxy });

// Capture response while streaming to client
const { readable, writable } = new TransformStream({
  transform(chunk, controller) {
    capturedChunks.push(chunk);
    controller.enqueue(chunk);
  },
});
response.body.pipeTo(writable);

// Defer storage and queue operations
c.executionCtx.waitUntil(storeAndEnqueue());

return new Response(readable, { headers: response.headers });
```

### Sharded Durable Objects

Queue messages are sharded across multiple `TraceBatcher` instances to prevent hot spots:

```typescript
const shardId = calculateShardId(apiKey, NUM_SHARDS);
const batcherId = env.TRACE_BATCHER.idFromName(`batcher-${shardId}`);
const batcher = env.TRACE_BATCHER.get(batcherId);
await batcher.addTraces(traces);
```

### Row-Level Security

Tinybird JWT tokens include `fixed_params` that restrict query results to the user's API keys:

```typescript
const scopesWithApiKeys = args.scopes.map((scope) => ({
  ...scope,
  fixed_params: {
    api_keys: userApiKeys.join(','),
  },
}));
```

## Infrastructure

### Cloudflare Resources

| Resource          | Purpose                       | Environment Separation            |
| ----------------- | ----------------------------- | --------------------------------- |
| Workers           | Proxy, Consumer, API          | Same name, different environments |
| Queue             | Async message passing         | `trace-flow-requests-{env}`       |
| Dead Letter Queue | Failed message retention      | `trace-flow-requests-dlq-{env}`   |
| R2 Bucket         | Request/response body storage | `trace-flow-storage-{env}`        |
| KV Namespace      | API key validation            | `trace-flow-api-keys-{env}`       |
| KV Namespace      | Model pricing cache           | (separate namespace)              |
| Durable Objects   | Trace batching                | Per-worker instances              |

### External Services

| Service  | Purpose                                            |
| -------- | -------------------------------------------------- |
| Tinybird | Managed ClickHouse for trace storage and analytics |
| Convex   | Backend for users, API keys, alerts, MCP server    |
| Auth0    | Authentication for web dashboard and API           |
| Sentry   | Error monitoring across all workers                |

## Deployment Architecture

The system uses environment separation at the Cloudflare resource level:

- **Development**: Uses `-dev` suffixed resources, deployed via `bun run deploy:dev`
- **Preview**: Uses `-preview` suffixed resources, auto-deployed on PRs
- **Production**: Uses `-prod` suffixed resources, auto-deployed on merge to main

All workers share the same codebase but connect to different queues, buckets, and KV namespaces based on the deployment environment.
