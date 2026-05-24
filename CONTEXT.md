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
One of four roles a Span plays within a Trace. The Consumer emits each variant from `buildSpans`:

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
One of the proxy's four named handler stages: **validateRequest** → **forwardToUpstream** → **attachCapture** → **respond**. The first three return refined records (`ValidatedRequest`, `ForwardedExchange`, `AttachedCapture`) that compose the prior by inclusion — `attached.forwarded.validated.keyData.orgId` traces back to where it was set. `respond` consumes `AttachedCapture` and returns the client `Response`. There is no single shared context object.

Post-response (inside `c.executionCtx.waitUntil`), the captured exchange is drained into a `DrainedCapture`, a **Transaction** is built from it via `buildTransaction()`, and `persistTransaction()` writes the **Body Object**, sends the **Queue Message**, and records analytics. The skip path (`recordSkippedExchange`) is separate — it cancels the capture stream and writes skip analytics without producing a Transaction.

**Recording Policy**:
The module (`apps/proxy/src/recordingPolicy.ts`) that owns the billing + usage + decision dance. Both ingress paths (proxy and OTLP) call `evaluateRecordingPolicy(env, orgId, count)` and switch on `decision.reason` instead of sequencing `checkBillingStatus` → skip rule → `checkUsage` → combinator themselves. Emits a `TracingDecision` (`record: boolean` + `reason`) plus the underlying `UsageCheckResult`. The skip rule (suspended/canceled/no-subscription short-circuit usage) lives here so both paths agree.
_Avoid_: "tracing gate", "ingest gate" (used to mean similar things but blur with rate limits).

### LLM domain

**Provider**:
One of `openai`, `anthropic`, `google`, `openrouter`, `groq`. Each Provider is a module under `packages/llm-providers/src/providers/` that owns request-body parsing, response metadata + token extraction (whole-body and streaming), SSE event handling, and routing config behind a single `Provider` interface. Callers reach the adapter via `getProvider(id)` or `route.provider` instead of switching on `ProviderId`.
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
The org-scoped credential sent as `X-Trace-Flow-Api-Key`. Distinct from upstream provider API keys, which the proxy forwards untouched. Carries both an `orgId` and an optional `userId`, so data stamped with an API Key resolves to a User and an Organization.
_Avoid_: shortening to "key" without context.

**Project**:
A user-declared grouping that unifies all activity for one app or initiative — spanning both agent conversations (**Agent Sessions**) and proxied **LLM Requests** — so it can be viewed as a whole. May span many **API Keys** and many repositories. A Project groups data for viewing; it is not a property stamped onto the data. Not yet built.
_Avoid_: confusing with `~/.claude/projects` (Claude Code's local per-workspace directory, which is closer to a single repository).

**Subscription Tier**:
`hobby` or `pro`. Drives `monthlyUnits`, overage pricing, **Retention Window**, and **Visibility Window**.
_Avoid_: "plan".

**Billing Status**:
`active` / `grace` / `suspended` / `canceled`. Orthogonal to Subscription Tier.

**Monthly Units**:
The per-Tier monthly quota (`TIER_CONFIG`).

**Addon**:
Purchased block of `UNITS_PER_ADDON` (100k) units beyond the Monthly Units allotment.
_Avoid_: "topup" (means the auto-recharge feature, a different thing).

**Retention Window**:
How long data is physically stored before deletion. Proxy Spans: Tier-based (hobby 7d, pro 30d), stamped as `RetentionExpiresAt` at write-time. Agent facts: flat and Tier-independent; the **Raw Transcript** shares that flat horizon, while aggregates outlive it. May exceed the **Visibility Window**.
_Avoid_: "TTL" as the user-facing name; conflating with **Visibility Window**.

**Visibility Window**:
How far back a Subscription Tier may query, enforced at read-time. Can be shorter than what is retained, so upgrading a Tier reveals already-stored history without re-ingesting. For proxy Spans it equals the Retention Window; for agent facts a hobby org sees only the last week of a longer-retained store.
_Avoid_: "retention" when you mean what a Tier can see.

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

### Agent analytics

**Collector**:
The local Trace Flow desktop app (menu-bar tray) that parses **Source** transcripts into facts and uploads them to ingestion. Raw transcript upload is a separate, explicit opt-in (default off): when enabled it also sends the gzip-compressed **Raw Transcript**, encrypted at rest server-side, never stored as plaintext, and kept only for the replay window. Parsing is always local.
_Avoid_: "agent", "parser" (the parser is one component of the Collector).

**Source**:
The agent tool that produced an **Agent Session** — `claude`, `codex`, or `cursor`. Sources overlap but differ in field coverage, so facts must tolerate sparse source-specific fields.
_Avoid_: "vendor", "agent".

**Agent Session**:
One canonical AI-agent conversation, identified by its **Source** plus the source's own session ID (a stable UUID for Claude and Codex). The agent-analytics analogue of a **Trace**, but a separate table and ID space.
_Avoid_: bare "session" (collides with **MCP Session**), "conversation".

**Agent Message**:
One turn within an **Agent Session**, a single assistant or user record. The grain at which `model`, token counts (input, output, cache read, cache creation, reasoning), and `cost` are recorded. The agent-analytics analogue of an **LLM Request**.
_Avoid_: unqualified "message" (collides with chat-UI message), "turn" alone.

**Tool Event**:
A single tool invocation inside an **Agent Message**, carrying the tool name, command family (the first one or two tokens of a shell command, e.g. `git commit`), exit code, and success or failure. The grain at which agent failures are measured.
_Avoid_: "tool call" when you mean its result; not an **LLM Request**.

**Repo**:
The canonical git repository an Agent Session acted in, identified by its normalized git remote so worktrees and renamed checkouts collapse to one identity. Path/`cwd` is a fallback, never the identity.
_Avoid_: "worktree", "checkout", "path"; not a **Project** (which may span many Repos).

**Raw Transcript**:
The compressed, server-encrypted copy of one **Source** transcript, uploaded only when the user opts in (default off) and retained only for the replay window, then purged. The replay source for re-deriving facts server-side when the parser improves (so ingestion is one-time), and the substrate for bounded deep analysis. The agent-analytics analogue of a **Body Object**.
_Avoid_: "conversation dump"; not a fact table and not an **Agent Session**.

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
- **"project"** was used for both a Trace Flow **Project** (a declared cross-source grouping) and `~/.claude/projects` (Claude Code's local per-workspace storage). _Resolved_: capitalized **Project** is the Trace Flow grouping; the local directory is "the local projects directory" and maps closer to a single repository.
- **"session"** means three different things: an **Agent Session** (a parsed agent conversation), an **MCP Session** (a Model Context Protocol session), and a vendor "session id" inside Source transcripts. _Resolved_: always qualify as **Agent Session** or **MCP Session**; "vendor session ID" is the raw Source identifier that seeds an Agent Session's identity.
