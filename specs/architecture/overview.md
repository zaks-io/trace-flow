# System Architecture Overview

Trace Flow is an LLM observability platform that captures, processes, and visualizes two kinds of data:

- proxied LLM request/response traces
- local AI-agent conversation facts from the Trace Flow collector

The LLM proxy path is designed around a single guiding principle: **never add latency to the user's LLM requests**. The agent conversation path uses the same edge, queue, and Tinybird posture, but it is a separate Collector Credential-authenticated ingest path with its own workers and `agent_*` tables.

Agent Conversation Analytics is not production-ready until the gates in `docs/guides/agent-conversation-analytics/ROADMAP.md` are complete.

## System Diagram

LLM request path:

```text
Client/SDK -> Proxy Worker -> LLM Provider
                 |
                 | waitUntil()
                 v
          R2 Body Objects + trace-flow-requests Queue
                                  |
                                  v
                         Proxy Consumer Worker
                                  |
                                  v
                         TraceBatcher Durable Object
                                  |
                                  v
                         Tinybird otel_* tables
```

Agent conversation path:

```text
Trace Flow CLI/Desktop -> Agent Ingest Worker -> agent-ingest Queue
          |                       |                    |
          |                       |                    v
          |                       |           Agent Consumer Worker
          |                       |                    |
          |                       |                    v
          |                       |          AgentFactBatcher Durable Object
          |                       |                    |
          |                       |                    v
          |                       |          Tinybird agent_* tables
          |                       |
          |                       +-> Convex compatibility policy
          |                       +-> Convex session ownership claims
          +-> Collector Credential in COLLECTOR_CREDS KV
```

Read path:

```text
Web Dashboard -> Convex -> Tinybird JWTs -> Tinybird Pipes
Web Dashboard -> API Worker -> R2 Body Objects
Web Dashboard -> /app/agents -> Tinybird agent_* Pipes
```

## Core Design Principles

### Zero-Latency LLM Capture

The proxy worker streams responses to clients immediately while capturing data asynchronously. This is achieved through:

- **Stream duplication**: Using `ReadableStream.tee()` to duplicate the request body
- **Transform streams**: Capturing response chunks without blocking the stream
- **Deferred processing**: All storage and queue operations happen in `c.executionCtx.waitUntil()`, which runs after the response completes

### Queue-Based Decoupling

The proxy and agent ingest paths are decoupled from their consumers via Cloudflare Queues. This separation provides:

- **Failure isolation**: Consumer failures do not affect proxy latency or collector upload acceptance after enqueue
- **Batching efficiency**: Consumers process up to 100 messages at a time
- **Retry semantics**: Automatic retries with dead-letter queues for failed messages
- **Independent scaling**: Proxy and ingest workers scale for request volume; consumers scale for processing load

### Append-Clean Analytics

Analytics data flows in one direction: ingest worker to queue to Tinybird. There are no distributed transactions in the hot path.

- The LLM path writes OTel-shaped spans into `otel_*` datasources.
- The agent path writes typed facts plus derived rollups into `agent_*` datasources.
- The agent consumer dedupes exact duplicate fact deliveries through `AGENT_FACT_BATCHER` before Tinybird insert.
- Changed same-key agent facts become repair signals instead of silent overwrites.

## Data Flow

### 1. Request Capture (Proxy Worker)

When a client sends an LLM request through the proxy:

1. **Authentication**: Validate API key against KV namespace
2. **Route resolution**: Map path prefix, such as `/openai/`, to provider base URL
3. **Stream duplication**: Split request body into proxy stream and capture stream
4. **Forward request**: Send to LLM provider, stream response back immediately
5. **Async capture**: In `waitUntil()`, store bodies to R2 and enqueue metadata

The proxy handles both streaming (SSE) and non-streaming responses, extracting timing metrics like time-to-first-token from SSE events.

### 2. Queue Processing (Proxy Consumer Worker)

The proxy consumer receives batches of queue messages and:

1. **Route messages**: Shard by API key hash for Durable Object affinity
2. **Build traces**: Transform queue messages into OpenTelemetry-format traces
3. **Calculate costs**: Look up model pricing from KV and compute costs
4. **Batch to Durable Object**: Send traces to a `TraceBatcher` Durable Object

### 3. Trace Batching (Durable Object)

Each `TraceBatcher` instance:

1. **Buffers traces**: Store in SQLite until batch is full or timeout triggers
2. **Flush to Tinybird**: Send batches of up to 10,000 traces via Events API
3. **Handle failures**: Retry with exponential backoff, preserve traces in SQLite on failure

### 4. Agent Collector Ingest

The local collector in the CLI or desktop app parses supported local transcript stores into typed facts and posts them to Agent Ingest:

1. **Collector Credential authentication**: Validate `X-Trace-Flow-Collector-Secret` against the Convex-synced `COLLECTOR_CREDS` KV namespace
2. **Compatibility policy**: Fetch the Convex-owned desktop/parser version policy and fail closed when no recent policy is available
3. **Rate limiting**: Apply the per-org `AGENT_INGEST_LIMITER`
4. **Validation and redaction**: Validate the envelope, inflate gzip bodies, and re-redact free-text excerpts as a server-side backstop
5. **Session ownership**: Claim `OrgId + session_pk` in Convex so duplicate uploads from another user do not overwrite ownership
6. **Queue chunking**: Assemble stable `*_pk` row identities and enqueue sub-128 KiB messages to the agent queue

### 5. Agent Fact Processing

The agent consumer receives queue batches and:

1. **Validate queue contract**: Malformed messages retry and eventually dead-letter
2. **Price messages**: Read `MODEL_PRICING` KV and compute `cost_usd` only where usage and pricing coverage are sufficient
3. **Map rows**: Convert typed facts into Tinybird row shapes for messages, tool events, file events, capability snapshots, and pull request links
4. **Dedupe and batch**: Route rows by org to `AGENT_FACT_BATCHER`, which stores a fact ledger in Durable Object SQLite
5. **Insert facts**: Flush clean rows to the `agent_*` Tinybird datasources

### 6. Visualization (Web Dashboard)

The web dashboard queries trace and agent data:

1. **JWT generation**: Convex generates short-lived Tinybird JWTs with row-level security
2. **Direct queries**: Frontend queries Tinybird directly
3. **Body retrieval**: When viewing trace details, fetch bodies from API worker
4. **Agent analytics**: `/app/agents` reads `agent_*` pipes using org-scoped Tinybird JWTs

## Key Architectural Patterns

### Streaming With Capture

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

### Sharded Trace Batching

Queue messages are sharded across multiple `TraceBatcher` instances to prevent hot spots:

```typescript
const shardId = calculateShardId(apiKey, NUM_SHARDS);
const batcherId = env.TRACE_BATCHER.idFromName(`batcher-${shardId}`);
const batcher = env.TRACE_BATCHER.get(batcherId);
await batcher.addTraces(traces);
```

### Agent Fact Ledger

Agent facts are already batched by the collector, so the Durable Object boundary serves a different purpose from `TraceBatcher`: it is a ledger for stable fact identity.

```typescript
const batcher = env.AGENT_FACT_BATCHER.getByName(`org:${orgId}`);
await batcher.addFacts({ rows });
```

Exact duplicate rows are skipped before Tinybird. Same fact identity with changed content is recorded as a repair signal, which keeps query-time `FINAL` out of the product path.

### Row-Level Security

Tinybird JWT tokens include `fixed_params` that restrict query results. LLM trace scopes use API keys. Agent scopes use org identity.

```typescript
const scopesWithApiKeys = args.scopes.map((scope) => ({
  ...scope,
  fixed_params: {
    api_keys: userApiKeys.join(','),
  },
}));
```

Collector Credentials are not API keys. They do not appear in API-key filters and cannot call the Proxy. They authenticate only the Agent Ingest Worker.

## Infrastructure

### Cloudflare Resources

| Resource          | Purpose                                                       | Environment Separation               |
| ----------------- | ------------------------------------------------------------- | ------------------------------------ |
| Workers           | Proxy, Proxy Consumer, Agent Ingest, Agent Consumer, API, Web | Env-specific names and bindings      |
| Queue             | LLM trace message passing                                     | `trace-flow-requests-{env}`          |
| Queue             | Agent fact message passing                                    | `agent-ingest-{env}`                 |
| Dead Letter Queue | Failed LLM trace messages                                     | `trace-flow-requests-dlq-{env}`      |
| Dead Letter Queue | Failed agent fact messages                                    | `agent-ingest-dlq-{env}`             |
| R2 Bucket         | Request/response body storage                                 | `trace-flow-storage-{env}`           |
| KV Namespace      | API key validation                                            | `trace-flow-api-keys-{env}`          |
| KV Namespace      | Model pricing cache                                           | Separate namespace                   |
| KV Namespace      | Collector Credential lookup                                   | Separate `COLLECTOR_CREDS` namespace |
| Durable Objects   | Trace batching, agent fact ledger                             | Per-worker instances                 |
| Rate Limit        | Agent ingest org burst guard                                  | `AGENT_INGEST_LIMITER`               |

### External Services

| Service  | Purpose                                                                                   |
| -------- | ----------------------------------------------------------------------------------------- |
| Tinybird | Managed ClickHouse for trace spans, agent facts, rollups, and analytics                   |
| Convex   | Backend for users, API keys, collector credentials, session ownership, alerts, MCP server |
| Auth0    | Authentication for web dashboard and API                                                  |
| Sentry   | Error monitoring across all workers                                                       |

## Deployment Architecture

The system uses environment separation at the Cloudflare resource level:

- **Development**: Uses `-dev` suffixed resources, deployed via `bun run deploy:dev`
- **Preview**: Uses preview resources where configured, auto-deployed on PRs
- **Production**: Uses production resources, auto-deployed on merge to main

Workers share the same codebase but connect to different queues, buckets, and KV namespaces based on the deployment environment. The agent analytics production path is tracked separately in `docs/guides/agent-conversation-analytics/ROADMAP.md`; production bindings exist, but the feature remains blocked until the user-facing collector, production smoke, observability, CI, and dashboard truth gates are complete.
