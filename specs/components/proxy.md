# Proxy Worker

The Proxy Worker is the entry point for all LLM requests flowing through Trace Flow. It operates as a transparent streaming proxy that captures request/response data for observability without adding latency to the client experience.

## What It Does

The proxy receives HTTP requests destined for LLM providers, forwards them immediately, and streams responses back to clients in real-time. Simultaneously, it captures request and response bodies for storage and analysis. The critical design principle is that observability operations never block the client response.

## Request Flow

1. Client sends request to `/{provider}/...` (e.g., `/openai/v1/chat/completions`)
2. Proxy validates the API key against KV namespace
3. Request is forwarded to the target provider
4. Response streams back to client immediately
5. Request/response bodies are stored in R2 asynchronously
6. Metadata is enqueued for processing by the Proxy Consumer

## Provider Routing

The proxy uses path-based routing to determine the target provider. The first path segment identifies the provider, and the remaining path is appended to the provider's base URL.

| Path Prefix     | Target Base URL                             |
| --------------- | ------------------------------------------- |
| `/openai/*`     | `https://api.openai.com`                    |
| `/anthropic/*`  | `https://api.anthropic.com`                 |
| `/openrouter/*` | `https://openrouter.ai/api`                 |
| `/groq/*`       | `https://api.groq.com/openai`               |
| `/google/*`     | `https://generativelanguage.googleapis.com` |

Example: A request to `/openai/v1/chat/completions` forwards to `https://api.openai.com/v1/chat/completions`.

## Stream Duplication with tee()

The proxy needs to both forward the request body to the provider and capture it for storage. Since Cloudflare Workers streams can only be read once, the proxy uses `ReadableStream.tee()` to create two independent readers from the request body.

One stream goes to the upstream provider for proxying, the other gets captured for storage. This approach avoids buffering the entire body in memory, which is critical for large requests.

## Response Capture with TransformStream

For response streaming, the proxy creates a TransformStream that passes chunks through to the client while simultaneously capturing them for storage. This transform captures:

- Each chunk as it flows through
- First token timestamp (TTFT) for streaming latency metrics
- Total response size with truncation at 20MB to prevent OOM

The transform never blocks the client response. All captured data is processed after the response completes.

## The waitUntil Pattern

All storage and queueing operations happen inside `c.executionCtx.waitUntil()`. This Cloudflare Workers API allows the proxy to return the response immediately while continuing to execute async operations. The worker stays alive until all waitUntil promises resolve.

This pattern is essential for low-latency proxying. Even if R2 storage is slow or the queue is backed up, clients experience no additional latency.

## SSE Streaming Support

For Server-Sent Events (SSE) responses (`Content-Type: text/event-stream`), the proxy parses individual events to extract detailed timing and token data. It tracks:

- Message boundaries (message_start, message_stop)
- Content blocks (thinking, text, tool_use)
- Token usage accumulated across events
- Per-block timing for Gantt chart visualization

## R2 Storage

Request and response bodies are stored together in R2 with consistent key naming:

- Combined body payload: `bodies/{requestId}`

Each request gets a unique ID, so bodies are never overwritten even when multiple requests share the same trace ID. Storage failures are handled gracefully; the queue message is still sent without stored body data.

Body objects are encrypted before storage using `BODY_ENCRYPTION_ROOT_KEY`, `BODY_ENCRYPTION_KEY_ID`,
and the owning organization id. The Proxy refuses to store bodies when the encryption context is
missing.

## Queue Message Structure

After capturing data, the proxy enqueues a message containing:

- Request and response metadata (provider, status, timestamps)
- Parsed token usage from response body or SSE events
- Error details if the response was an error
- SSE stream data for streaming responses
- W3C trace context (traceparent, tracestate, baggage)

## W3C Trace Context Support

The proxy supports distributed tracing through W3C Trace Context headers:

- `traceparent`: Extracts trace ID and parent span ID
- `tracestate`: Preserved for vendor-specific context
- `baggage`: Parsed into span attributes

If no traceparent is provided, the proxy generates a new trace ID.

## OTLP Ingestion

In addition to LLM proxying, the worker exposes a `/v1/traces` endpoint for direct OpenTelemetry trace ingestion. This allows external services to send traces that appear alongside LLM requests in the dashboard.

## Bindings

| Binding         | Type         | Purpose                               |
| --------------- | ------------ | ------------------------------------- |
| `REQUEST_QUEUE` | Queue        | Sends captured data to Proxy Consumer |
| `STORAGE`       | R2 Bucket    | Stores request/response bodies        |
| `API_KEYS`      | KV Namespace | Validates API keys                    |

Secrets and variables:

- `BODY_ENCRYPTION_ROOT_KEY` - root key for encrypted body objects
- `BODY_ENCRYPTION_KEY_ID` - write key id recorded in encrypted envelopes

## Caching

API key validation and billing status KV reads use a two-layer cache (module-scope Map + Cache API) to avoid per-request KV billing. See [Proxy KV Caching](../decisions/proxy-kv-caching.md) for the full cost analysis and architecture.

## Key Files

- `apps/proxy/src/index.ts` - Main Hono application and request handler
- `apps/proxy/src/cache.ts` - Two-layer cache (L1 module-scope + L2 Cache API)
- `apps/proxy/src/auth.ts` - API key validation and billing status checks
- `apps/proxy/src/usage.ts` - Durable Object usage quota checks
- `apps/proxy/src/providers.ts` - Provider routing configuration
- `apps/proxy/src/streaming/capture.ts` - Stream duplication and capture logic
- `apps/proxy/src/streaming/sse.ts` - SSE event parsing
- `apps/proxy/src/queue.ts` - Queue message construction
- `apps/proxy/src/storage.ts` - R2 storage operations
