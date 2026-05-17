# Trace Flow

LLM observability platform. The proxy captures upstream LLM calls at the edge, asynchronously persists bodies to R2 and metadata to Tinybird, and serves a dashboard against both. This file fixes the vocabulary used across `apps/` and `packages/`; ADRs in `docs/adr/` record the decisions behind it.

## Language

### Data-flow entities

**LLM Request**:
A client's call to an upstream LLM provider, captured by the proxy. The request body itself is "the request body"; the captured artifact is the LLM Request.
_Avoid_: "user request", "inbound request" (ambiguous with the worker's HTTP request).

**LLM Response**:
The provider's reply, streaming or non-streaming.
_Avoid_: "completion" (overloaded with the OpenAI Completions API).

**Transaction**:
The combined captured artifact for one LLM Request + LLM Response. The unit the platform produces and the unit of metering. The `X-Trace-Flow-Recording` response header is a code-level holdover from an earlier name and should be read as "this Transaction's identifiers".
_Avoid_: "recording", "log entry", "capture".

**Body Object**:
The R2 object at `bodies/{requestId}` holding request + response bodies (encrypted with `EncryptedStoredBodiesPayload`). The bodies themselves are "the request body" / "the response body"; the persisted artifact is the Body Object.
_Avoid_: "body blob", "stored payload".

**Queue Message**:
Lightweight metadata sent from proxy to consumer. Two variants: `LLMQueueMessage` (proxy path) and `OTLPQueueMessage` (OTLP ingest path), unioned as `QueueMessageUnion`.
_Avoid_: "queue payload", "trace event".

**Trace**:
The top-level OTel grouping identified by a `TraceId`. May contain many Spans.
_Avoid_: using "trace" to mean a single row.

**Span**:
One row in Tinybird's `otel_traces`. Write-shape is `TinybirdTrace` (`@trace-flow/types`); read-shape is `TraceSpanRow` (`@trace-flow/spans`).
_Avoid_: "trace row", "trace record".

**Span Variant**:
One of four roles a Span plays within a Trace. The Consumer emits each variant from `buildTraces`:

- **Root Span** — `SPAN_KIND_CLIENT`, named `{operation} {model}`. Carries request-level attributes (tokens, cost, latency, TTFT, response metadata).
- **Response Span** — `SPAN_KIND_INTERNAL`, named `gen_ai.response.{text|embedding}`. Emitted for non-streaming responses, child of Root Span.
- **Content Block Span** — `SPAN_KIND_INTERNAL`, named `gen_ai.response.{type}[.{N}]`. One per streaming content block (text, thinking, tool_use), child of Root Span.
- **Tool Execution Span** — `SPAN_KIND_INTERNAL`, named `gen_ai.tool.execution`. Cross-Trace tool-call duration, child of Root Span with a `Links.TraceId` back to the originating Trace.
  _Avoid_: "non-streaming child", "block span" (unqualified), "tool span".

### Workers and stages

**Proxy**:
`apps/proxy`. Edge worker that streams LLM Requests to providers and emits Body Objects + Queue Messages.

**Consumer**:
`apps/proxy-consumer`. Queue consumer that turns Queue Messages into Spans and forwards them to Trace Shards.
_Avoid_: "ingester".

**TraceBatcher**:
The Durable Object class (`apps/proxy-consumer/src/batcher.ts`) that accumulates Spans before insert. One instance per Trace Shard.

**Trace Shard**:
A single TraceBatcher instance. Queue Messages fan out across Trace Shards to amortize Tinybird inserts. A `*/5 * * * *` cron flushes stale Trace Shards. Named with the "Trace" prefix so other shard types (e.g. for usage rollups or rate limits) can coexist without ambiguity.
_Avoid_: "shard" (unqualified), "partition", "batcher worker".

**API Worker**:
`apps/api`. Read-side worker for Body Object retrieval and Tinybird Pipe passthrough used by the Web app.
_Avoid_: "backend".

**Web**:
`apps/web`. Next.js dashboard served on Cloudflare Workers via OpenNext.
_Avoid_: "frontend", "dashboard worker".

**Pipeline Stage**:
One of the proxy's four named handler stages: **validateRequest** → **forwardToUpstream** → **attachCapture** → **respond**, threaded through a `CaptureContext`.

**CaptureContext**:
The single record passed between Pipeline Stages and into `captureAndEnqueue`. Replaced the prior 23-field params object.

### LLM domain

**Provider**:
One of `openai`, `anthropic`, `google`, `openrouter`, `groq`. Each has a schema entry in `@trace-flow/llm-providers`.
_Avoid_: "vendor", "backend".

**Route**:
A path prefix that maps to a Provider (e.g. `/openai/v1/*`). Routing lives in `@trace-flow/llm-providers/routing`.
_Avoid_: "endpoint", "path".

**Operation**:
The `gen_ai.operation.name` OTel attribute (e.g. `chat`, `embedding`, `responses`). One Transaction has one Operation.
_Avoid_: "action", "verb".

**Token Accumulator**:
The per-Provider SSE state machine in `@trace-flow/llm-providers/accumulator` that folds events into a final `LLMTokenUsage`.

**Raw Token Totals**:
The pre-normalization shape both the Token Accumulator (streaming) and `parseTokenUsage` (whole-body) produce before `applyTokenSchema` turns them into a canonical `LLMTokenUsage`. Carries upstream-named running sums (`inputTokens`, `cacheCreation5mTokens`, `explicitTotal`, `thinkingChars`, …); the schema rules that turn those into `promptTokens` / `uncachedInputTokens` / derived `totalTokens` live in one place rather than at each call site.

**SSE Event**:
A single parsed Server-Sent Events frame from an upstream stream.
_Avoid_: "chunk" (means a raw byte chunk, pre-parsing).

**Truncation**:
Proxy-side flag set when a response body exceeds the capture limit; the Transaction is marked `truncated: true` but the client still receives the full stream.

### Billing and tenancy

**Organization**:
The tenant entity (`orgId`). Owns API Keys, has one Subscription Tier, and is the unit of retention and rate limiting.
_Avoid_: "account", "workspace", "team" (Convex has its own `organizationMembers` table for the membership relation).

**API Key**:
The org-scoped credential sent as `X-Trace-Flow-Api-Key`. Distinct from upstream provider API keys, which the proxy forwards untouched.
_Avoid_: shortening to "key" without context.

**Subscription Tier**:
`hobby` or `pro`. Drives `monthlyUnits`, overage pricing, Retention Window, and read-time Span visibility.
_Avoid_: "plan".

**Billing Status**:
`active` / `grace` / `suspended` / `canceled`. Orthogonal to Subscription Tier.

**Monthly Units**:
The per-Tier monthly quota (`TIER_CONFIG`).

**Addon**:
Purchased block of `UNITS_PER_ADDON` (100k) units beyond the Monthly Units allotment.
_Avoid_: "topup" (means the auto-recharge feature, a different thing).

**Retention Window**:
The Subscription Tier's visibility window (hobby: 7d, pro: 30d). Stamped into Spans as `RetentionExpiresAt` at write-time and enforced again at read-time.
_Avoid_: "TTL", "lifecycle".

### Tinybird

**Pipe**:
A named Tinybird query, e.g. `trace_detail.pipe`. Frontend calls Pipes via the Tinybird Client (`@trace-flow/tinybird-client`).

**Datasource**:
A Tinybird table, e.g. `otel_traces.datasource`. Has an attached `_quarantine` datasource for schema-rejected rows.

**Pipe Token**:
Short-lived JWT (HS256, 10-minute TTL) signed by Convex with `fixed_params` for `api_keys` and `retention_days`. Used by Web and MCP for direct Tinybird reads.
_Avoid_: "user token", "JWT" (too generic).

**Admin Token**:
Tinybird's master credential. Lives only in Convex env; used for admin SQL and Pipe Token minting. Never reaches the frontend.

### Security

**Tenant Encryption Key**:
The per-Organization AES-GCM key derived from a worker-held root key (HKDF-SHA-256) used to encrypt Body Objects at rest.
_Avoid_: "DEK" (the abbreviation isn't used in code).

**PII Redaction**:
Proxy-side redaction of common PII patterns before bodies are written to R2 or referenced from the Queue Message.

### MCP

**MCP Session**:
A Model Context Protocol session (Convex table `mcpSessions`), scoped to one user.

**MCP Tool**:
A tool exposed by the MCP server (e.g. `getTraceAction`, `listTracesAction`). MCP Tools obtain Pipe Tokens via `generateTokenInternal`, not the user-facing path.

## Relationships

- A **Client** calls the **Proxy**, which forwards to a **Provider** matched by **Route**.
- The **Proxy** writes one **Body Object** to R2 and sends one **Queue Message** per **LLM Request**.
- The **Consumer** receives **Queue Message** batches, builds **Spans**, and hands them to a **Trace Shard**.
- A **Trace Shard** flushes accumulated **Spans** into the `otel_traces` **Datasource**.
- The **Web** app reads **Spans** through Tinybird **Pipes** (using a **Pipe Token**) and fetches **Body Objects** through the **API Worker**.
- An **Organization** owns its **API Keys** and has exactly one **Subscription Tier**; the Tier determines the **Retention Window** stamped onto each **Span**.
- A **Pipe Token** is scoped to an **Organization**'s **API Keys** and **Retention Window**.

## Example dialogue

> **Dev:** "When the Proxy captures a streaming response, does it write the Body Object before sending the Queue Message?"
> **Domain expert:** "Both happen inside `waitUntil`. Order isn't guaranteed, but the Consumer doesn't need the Body Object — only the Web app does, and that's much later. The Queue Message and Body Object share a `requestId` so they can be joined on read."
>
> **Dev:** "If a Hobby user's Retention Window is 7 days, does the Span disappear from Tinybird at 7 days?"
> **Domain expert:** "No. `RetentionExpiresAt` is stamped at write-time, but the row stays. We filter on it at read-time using the caller's current Tier, so an upgrade widens visibility for already-stored Spans. The Body Object has its own lifecycle (30 days, R2-managed) independent of Span retention."

## Flagged ambiguities

- **"request"** was used to mean (a) a client HTTP request to the proxy, (b) the captured **LLM Request**, (c) the `request` field on a Queue Message, and (d) the `LLMRequest` type. _Resolved_: use **LLM Request** for the captured artifact; "the request body" for the raw body; "the inbound HTTP request" if you mean the worker's `Request` object.
- **"trace"** was used to mean both a single Tinybird row and the OTel grouping. _Resolved_: row is a **Span**, the grouping is a **Trace**.
- **"body"** was used to mean both raw request/response text and the encrypted R2 wrapper. _Resolved_: raw text is "the request/response body"; the R2 artifact is a **Body Object**.
- **Root key naming** — `EncryptedStoredBodiesPayload` references a root key threaded into the worker as `rootKeyBase64`, but there's no canonical noun for the key itself. _Unresolved_: pick a project term ("Root Encryption Key"? "Body Root Key"?) and align the env var with it.
