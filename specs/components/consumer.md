# Proxy Consumer Worker

The Proxy Consumer Worker processes queue messages from the proxy, transforms them into OpenTelemetry traces, and sends them to Tinybird for storage. It uses Durable Objects to batch writes, reducing the number of API calls to Tinybird.

## What It Does

The proxy consumer receives delivery references, loads their R2 envelopes, copies encrypted bodies to
canonical Body Object keys, builds spans, and stages them in TraceBatcher Durable Objects. Legacy
inline queue messages remain readable during cutover.

## Queue Processing

Cloudflare Queues deliver messages in batches of up to 100 messages. The consumer processes each message:

1. Resolves a delivery reference or legacy inline message
2. Copies an envelope's encrypted body to `bodies/{requestId}` when present
3. Looks up pricing data and builds OpenTelemetry spans
4. Routes spans to the appropriate Durable Object shard
5. Removes the delivery envelope and acknowledges only after durable shard handoff

## Message Types

The consumer handles two message types:

**Delivery Reference Messages**: Current Proxy output. They point to R2 envelopes containing LLM or
OTLP capture data and an optional encrypted Body Object.

**Legacy Inline Messages**: Pre-cutover LLM and OTLP messages. They remain supported until old queue
retries and backlogs are drained.

## Trace Building

For LLM requests, the consumer builds a hierarchical trace structure following OpenTelemetry GenAI semantic conventions:

**Root Span**: Represents the overall LLM request with attributes:

- `gen_ai.system`: Provider name (openai, anthropic, etc.)
- `gen_ai.request.model`: Model identifier
- `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`: Token counts
- `gen_ai.cost.total`: Calculated cost in dollars
- `gen_ai.server.time_to_first_token`: TTFT for streaming responses

**Content Block Spans** (streaming only): Child spans for each content block:

- `gen_ai.response.thinking`: Extended thinking blocks
- `gen_ai.response.text`: Text content blocks
- `gen_ai.response.tool_use`: Tool call blocks

**Response Span** (non-streaming): Single child span for the complete response.

## Sharding Strategy

Traces are sharded by API key to ensure ordering guarantees within a single customer's data while allowing parallel processing across customers.

The sharding uses consistent hashing: `hash(apiKey) % NUM_SHARDS`. This ensures the same API key always routes to the same Durable Object, maintaining ordering. The default configuration uses 10 shards.

Why shard by API key:

- Guarantees per-customer ordering without global serialization
- Distributes load across multiple Durable Objects
- Allows independent scaling per shard
- Simplifies retry logic since failures are isolated to a shard

## TraceBatcher Durable Object

The TraceBatcher accumulates traces in SQLite storage and flushes them to Tinybird in batches. This reduces API calls from potentially thousands per minute to a handful of batch writes.

**Batching Thresholds**:

- Size-based: Flushes at 10,000 traces
- Time-based: Flushes every 5 seconds (with random jitter to prevent thundering herd)

**SQLite Storage**: Uses the Durable Object's built-in SQLite to persist traces between flushes. This ensures traces survive worker restarts or Tinybird temporary failures.

**Alarm-Based Flushing**: Uses Cloudflare alarms to schedule time-based flushes. Jitter (0-1000ms) prevents all shards from flushing simultaneously.

## Pricing Calculation

The consumer calculates costs for each request using pricing data from KV:

1. Looks up pricing by `pricing:{provider}:{model}` key
2. Falls back to model prefix match (strips date suffix like `-20250929`)
3. For OpenRouter, auto-fetches pricing from their API if not in KV
4. Calculates cost breakdown (input, output, cache, reasoning)

Costs are stored in microdollars (1/1,000,000 of a dollar) for precision, then converted to dollar strings in span attributes.

## OpenRouter Pricing Fallback

When processing OpenRouter requests with unknown models, the consumer fetches pricing directly from the OpenRouter API:

1. Calls `https://openrouter.ai/api/v1/models`
2. Caches result in memory for 5 minutes
3. Stores fetched pricing in KV with 1-year TTL
4. Returns null if model not found (request proceeds without cost data)

This auto-discovery means new models work without manual pricing updates.

## Tinybird Integration

Traces are sent to Tinybird using their Events API:

- Endpoint: `{host}/v0/events?name={datasource}`
- Format: NDJSON (newline-delimited JSON)
- Timeout: 60 seconds

Writes use `wait=true` and require an HTTP 200 receipt confirming every row and zero quarantine rows.
The batcher persists an in-flight record before sending. Only outcomes documented as definitely not
written are retried automatically; timeouts, partial receipts, and other ambiguous results remain in
recovery storage for explicit reconciliation.

## Dead Letter Queue

Messages that exhaust the main queue are preserved through the DLQ consumer. A failed preservation
attempt retries the DLQ message and emits a fatal signal rather than acknowledging it.

Common failure scenarios:

- Malformed message data
- Persistent Tinybird failures
- Pricing lookup errors for non-OpenRouter providers

## Bindings

| Binding               | Type           | Purpose                                                              |
| --------------------- | -------------- | -------------------------------------------------------------------- |
| `STORAGE`             | R2 Bucket      | Loads/completes delivery envelopes and copies encrypted Body Objects |
| `TRACE_BATCHER`       | Durable Object | Batches traces before Tinybird writes                                |
| `MODEL_PRICING`       | KV Namespace   | Stores model pricing data                                            |
| `TINYBIRD_TOKEN`      | Secret         | Auth token for Tinybird API                                          |
| `TINYBIRD_HOST`       | Variable       | Tinybird API endpoint                                                |
| `TINYBIRD_DATASOURCE` | Variable       | Target datasource name                                               |

## Key Files

- `apps/proxy-consumer/src/index.ts` - Queue handler and message routing
- `apps/proxy-consumer/src/batcher.ts` - TraceBatcher Durable Object
- `apps/proxy-consumer/src/traces.ts` - OpenTelemetry trace construction
- `apps/proxy-consumer/src/sharding.ts` - Consistent hashing for shards
- `apps/proxy-consumer/src/pricing.ts` - Cost calculation logic
- `apps/proxy-consumer/src/openrouter-pricing.ts` - OpenRouter API fallback
- `apps/proxy-consumer/src/tinybird.ts` - Tinybird API client with retry
