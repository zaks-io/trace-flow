# Proxy Worker

The Proxy Worker is the entry point for model requests and direct OTLP exports. It streams provider
responses while capturing observability data, then makes accepted captures durable before reporting
terminal success.

## What It Does

The proxy forwards provider requests immediately and streams response chunks as they arrive. It also
captures transaction metadata and optional bodies. The stream can start before persistence, but its
terminal byte and EOF wait until the R2 delivery envelope exists.

## Request Flow

1. Client sends request to `/{provider}/...` (e.g., `/openai/v1/chat/completions`)
2. Proxy validates the API key against KV namespace
3. Request is forwarded to the target provider
4. Response streams back to client immediately
5. A versioned delivery envelope containing metadata and the optional encrypted Body Object is stored
   under `trace-deliveries/`
6. The response reaches terminal EOF after durable intake
7. A small envelope reference is enqueued for Proxy Consumer; a scheduled sweep republishes stale
   references

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

The transform forwards chunks immediately. It holds terminal EOF until durable intake succeeds, so a
captured response is not reported complete while its only recovery copy is still in memory.

## Durable intake and `waitUntil`

R2 delivery-envelope creation is the acceptance boundary and gates terminal success. Queue
publication, stale-envelope sweeps, skipped-exchange bookkeeping, and log flushing use
`c.executionCtx.waitUntil()` so they may outlive the handler without becoming the only durable copy.

## SSE Streaming Support

For Server-Sent Events (SSE) responses (`Content-Type: text/event-stream`), the proxy parses individual events to extract detailed timing and token data. It tracks:

- Message boundaries (message_start, message_stop)
- Content blocks (thinking, text, tool_use)
- Token usage accumulated across events
- Per-block timing for Gantt chart visualization

## R2 Storage

Request and response bodies are encrypted together inside the pending delivery envelope. Proxy
Consumer later copies that encrypted payload to the canonical Body Object key:

- Pending delivery: `trace-deliveries/{environment-namespace}-{uuid}`
- Combined body payload: `bodies/{requestId}`

When body storage is omitted, the envelope contains metadata only. A failed envelope write is a
retryable intake failure, not a body-less queue success.

Body objects are encrypted before storage using `BODY_ENCRYPTION_ROOT_KEY`, `BODY_ENCRYPTION_KEY_ID`,
and the owning organization id. The Proxy refuses to store bodies when the encryption context is
missing.

## Queue Message Structure

After capture, the proxy enqueues `TraceDeliveryMessage`: a version marker, the R2 envelope key, and
optional Sentry trace context. Request metadata, tokens, errors, SSE data, W3C context, and the optional
encrypted Body Object remain in the referenced envelope.

## W3C Trace Context Support

The proxy supports distributed tracing through W3C Trace Context headers:

- `traceparent`: Extracts trace ID and parent span ID
- `tracestate`: Preserved for vendor-specific context
- `baggage`: Parsed into span attributes

If no traceparent is provided, the proxy generates a new trace ID.

## OTLP Ingestion

In addition to LLM proxying, the worker exposes a `/v1/traces` endpoint for direct OpenTelemetry trace ingestion. This allows external services to send traces that appear alongside LLM requests in the dashboard.

## Bindings

| Binding         | Type         | Purpose                                     |
| --------------- | ------------ | ------------------------------------------- |
| `REQUEST_QUEUE` | Queue        | Sends delivery references to Proxy Consumer |
| `STORAGE`       | R2 Bucket    | Stores pending delivery envelopes           |
| `API_KEYS`      | KV Namespace | Validates API keys                          |

Secrets and variables:

- `BODY_ENCRYPTION_ROOT_KEY` - root key for encrypted body objects
- `BODY_ENCRYPTION_KEY_ID` - write key id recorded in encrypted envelopes

## Caching

API key validation and billing status KV reads use a two-layer cache (module-scope Map + Cache API) to avoid per-request KV billing. See [Proxy KV Caching](../../docs/adr/0006-proxy-kv-caching.md) for the full cost analysis and architecture.

## Key Files

- `apps/proxy/src/index.ts` - Main Hono application and request handler
- `apps/proxy/src/cache.ts` - Two-layer cache (L1 module-scope + L2 Cache API)
- `apps/proxy/src/auth.ts` - API key validation and billing status checks
- `apps/proxy/src/usage.ts` - Durable Object usage quota checks
- `apps/proxy/src/providers.ts` - Provider routing configuration
- `apps/proxy/src/streaming/capture.ts` - Stream duplication and capture logic
- `apps/proxy/src/streaming/sse.ts` - SSE event parsing
- `apps/proxy/src/delivery.ts` - delivery-envelope storage, publication, and sweep
- `apps/proxy/src/transaction.ts` - transaction construction and durable intake
