# Trace Flow

Model API and coding-agent observability platform. The proxy captures upstream LLM calls at the edge,
durably stages accepted deliveries in R2, and sends metadata to Tinybird through a queue consumer. The
dashboard reads Tinybird analytics and encrypted R2 Body Objects. This file fixes the vocabulary used
across `apps/` and `packages/`; ADRs in `docs/adr/` record the decisions behind it.

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
The queue transport from Proxy to Proxy Consumer. New writes use a small `TraceDeliveryMessage`
reference to a durable **Trace Delivery Envelope**; legacy `LLMQueueMessage` and `OTLPQueueMessage`
variants remain readable during cutover. All variants are unioned as `QueueMessageUnion`.
_Avoid_: "queue payload", "trace event".

**Trace Delivery Envelope**:
The versioned R2 object under `trace-deliveries/` that holds one accepted transaction's metadata and,
unless body storage was omitted, its already encrypted Body Object. It remains until Proxy Consumer
durably stages the spans and copies the Body Object to `bodies/{requestId}`. A scheduled Proxy sweep
republishes stale references.
_Avoid_: "temporary body", "queue payload", assuming queue publication is the durability boundary.

**Trace**:
The top-level OTel grouping identified by a `TraceId`. May contain many Spans.
_Avoid_: using "trace" to mean a single row.

**Span**:
One row in Tinybird's `otel_trace_spans`. Write-shape is `TinybirdTrace` (`@trace-flow/types`); read-shape is `TraceSpanRow` (`@trace-flow/spans`).
_Avoid_: "trace row", "trace record".

**Span Variant**:
One of four roles a Span plays within a Trace. The Proxy Consumer emits each variant from `buildSpans`:

- **Root Span** — `SPAN_KIND_CLIENT`, named `{operation} {model}`. Carries request-level attributes (tokens, cost, latency, TTFT, response metadata).
- **Response Span** — `SPAN_KIND_INTERNAL`, named `gen_ai.response.{text|embedding}`. Emitted for non-streaming responses, child of Root Span.
- **Content Block Span** — `SPAN_KIND_INTERNAL`, named `gen_ai.response.{type}[.{N}]`. One per streaming content block (text, thinking, tool_use), child of Root Span.
- **Tool Execution Span** — `SPAN_KIND_INTERNAL`, named `gen_ai.tool.execution`. Cross-Trace tool-call duration, child of Root Span with a `Links.TraceId` back to the originating Trace.
  _Avoid_: "non-streaming child", "block span" (unqualified), "tool span".

### Workers and stages

**Proxy**:
`apps/proxy`. Edge worker that streams LLM Requests to providers and durably stages Trace Delivery
Envelopes before publishing Queue Message references.

**Proxy Consumer**:
`apps/proxy-consumer`. Queue consumer that turns Queue Messages into Spans and forwards them to Trace Shards.
_Avoid_: "Consumer" when agent analytics is also in scope; use "Proxy Consumer" to distinguish it from **Agent Consumer**.

**TraceBatcher**:
The Durable Object class (`apps/proxy-consumer/src/batcher.ts`) that accumulates Spans before insert. One instance per Trace Shard.

**Trace Shard**:
A single TraceBatcher instance. Queue Messages fan out across Trace Shards to amortize Tinybird inserts. A `*/5 * * * *` cron flushes stale Trace Shards. Named with the "Trace" prefix so other shard types (e.g. for usage rollups or rate limits) can coexist without ambiguity.
_Avoid_: "shard" (unqualified), "partition", "batcher worker".

**Agent Ingest**:
`apps/agent-ingest`. Public Collector intake worker for Agent Conversation Analytics. It accepts gzip fact envelopes from the CLI/Desktop Collector, authenticates **Collector Credentials**, applies compatibility and rate-limit checks, claims **Agent Session** ownership through Convex, and enqueues agent fact messages.
_Avoid_: "agent proxy", "desktop API", "collector backend".

**Agent Consumer**:
`apps/agent-consumer`. Queue consumer that drains agent fact messages, prices **Agent Message** facts from `MODEL_PRICING`, dedupes through **AgentFactBatcher**, and writes `agent_*` Tinybird datasources.
_Avoid_: "Consumer" without the "Agent" qualifier.

**AgentFactBatcher**:
The Durable Object class (`apps/agent-consumer/src/fact-batcher.ts`) that owns cross-delivery dedupe for agent fact rows before Tinybird insert. Same-key changed facts are repair signals, not blind overwrites.

**Pipes API Worker**:
`apps/pipes-api`. Read-side worker for Tinybird Pipe passthrough used by the Web app. It forwards Convex-minted Pipe Tokens to Tinybird and does not bind raw-object credentials or `TINYBIRD_ADMIN_TOKEN`.
_Avoid_: "API Worker" when discussing Body Object retrieval.

**Raw API Worker**:
`apps/api`. Read-side worker for Body Object retrieval used by the Web app. It binds Body Object storage/decryption/access-token material and does not contain Tinybird Pipe forwarding logic.
_Avoid_: "backend".

**Archive API**:
The `apps/archive-api` Worker, implemented but not yet deployed, that will serve `https://archive.trace-flow.dev`. It is the sole public data-plane boundary for **Conversation Archive** upload, durable acknowledgement, owner export, and deletion. It exclusively binds the Agent Archive R2 Standard bucket, which uses Cloudflare's fixed `us` jurisdiction in the first release; its R2 binding and access path specify `jurisdiction: "us"`. P8 must use a current Cloudflare API or client version that supports this jurisdiction rather than substituting a non-binding location hint. It also binds **Archive Encryption Key** material. Uploads require a **Collector Credential** plus valid **Collector Enrollment**; reads require an **Archive Export Grant**. It does not bind proxy Body Object secrets, Tinybird credentials, or agent fact queues.
_Avoid_: extending **Agent Ingest** or the **Raw API Worker** with transcript storage, "Archive Worker" when referring to the product.

**Web**:
`apps/web`. Next.js dashboard served on Cloudflare Workers via OpenNext.
_Avoid_: "frontend", "dashboard worker".

**Pipeline Stage**:
One of the proxy's four named handler stages: **validateRequest** → **forwardToUpstream** → **attachCapture** → **respond**. The first three return refined records (`ValidatedRequest`, `ForwardedExchange`, `AttachedCapture`) that compose the prior by inclusion — `attached.forwarded.validated.keyData.orgId` traces back to where it was set. `respond` consumes `AttachedCapture` and returns the client `Response`. There is no single shared context object.

For a captured response, the exchange is drained into a `DrainedCapture`, a **Transaction** is built
through `buildTransaction()`, and `persistTransaction()` writes a durable **Trace Delivery Envelope**.
Streaming responses can begin immediately, but terminal EOF waits for that R2 write. Queue publication
continues in `c.executionCtx.waitUntil()`, and a scheduled sweep republishes stale envelope references.
Proxy Consumer copies the encrypted **Body Object** to its canonical key, durably stages the spans,
then deletes the envelope. The skip path (`recordSkippedExchange`) is separate: it cancels the capture
stream and writes skip analytics without producing a Transaction.

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
The tenant entity (`orgId`). Owns user-facing **API Keys** and hidden **Collector Credentials**, has one Subscription Tier, and is the unit of retention and rate limiting.
_Avoid_: "account", "workspace", "team" (Convex has its own `organizationMembers` table for the membership relation).

**API Key**:
The user-facing org-scoped credential sent as `X-Trace-Flow-Api-Key` for proxied **LLM Requests** and API-key-scoped dashboards. Distinct from upstream provider API keys, which the proxy forwards untouched, and distinct from a **Collector Credential**.
_Avoid_: shortening to "key" without context.

**Collector Credential**:
A hidden desktop-ingest credential minted for **Trace Flow Desktop**, scoped to one **Organization**, one **User**, one **Collector**, and allowed Collector capabilities. It authenticates Agent Session fact upload (and, if the separate **Provider Usage Tracking** feature ships, **Provider Usage Snapshots**), but it is not a user-facing **API Key**, cannot proxy LLM Requests, and must not appear in API key lists, filters, alerts, or Tinybird API-key JWT scopes. It can be revoked through a separate Connected Desktops/security surface or support/admin path without exposing the secret. Rotating, replacing, or revoking it must not fragment Agent Session identity.
_Avoid_: "desktop API key" when discussing the product surface.

**Project**:
A user-declared grouping that unifies all activity for one app or initiative — spanning both agent conversations (**Agent Sessions**) and proxied **LLM Requests** — so it can be viewed as a whole. May span many **API Keys**, Collector-originated **Agent Sessions**, and **Repos** (including fragmented **Provisional Repos**). A Project groups data for viewing; it is not a property stamped onto the data. It is the **stable trust anchor** above the messy **Repo** identity layer: untrustworthy or fragmented Repo data is associated to a Project by an explicit, reversible **Project Claim** rather than by trusting the underlying fingerprint. Not yet built.
_Avoid_: confusing with `~/.claude/projects` (Claude Code's local per-workspace directory, which is closer to a single repository); treating Project membership as auto-derived from repo identity rather than from a **Project Claim**.

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
How long data is physically stored before deletion. Proxy Spans: Tier-based (hobby 7d, pro 30d), stamped as `RetentionExpiresAt` at write-time. Agent facts: a flat one-year, Tier-independent horizon keyed by **EventAt**; **Agent Session** summaries are keyed by **LastEventAt**. Lossless **Raw Transcripts** exist only inside an explicitly enrolled Pro **Conversation Archive** and use **Paid Archive Retention**. May exceed the **Visibility Window**.
_Avoid_: "TTL" as the user-facing name; conflating with **Visibility Window**.

**Paid Archive Retention**:
A retention policy with no age-based expiry while an **Organization** has an active Pro entitlement. Losing Pro stops archive collection and freezes the archive for a 90-day grace period in which the **Archive Steward** may export or restore Pro. When grace ends, Trace Flow destroys every **Archive Encryption Key** version before deleting the R2 objects.
_Avoid_: "permanent retention", "account-lifetime retention", retaining an archive indefinitely after Pro ends.

**Visibility Window**:
How far back a Subscription Tier may query, enforced at read-time. Can be shorter than what is retained, so upgrading a Tier reveals already-stored history without re-ingesting. For proxy Spans it equals the Retention Window; for agent facts a hobby org sees only the last week of a longer-retained store.
_Avoid_: "retention" when you mean what a Tier can see.

### Environments

The word **"dev"** is overloaded and has caused real confusion: a Worker named `*-dev` is not a deployed cloud environment, and "run the dev env" can mean two different data planes. These terms fix that. The split that matters is **control plane** (which Worker code runs, and _where_) vs **data plane** (which Convex deployment + Tinybird workspace the running Workers read and write).

**Local Workers**:
The six non-Web Workers run as local `wrangler dev` processes via `bun run dev:all` (`scripts/dev/workers.sh`): **Proxy**, **Proxy Consumer**, **Raw API Worker**, **Pipes API Worker**, **Agent Ingest**, and **Agent Consumer**. They run under their default top-level config, which uses `*-dev` names (`trace-flow-agent-ingest-dev`, etc.). The `*-dev` name is the **default/top-level wrangler config**, the code that runs locally; it is _not_ by itself a separately deployed cloud "dev" Worker. The other real deployed environments are `[env.production]` and, for some Workers, `[env.preview]`. `apps/agent-ingest` and `apps/agent-consumer` now have production env blocks, but production readiness still depends on the agent-analytics gates in `docs/guides/agent-conversation-analytics/ROADMAP.md`.
_Avoid_: saying "deploy to dev" or "the dev Workers" as if a cloud dev environment exists; it does not.

**Cloud-Dev**:
The everyday development data plane: **Local Workers** pointed at a real **Convex Cloud dev deployment** and a real **Tinybird Cloud dev workspace**. Data lands in the cloud dashboards and in a local **Web** reading from the cloud. This is what a developer usually means by "my dev environment" and "where my data ends up." The target is chosen by env vars (`TRACE_FLOW_CONVEX_URL` / `CONVEX_SITE_URL`, `TRACE_FLOW_TINYBIRD_HOST` + `TINYBIRD_TOKEN`), not by Worker name.
_Avoid_: assuming the dev scripts default to Cloud-Dev — they default to **Self-Contained Local**.

**Self-Contained Local**:
A fully local, no-cloud-credentials data plane: **Local Workers** plus **Convex local** (`127.0.0.1:3210`) and **Tinybird Local** in Docker (`127.0.0.1:7181`). Built so isolated runtimes (Cursor Background Agents, CI) can run the whole stack without cloud access. This is what `scripts/dev/start.sh` provisions **by default** (`tb local start`, generated local tokens; see `docs/agents/local-environment.md`). Data is visible only locally, never in a cloud dashboard.
_Avoid_: conflating with **Cloud-Dev**; assuming agents on this stack can see a developer's Cloud-Dev data, or vice versa.

**Control Plane** / **Data Plane**:
The **Control Plane** is Convex: it mints **Collector Credentials**, holds the compatibility policy, and answers Agent Session ownership claims. The **Data Plane** is Tinybird: the `otel_trace_spans` and `agent_*` **Datasources** the **Proxy Consumer** and **Agent Consumer** write and the **Web** reads. A given set of **Local Workers** can point each plane at cloud or local independently (e.g. Tinybird Cloud-Dev for rows while Convex stays local), which is why "dev" must always name _which plane_ points _where_.

#### Concrete endpoints (canonical — stop rediscovering these)

The Cloudflare **workers.dev subdomain** for this account is `isaac-a46` (account `Isaac@zaks.io`,
id `a461d640900eb3905d7b6619c8c0da91`). Deployed `*-dev` Workers keep `workers_dev` enabled (no custom
route), so each is live at `https://<worker-name>.isaac-a46.workers.dev`. Production Workers set
`workers_dev:false` and serve on a `*.trace-flow.dev` custom route. Verify a Worker is live with an
unauthenticated request: a deployed Worker returns 401/403/400 (auth/validation), a missing one returns
Cloudflare's 404.

| Purpose                                                                               | Dev (deployed cloud `-dev` Worker)                                       | Production                                                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Agent ingest (`POST /v1/ingest`) — collector egress target                            | `https://trace-flow-agent-ingest-dev.isaac-a46.workers.dev`              | `https://collector.trace-flow.dev`                                                                       |
| Agent consumer (queue → Tinybird)                                                     | `trace-flow-agent-consumer-dev` (queue consumer, no public route)        | `trace-flow-agent-consumer`                                                                              |
| Web dashboard                                                                         | `https://trace-flow-web-dev.isaac-a46.workers.dev` (`/app/agents`)       | prod web has no custom route in `apps/web/wrangler.jsonc` — confirm the live prod host before citing one |
| LLM proxy / gateway                                                                   | `https://trace-flow-proxy-dev.isaac-a46.workers.dev` (`/` → 401, live)   | `https://gateway.trace-flow.dev`                                                                         |
| Tinybird Pipe API                                                                     | `https://trace-flow-pipes-api-dev.isaac-a46.workers.dev` (`/v0/pipes/*`) | `https://pipes.trace-flow.dev`                                                                           |
| Body-retrieval Raw API                                                                | `https://trace-flow-raw-api-dev.isaac-a46.workers.dev` (`/bodies/*`)     | `https://raw.trace-flow.dev`                                                                             |
| Analyst Sandbox (Analyst code execution; `/` → 404, live)                             | `https://trace-flow-analyst-sandbox-dev.isaac-a46.workers.dev`           | `https://analyst-sandbox.trace-flow.dev`                                                                 |
| Conversation Archive API (implemented, not deployed)                                  | not deployed (`error code: 1042`)                                        | `https://archive.trace-flow.dev` (reserved, not deployed)                                                |
| Convex **site** origin (`/collector/authorize`, `/agent-ingest/compatibility-policy`) | `https://hardy-iguana-812.convex.site`                                   | `https://laudable-bison-427.convex.site`                                                                 |

**Collector env overrides** (CLI + desktop; `packages/collector-embedder/src/defaults.rs` bakes **production**,
so reaching the cloud `-dev` target REQUIRES setting these): `TRACE_FLOW_INGEST_URL` = the dev ingest Worker
URL above, `TRACE_FLOW_CONVEX_SITE_URL` = the dev Convex site origin above, `TRACE_FLOW_WEB_URL` = the dev web
dashboard URL. Do **not** point a collector at `http://127.0.0.1:8787` for verify/sync — that is a **Local
Worker** process, not the deployed cloud `-dev` Worker, and is only used in **Self-Contained Local** mode.

### Tinybird

**Pipe**:
A named Tinybird query, e.g. `trace_detail.pipe`. Frontend calls Pipes via the Tinybird Client (`@trace-flow/tinybird-client`).

**Datasource**:
A Tinybird table, e.g. `otel_trace_spans.datasource`. Has an attached `_quarantine` datasource for schema-rejected rows.

**Pipe Token**:
Short-lived JWT (HS256, 10-minute TTL) signed by Convex with `fixed_params` for row-level read constraints. Proxied **LLM Request** pipes use `api_keys` and `retention_days`; agent-analytics pipes use organization scope; the separate **Provider Usage Tracking** feature adds user scope for user-private **Provider Usage Snapshots**. The Web sends Pipe Tokens to the **Pipes API Worker**, which forwards them to Tinybird; Convex is the only Tinybird admin-token holder.
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

**Trace Flow Tool**:
A shared tool implementation that exposes a bounded Trace Flow operation to AI-facing surfaces.
_Avoid_: "MCP Tool" when the implementation is shared beyond MCP.

**MCP Tool**:
A **Trace Flow Tool** exposed through the MCP server (e.g. `getTraceAction`, `listTracesAction`). MCP Tools obtain Pipe Tokens via `generateTokenInternal`, not the user-facing path.

### Analyst

**Trace Flow Analyst**:
The dedicated conversational analysis product surface for asking questions about Trace Flow data.
_Avoid_: "agent" (collides with **Agent Session** and **Source**).

**Analyst Sidebar**:
The collapsible right-side **Trace Flow Analyst** chat surface.
_Avoid_: "agent sidebar".

**Analyst Runtime**:
The isolated runtime that answers **Trace Flow Analyst** questions by coordinating model calls and approved tools.
_Avoid_: "agent runtime", "MCP runtime".

**Analyst Thread**:
A creator-private Trace Flow-owned conversation record for a **Trace Flow Analyst** session.
_Avoid_: "agent thread" when discussing product-owned conversation history.

**Analyst Tool**:
A **Trace Flow Tool** exposed to the **Analyst Runtime**.
_Avoid_: "MCP Tool" when discussing Analyst-only access.

**Context Selection Mode**:
A **Trace Flow Analyst** UI mode where a user selects visible page objects to attach to their next message.
_Avoid_: "screen scraping mode".

**Page Context Reference**:
A user-selected page object attached to an **Analyst Thread** message.
_Avoid_: "screenshot", "DOM scrape".

### Agent analytics

**Collector**:
The local Trace Flow component that parses **Source** transcripts into facts and uploads them to ingestion. Its user-facing desktop product is **Trace Flow Desktop**. Parsing is always local. Lossless transcript content leaves the machine only after Pro **Archive Activation** and per-Collector **Collector Enrollment**; there is no separate raw-upload mode.
_Avoid_: "agent", "parser" (the parser is one component of the Collector), using the product name when discussing architecture boundaries.

**Trace Flow Desktop**:
The user-facing desktop app for the **Collector**. It is the installed app name users see in menus, release artifacts, permissions, and support docs.
_Avoid_: "TF Desktop" (ambiguous with Terraform), "Otto Desktop".

**Source**:
The agent tool that produced an **Agent Session** — `claude`, `codex`, or `cursor`. Sources overlap but differ in field coverage, so facts must tolerate sparse source-specific fields. Full economics (token, cost, cache) come from `claude` and `codex`; `cursor` carries partial economics from its `state.vscdb` store (`cursorDiskKV`) — session-grain model and sparse message-grain tokens, with cache coverage marked missing — not the `~/.cursor/projects` or `~/.cursor/acp-sessions` stores, which carry none.
_Avoid_: "vendor", "agent".

**Agent Session**:
One canonical AI-agent conversation, identified by its **Source** plus the source's own session ID (a stable UUID for Claude, Codex, and Cursor). The agent-analytics analogue of a **Trace**, but a separate table and ID space.
_Avoid_: bare "session" (collides with **MCP Session**), "conversation".

**Agent Session Authoring Cost**:
The API-equivalent estimated billable model cost represented by one **Agent Session**, including top-level and nested/subagent model usage exactly once. The cost unit used for **Pull Request Authoring Cost**. It is estimated from transcript tokens and model pricing; it is not actual provider spend, subscription amortization, credits, discounts, or invoice data.
_Avoid_: equating session cost with only top-level **Agent Message** rows when the **Source** records nested/subagent usage separately; calling it "$X spent" without saying it is estimated authoring cost.

**Agent Message**:
One turn within an **Agent Session**, a single assistant or user record. The grain at which direct model-call fields such as `model`, token counts (input, output, cache read, cache creation, reasoning), coverage fields (`token_coverage`, `cache_coverage`), and estimated cost are recorded. The agent-analytics analogue of an **LLM Request**.
_Avoid_: unqualified "message" (collides with chat-UI message), "turn" alone.

**Tool Event**:
A single tool invocation inside an **Agent Message**, carrying the tool name, the command program (the first token of a shell command, e.g. `git`), exit code, and success or failure. The grain at which agent failures are measured.
_Avoid_: "tool call" when you mean its result; not an **LLM Request**; a two-part "command family" like `git commit` — the family is the program alone, deliberately, so no curated list of programs can drift.

**Agent Capability**:
A tool, MCP-exposed tool, skill, slash command, or other local extension that a **Source** records as available to or used by an **Agent Session**. Trace Flow only knows about capabilities visible in the Source transcript or Source session metadata.
_Avoid_: using "tool" when you mean the whole available capability surface rather than an invoked **Tool Event**.

**Capability Snapshot**:
A point-in-time observation of **Agent Capabilities** inferred from a Source transcript or Source session metadata, with privacy-safe counts, stable IDs, and size estimates. It describes the conversation-visible capability surface, not local configuration.
_Avoid_: "tool usage" (that's observed through **Tool Events**), "MCP config dump" (raw config/schema text is not the product artifact).

**Context Bloat**:
The cost and quality drag caused by loading too many, too large, or too irrelevant **Agent Capabilities** into an agent's working context. It is estimated from transcript-visible capability-surface size, token usage, cache behavior, and actual **Tool Event** utilization.
_Avoid_: equating with high model usage alone; high useful context is not bloat.

**Effective Context Length**:
The empirically usable context size for a model under a benchmark or task class, which may be smaller than the advertised context window.
_Avoid_: treating the advertised context window as the effective one.

**Context Rot**:
The degradation in model accuracy, recall, or focus as input context grows.
_Avoid_: presenting as a hard cliff; it is usually a performance gradient.

**Context Rot Exposure**:
The amount of **Agent Session** activity running in token ranges where **Context Rot** is more likely for the session's model and task shape.
_Avoid_: treating as proof that a specific answer failed because of context length.

**Repo**:
The first-class Trace Flow representation of a git repository. Identified by its normalized git remote so worktrees and renamed checkouts collapse to one identity. The common code-level anchor for **Agent Sessions**, **Pull Requests**, and future code-aware views. An **Agent Session** has one primary Repo; other repos mentioned or touched during that session are outside the primary relationship.
_Avoid_: "worktree", "checkout", "path"; not a **Project** (which may span many Repos).

**Provisional Repo**:
A **Repo** identity derived from a path/`cwd` fallback because the Collector's sync layer could not resolve a normalized git remote at session time (`repo_source = 'path'`). It keeps local-only, pre-push, detached, and off-root work visible and groupable. A Provisional Repo's identity is `hash(path)`, so the same logical repository reached from a worktree, a renamed checkout, or a different absolute path produces _distinct_ Provisional Repos that do not merge. Provisional Repos are not automatically promoted to remote-backed **Repos**; they become trustworthy only by being claimed into a **Project**.
_Avoid_: treating path identity as equivalent to remote identity; merging by repository name alone; assuming a Provisional Repo "heals" into a Repo on its own (no such promotion exists — claiming into a Project is the trust path).

**Pull Request**:
A reviewable unit of work in a **Repo**. A useful authoring-cost grain _when one **Agent Session** maps cleanly to one Pull Request_, because it can include many commits and represents the change as reviewed or merged. It is **not** a reliable grain for orchestrated workflows: when an orchestrator delegates across many **Agent Sessions** (dispatch, remote workers, review), spend smears across sessions that no single Pull Request can own, and a **Source** whose cost is unreported (e.g. `cursor`) leaves the per-Pull-Request total silently incomplete. For those workflows, report at the **Project** + daily aggregate altitude (**Repo Daily Authoring Cost**) and treat per-Pull-Request cost as a best-effort detail, never a total.
_Avoid_: using individual commits as the primary authoring-cost unit when a Pull Request exists; presenting per-Pull-Request cost as a trustworthy total for orchestrated, multi-session work.

**Pull Request Link**:
An explicit link to a **Pull Request** in an **Agent Session** transcript. It is the v1 evidence Trace Flow trusts for **Pull Request Attribution** because it names both the code host repository and the pull request number.
_Avoid_: treating generic git commands, branch names, or bare numbers as Pull Request Links.

**Pull Request Authoring Cost**:
The estimated agent-analytics cost attributed to creating or modifying a pull request. Sums **Agent Session Authoring Cost** from local coding conversations attributed to that pull request; excludes runtime **LLM Request** cost from deployed application traffic, actual provider account spend, and inferred incremental cost caused by the change.
_Avoid_: "PR cost" without saying whether it means estimated authoring, runtime, actual spend, or incremental cost.

**Pull Request Attribution**:
A confidence-bearing association between **Agent Session Authoring Cost** and one primary **Pull Request** in the same **Repo**. In v1 it is made only from exactly one **Pull Request Link** for that Repo. Otherwise the cost remains repo-level. Cost is not split across multiple pull requests; if a session has credible evidence for more than one pull request, it remains unattributed at the Repo level.
_Avoid_: forcing every Agent Session into a Pull Request; splitting one Agent Session across several pull requests.

**Unattributed Repo Authoring Cost**:
Agent-analytics cost known to belong to a **Repo** but not confidently assigned to a **Pull Request**. Expected for exploratory work, detached worktrees, local-only branches, and sessions before a pull request exists.
_Avoid_: treating unattributed cost as an ingestion error.

**Project Claim**:
A user-declared, reversible association of a **Repo** (typically a **Provisional Repo**) to a **Project**. Identity is trustworthy only when it resolves to an unambiguous git remote; everything else stays **Unattributed** until a human asserts a Project Claim. A Claim is a rare, explicit, one-off act (not a heuristic), and it can be undone — a Repo can be unassociated or moved to a different Project. A Repo is atomic: a Claim attaches the whole Repo to one Project and never splits one Repo's cost across Projects. Claiming and unclaiming are bounded by **fact retention** — only days whose facts still exist (within the **EventAt** horizon) can be re-attributed; aged-out days are immutable.
_Avoid_: auto-merging Repos by fuzzy signals (path stem, repo name) without a Claim; splitting one Repo across Projects; expecting to re-attribute data whose facts have expired.

**Repo Daily Authoring Cost**:
The estimated **Agent Session Authoring Cost** for one **Repo** on one day, summed across all **Sources**. The honest aggregate grain for orchestrated workflows: it requires no per-**Pull Request** or per-ticket allocation, so it is unaffected by spend smeared across an orchestrator's many **Agent Sessions**. Where a **Source**'s cost is unreported (`cursor`), the day's cost is flagged incomplete and that Source's _activity_ (session, message, and **Tool Event** counts) is reported instead of a fabricated cost.
_Avoid_: presenting a day's cost as complete when a cost-unreported **Source** contributed; allocating a daily total down to individual **Pull Requests**.

**Delivery Signal**:
A per-**Repo**, per-day count of a delivery outcome pulled from an external issue/PR provider (e.g. GitHub Pull Requests merged or opened; Linear issues closed or moved). It is a count, not a cost, and carries no attribution to any **Agent Session**. Providers are interchangeable behind one count interface; a provider gap (API failure) is a visible missing day, never a silent zero.
_Avoid_: joining a Delivery Signal to individual **Agent Sessions** or **Pull Request Authoring Cost**; treating an absent provider response as zero delivery.

**Spend–Delivery Correlation**:
The side-by-side presentation of **Repo Daily Authoring Cost** and one or more **Delivery Signals** on a shared `(Repo or Project, day)` axis. It is a _correlation of parallel trends_ — two independent series the viewer compares — never a causal or per-artifact claim. Rolls up from **Repo** to **Project** via **Project Claims**; **Unattributed** Repos render on their own until claimed.
_Avoid_: stating or implying causation; allocating cost to the delivery artifacts it is shown beside; hiding the unattributed remainder.

**Provider Usage Snapshot**:
A point-in-time personal provider subscription, quota, credit, or rate-limit observation collected by **Trace Flow Desktop** through optional external tooling such as `codexbar` and uploaded with a **Collector Credential**. It is connected to a **User** inside an **Organization**, but not to a **Project**, **Repo**, **Agent Session**, or **Pull Request**. Provider account identity is grouped by a stable hash; human labels are redacted hints, such as `i***@zaks.io`, never full raw emails. Provider Usage Snapshots belong to the separate **Provider Usage Tracking** feature, not Collector v1.
_Avoid_: mixing with **Agent Message** token usage or **Pull Request Authoring Cost**; storing raw provider account emails as identity.

**Raw Transcript**:
The server-encrypted, lossless source content for one **Agent Session**, represented by stored **Archive JSONL** records and uploaded as versioned **Archive Observation JSONL** only by an explicitly enrolled Pro **Conversation Archive**. It includes the exact Source transcript records, Cursor row values, and subagent parts needed to replay that Agent Session, not unrelated Source store contents. It is the replay source for re-deriving facts server-side when the parser improves and the substrate for lossless export or future organization-owned model improvement. Trace Flow never stores Raw Transcripts for unenrolled Collectors or Hobby Organizations.
_Avoid_: "conversation dump"; not a fact table and not an **Agent Session**.

**Archive JSONL**:
The canonical lossless interchange format whose stored records wrap exact Source-native transcript payloads with their Source identity, provenance, content hash, and the Archive Session Ledger-assigned previous and current content-chain hashes. Its versioned Archive Observation JSONL upload shape carries the same Source payload and content hash without server-assigned chain fields; the ledger adds those fields after deduplication. Both shapes carry immutable archive and hash version discriminators, and stored records also carry hashed **Archive Scan Checkpoints**.
_Avoid_: a normalized training schema, model-specific chat templates, rewriting native payloads into a common message shape.

**Archive Scan Checkpoint**:
A deterministic Source observation submitted by a Collector and appended to the canonical content chain by the Archive Session Ledger. For append-oriented Claude and Codex JSONL, it proves the archived chain is complete through the recorded last-complete byte offset at that observation, not that the Agent Session can never append again. For mutable Cursor storage, it closes one consistently read, deterministically ordered snapshot of the selected `cursorDiskKV` records. Repeated observations of the same Source position and content deduplicate.
_Avoid_: "conversation closed", treating JSONL EOF as permanent, using Cursor bubble count or newest timestamp as archive-integrity proof.

**Archive Chunk**:
An immutable, losslessly compressed group of new **Archive JSONL** records from one **Archive Contribution** and **Agent Session**, encrypted as one R2 object. Its **Archive Session Manifest** maps each record's content hash to its chunk and byte range so export retains record-level identity without paying for one object operation per record.
_Avoid_: one R2 object per message, a mutable session bundle, packing records from multiple contributors together, treating the chunk as the canonical record identity.

**Archive Session Manifest**:
An ordered description of the **Archive JSONL** records and **Archive Scan Checkpoints** observed for one **Agent Session** at a point in time. It maps content-chain hashes to immutable chunk byte ranges so an export can verify payload integrity, ordering, and completed Source observations.
_Avoid_: copying shared record payloads into every session snapshot.

**Archive Session Ledger**:
The Archive API Durable Object keyed by Organization, Archive Contribution, Source, and Agent Session. It serializes concurrent Collector observations, verifies payload hashes and Source-specific scan checkpoints, deduplicates stable record identity plus content hash, assigns the canonical content-chain order and hashes, retains a changed same-identity Cursor value as a new observation, and acknowledges only after deterministic Archive Chunk and immutable Archive Session Manifest keys are durable. An integrity failure blocks only that session until operator repair verifies the existing chain and exact deterministic commit or pending batch, while preserving its last verified chain and any already-written suspect objects.
_Avoid_: using R2 listing as a transaction lock, query-time duplicate cleanup, one Organization-wide ledger.

**Archive Audit Event**:
An append-only Convex control-plane record of a semantic archive authorization, export, deletion, key rotation, integrity failure, or operator repair action and outcome. It records actor and target identifiers, server time, counts, and an applicable manifest root hash without transcript content, commands, decrypted payloads, absolute local paths, secrets, or one event per transferred chunk.
_Avoid_: treating the audit trail as proof against malicious Trace Flow operators, logging raw archive content, per-chunk access noise.

**Training Segment**:
A future derived sequence of **Archive JSONL** records matching the context actually visible to a model between Source compaction boundaries. Training Segment generation is not a v1 **Conversation Archive** output.
_Avoid_: flattening pre-compaction records and post-compaction responses into one fictional context.

**Conversation Archive**:
An **Organization**-owned Pro capability and opt-in corpus of lossless **Raw Transcripts** kept under **Paid Archive Retention** for that Organization's future reuse, including possible personal model improvement. Pro includes 100 GB of fixed archive capacity; v1 has no separate archive purchase or capacity upgrade. The first release stores and processes archive content through the Cloudflare R2 `us` jurisdiction and offers no region selector.
_Avoid_: "training corpus" (archive enrollment does not authorize training; a later Organization-specific training feature requires separate authorization), "permanent storage".

**Archive Encryption Key**:
A versioned, server-managed encryption key owned by one **Organization** and used only for that Organization's **Conversation Archive**.
_Avoid_: the shared Body Object root key, a user-held zero-knowledge key.

**Archive Contribution**:
The **Raw Transcripts** one **User** contributes to an Organization's **Conversation Archive**, maintained separately so that User can view its status and control future collection. Removing the User revokes future collection and purges that User's unacknowledged Desktop spool on its next connection, but acknowledged records remain Organization-owned until the Archive Steward deletes the contribution or archive.
_Avoid_: treating the archive as an unattributed organization-wide blob, sharing physical chunks across contributors.

**Archive Activation**:
The explicit **Archive Steward** action that enables a Pro Organization's **Conversation Archive** to receive contributions. In the primary-owner Desktop flow, **Enable Conversation Archive** creates this Organization authorization before enrolling that Desktop.
_Avoid_: treating Organization approval as permission to collect from a User's machine.

**Collector Enrollment**:
The explicit **User** action that authorizes one of that User's **Collectors** and named archive Source types to contribute ongoing **Raw Transcript** sync and chooses whether to start with new conversations or import all currently available history. Starting with new conversations permanently excludes every Agent Session present in the Collector's pre-capture baseline, even when it receives later records; a later-discovered session with pre-enrollment or ambiguous history is excluded too. All-history enrollment protects newly created conversations first, then backfills baseline sessions from most recently active to oldest while preserving Source order within each session, and remains incomplete until every eligible session checkpoint is durably acknowledged. A newly supported Source is off until the User explicitly adds it and chooses that Source's history boundary. For the owner, enrollment is the second step of **Enable Conversation Archive**. After Archive Activation, any current Organization member may use **Contribute this computer** for their own Collector without another owner-approval step. Unenrollment or owner revocation permits no final upload and purges the enrollment's unacknowledged spool and local progress when Desktop learns of it; resuming requires a new enrollment and history choice.
_Avoid_: silently enrolling a Collector during normal setup, "raw upload toggle".

**Archive Spool**:
The fixed 2 GB, encrypted local queue where one enrolled **Collector** keeps versioned **Archive Observation JSONL** until the **Archive API** acknowledges durable storage. At the limit, archive collection pauses loudly while parsed fact sync continues; the Collector never evicts pending records.
_Avoid_: advancing archive progress before acknowledgement, using the spool for parsed analytics facts.

**Archive Steward**:
The owning Organization's owner, who can access, administer, delete, and export every **Archive Contribution** in its **Conversation Archive**.
_Avoid_: granting archive-wide access or export authority to ordinary Organization members.

**Archive Export**:
An owner-only, resumable Trace Flow Desktop operation that reconstructs a chosen local directory containing a top-level archive manifest plus per-session **Archive JSONL** and **Archive Session Manifests**. It verifies each Agent Session while writing, is directly consumable by local tools or a future investigation harness, and does not create a ZIP or second server-side archive object. A failed session remains identified in the top-level manifest and makes the export incomplete rather than being silently skipped. It is distinct from the sanitized diagnostics export.
_Avoid_: browser-generating one large download, persisting a normalized training dataset, using a **Collector Credential** as archive-read authority.

**Archive Export Grant**:
A short-lived, single-export authorization minted only after an interactive **Archive Steward** sign-in. It is scoped to one **Organization** and one **Archive Export**, authorizes read-only archive reconstruction, and cannot enroll a Collector or upload data.
_Avoid_: reusing a long-lived **Collector Credential**, a reusable archive API key, granting ordinary Organization members export access.

**Archive Status**:
The server-backed Conversation Archive state projected into Convex and shown persistently on `/app/agents`: `not_enabled`, `active`, `blocked`, `frozen`, or `deleting`. It includes stored bytes against 100 GB, the last durable Archive API acknowledgement, enrolled contributor and Collector counts, the latest Collector-reported pending spool bytes or error, and the Pro grace deadline when frozen.
_Avoid_: showing "enabled" without proof of a successful durable write, treating stale Collector-reported spool state as current server truth.

**StartedAt**:
The earliest point of an **Agent Session** that Trace Flow can observe from conversation-turn records. Deliberately "first activity we can see," distinct from the **Source**'s own declared session start. It is session metadata, not the retention or partitioning key.
_Avoid_: "session start" (the Source's claim — that's **VendorStartedAt**), "ingest time", using it as the TTL anchor.

**EventAt**:
The timestamp of a specific **Agent Message**, **Tool Event**, file event, **Capability Snapshot**, or **Pull Request Link** fact. Agent fact tables partition and expire by EventAt so old long-lived sessions can still retain recent work.
_Avoid_: using **StartedAt** when deciding whether a fact row is inside the retained window.

**LastEventAt**:
The newest **EventAt** observed for an **Agent Session**. Used for **Agent Session** summary retention.
_Avoid_: treating it as Source-declared metadata; it is derived from observed facts.

**VendorStartedAt**:
The session-start time a **Source** declares for itself, captured as metadata when the Source provides it (Codex does; Claude, with a UUIDv4 session id, does not). Never used as the retention anchor.
_Avoid_: conflating with **StartedAt**.

### Local agent monitoring

**Supervisor**:
The local component that watches **Transcript Files** as they are written and reports live **Agent Session** state, distinct from the **Collector** even though both read the same files and both ship inside **Trace Flow Desktop**. It never uploads facts and never advances the Collector's cursors, so a Supervisor failure cannot stop fact sync and a sync failure cannot blind the live view.
_Avoid_: "daemon", "watcher" (that is the Supervisor's filesystem mechanism, not the component), folding it into the **Collector**.

**Transcript File**:
The on-disk artifact a **Source** appends as an **Agent Session** proceeds — a `.jsonl` file for `claude` and `codex`, and no such file for `cursor`, whose records live in a SQLite store. It is the machine-local input both the **Collector** and the **Supervisor** read.
_Avoid_: bare "transcript" (ambiguous with **Raw Transcript**), "log", "conversation file".

**Checkout**:
One on-disk working copy of a **Repo**, named by the `worktreeName` slug the **Source** records rather than derived from a path. The unit that makes concurrent local agents distinguishable, because **Repo** deliberately collapses every worktree of one remote into a single identity.
_Avoid_: treating a Checkout as a **Repo** or a **Provisional Repo**; using it as a fact-table grain (nothing downstream keys on it); reconstructing it from `cwd` when the Source states it directly.

**Session Liveness**:
The **Supervisor**'s deterministic read of what an **Agent Session** is doing right now, derived only from where the newest **Transcript File** records sit relative to the last completed turn. One of **Working**, **Idle**, or **Stalled**.
_Avoid_: inferring liveness from the agent's process, from cost, or from message content.

**Working**:
The **Session Liveness** state where the **Agent Session** has produced records since its last completed turn. The agent is mid-turn and progressing.
_Avoid_: "running" (every session on the board is running), treating a long turn as abnormal — legitimate turns run many minutes.

**Idle**:
The **Session Liveness** state where the **Agent Session**'s newest activity is its last completed turn. It deliberately merges "finished the work" and "stopped to ask a question", because both mean the same thing to someone supervising many agents: this one needs a human.
_Avoid_: reading Idle as "done"; splitting it into done-versus-asking, which is not deterministically knowable from the **Transcript File**.

**Stalled**:
The **Session Liveness** state where an **Agent Session** is mid-turn but has written nothing for longer than the stall threshold. The only alerting liveness state.
_Avoid_: "hung" or "crashed" (the Supervisor observes silence, not process death); confusing with **Idle**, which is a normal resting state.

## Relationships

- A **Client** calls the **Proxy**, which forwards to a **Provider** matched by **Route**.
- The **Proxy** writes one durable **Trace Delivery Envelope** and publishes a reference for each
  accepted **LLM Request** or OTLP export.
- The **Proxy Consumer** loads referenced envelopes, copies canonical **Body Objects**, builds
  **Spans**, and hands them to a **Trace Shard** before completing the envelope.
- A **Trace Shard** flushes accumulated **Spans** into the `otel_trace_spans` **Datasource**.
- The **Web** app reads **Spans** through Tinybird **Pipes** via the **Pipes API Worker** (using a **Pipe Token**) and fetches **Body Objects** through the **Raw API Worker**.
- **Trace Flow Analyst** conversations happen in the **Analyst Sidebar** and are represented by creator-private **Analyst Threads**, which use the **Analyst Runtime** to answer user questions through approved **Analyst Tools**.
- **Context Selection Mode** adds one or more **Page Context References** to the next **Analyst Thread** message.
- The **Collector** parses local **Source** transcripts into agent facts and uploads them to **Agent Ingest** with a **Collector Credential**.
- **Agent Ingest** validates the upload, claims **Agent Session** ownership through Convex, and sends agent fact messages to the agent queue.
- **Agent Consumer** prices, dedupes, and writes agent facts to `agent_*` **Datasources** for `/app/agents`.
- An enrolled **Collector** uploads versioned **Archive Observation JSONL** to the **Archive API**, which owns chain assignment, encryption, archive-capacity reservation, R2 persistence, and durable acknowledgement; **Agent Ingest** never carries transcript content.
- An **Organization** owns its user-facing **API Keys** and hidden **Collector Credentials**, and has exactly one **Subscription Tier**; the Tier determines the **Retention Window** stamped onto each **Span**.
- An **Organization** may own one **Conversation Archive**, which contains many **Raw Transcripts**.
- A **Conversation Archive** contains one **Archive Contribution** per contributing **User**; the **Archive Steward** can access and export all contributions while ordinary members can see status only for their own.
- A contributing **User** controls future collection through their **Collectors**; only the **Archive Steward** can delete or export already-archived data.
- In v1, the **Archive Steward** may delete one complete **Archive Contribution** or the entire **Conversation Archive**, but not an individual **Agent Session**.
- Deleting an **Archive Contribution** first revokes every **Collector Enrollment** contributing to it, then deletes its contribution-scoped session ledgers, chunks, and manifests so the same Collector cannot immediately restore the deleted data.
- Removing a contributing **User** from an **Organization** stops future archive sync but leaves their existing **Archive Contribution** in the Organization's **Conversation Archive**.
- **Archive Activation** must occur before any **Collector Enrollment** in an **Organization**.
- Every **Collector** requires its own **Collector Enrollment** before it uploads **Raw Transcripts** to a **Conversation Archive**.
- The Pro owner's **Enable Conversation Archive** Desktop flow creates **Archive Activation**, enrolls that Desktop, asks whether to start with new conversations or import all currently available history, and then starts ongoing archive sync.
- After **Archive Activation**, another member's Desktop offers **Contribute this computer** and records only that User's per-Collector consent and history-import choice.
- An enrolled **Collector** removes **Archive Observation JSONL** from its **Archive Spool** only after the **Conversation Archive** acknowledges durable storage.
- Each enrolled **Collector** has a fixed 2 GB **Archive Spool**; reaching it pauses archive collection with an action-required error while parsed fact sync continues.
- When an **Organization** exhausts its archive capacity, its **Collectors** retain pending **Archive Observation JSONL** in their **Archive Spools** until capacity returns; neither the Collector nor archive silently drops or automatically evicts conversations.
- Pro includes one **Conversation Archive** with its own fixed 100 GB capacity; proxy Body Object usage cannot consume that capacity, and v1 has no separate archive purchase or additional archive capacity.
- Losing Pro stops new archive collection and starts a 90-day frozen grace period for owner export or restoring Pro; grace expiry destroys its **Archive Encryption Keys** before R2 object deletion.
- During the Pro grace period, enrolled **Collectors** stop new archive scans but keep pending encrypted **Archive Spool** data; restoring Pro resumes upload, while terminal grace expiry causes the next connected Collector to purge its spool and enrollment state.
- A **Conversation Archive** preserves **Raw Transcripts** losslessly and v1 exports that same lossless representation; sanitization and normalization belong only to future derived exporters.
- An **Archive Steward** runs an **Archive Export** through Trace Flow Desktop; the export resumes at archive-chunk boundaries and writes directly to a chosen local directory without creating a server-side export copy.
- An **Archive Export** requires a fresh **Archive Export Grant**; **Collector Credentials** remain upload-only and never authorize archive reads.
- `/app/agents` shows persistent **Archive Status**, including server-authoritative integrity failures and repair outcomes per affected session without transcript content. The **Archive Steward** sees Organization totals and all contributors; an ordinary member sees only their own contribution and enrolled Collectors.
- A **Raw Transcript** comprises Source-native **Archive JSONL** records ordered by one or more **Archive Session Manifests** and physically packed into immutable **Archive Chunks**.
- Within one **Archive Contribution**, identical **Archive JSONL** payloads share one content identity, while distinct Source record identities remain distinct even when their payloads match. v1 does not physically deduplicate across contributors.
- The **Archive API** routes every session upload through its **Archive Session Ledger**; a lost response or repeated scan reuses deterministic object keys and returns the prior acknowledgement instead of duplicating storage.
- An **Organization** owns one active **Archive Encryption Key** version and may retain older versions only while archive objects still require them.
- A future training exporter would split an **Agent Session** into context-faithful **Training Segments** at Source compaction boundaries; v1 does not generate training datasets or run fine-tuning.
- A **Pipe Token** is scoped to an **Organization**'s **API Keys** and **Retention Window**.
- Agent-analytics reads are scoped by **Organization** and do not use user-facing **API Keys** as identity; the separate **Provider Usage Tracking** feature adds **User** scope for user-private **Provider Usage Snapshots**.
- **Context Bloat** consumes part of an **Agent Session**'s working context and can increase **Context Rot Exposure**, but it is not the same signal.

## Example dialogue

> **Dev:** "When the Proxy captures a streaming response, what is durable before the Queue Message is sent?"
> **Domain expert:** "The Proxy stores a Trace Delivery Envelope in R2 before the response reaches
> terminal EOF. The queue carries only its reference. Proxy Consumer reads that envelope, copies the
> encrypted Body Object to `bodies/{requestId}`, durably stages the spans, then removes the envelope."
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
- **"agent"** was used for both collected coding-agent activity and the new conversational analysis product. _Resolved_: the product is **Trace Flow Analyst**; its backend execution boundary is the **Analyst Runtime**.
- **"MCP Tool"** was used to mean both a shared implementation and its MCP exposure. _Resolved_: the implementation is a **Trace Flow Tool**; **MCP Tool** and **Analyst Tool** are surface-specific exposures.
- **"thread"** was used for both product-owned Analyst conversation history and runtime-managed message storage. _Resolved_: **Analyst Thread** is the Trace Flow-owned conversation record.
- **"highlight boxes"** was used for Analyst-aware page selection. _Resolved_: use **Context Selection Mode** for the mode and **Page Context Reference** for each selected object.
- **"session start"** conflated the time we can first observe with the time a Source declares. _Resolved_: **StartedAt** is the earliest observed turn; **EventAt** is the fact retention and partition anchor; **LastEventAt** anchors session-summary retention; **VendorStartedAt** is the Source's own declared start, captured as metadata where available.
- **"transcript"** was used for both the local `.jsonl` file on disk and the server-encrypted archive artifact, which differ only by the word "Raw". _Resolved_: the machine-local artifact is a **Transcript File**; the server-side lossless archive artifact stays **Raw Transcript**. The code's bare `walk_transcripts` / "transcript root" naming predates this and refers to Transcript Files.
- **"worktree"** — the live monitoring board must distinguish ~20 concurrent agents running in separate worktrees of the same repository, but **Repo** normalizes to the git remote so every one of them collapses to a single `repo_fingerprint`. _Resolved_: the on-disk working copy is a **Checkout**, a display-and-grouping label only. **Repo** keeps its collapsing behavior and stays the fact-table grain.
- **"dev"** meant three different things: (a) a Worker named `*-dev`, (b) the everyday "local Workers → cloud data" setup a developer runs, and (c) the fully local no-cloud stack the setup scripts provision by default. This directly caused a developer and an agent to expect data in different places. _Resolved_: a `*-dev` Worker is just the default **Local Workers** config, not a cloud environment; "where my data ends up" for daily development is **Cloud-Dev**; the scripted default is **Self-Contained Local** (for Cursor/CI). Always name which of **Control Plane** / **Data Plane** points at cloud vs local rather than saying "dev" unqualified.
