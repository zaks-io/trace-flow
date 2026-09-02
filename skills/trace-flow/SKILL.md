---
name: trace-flow
description: Route an app's LLM calls through the Trace Flow gateway and read the captured traces, spans, cost/latency rollups, and agent analytics through the Trace Flow MCP server. Use when adding LLM observability to a repo, debugging a failed or slow LLM call, chasing a token or cost spike, or attributing spend to a workflow, model, or user.
---

# Trace Flow

Trace Flow captures LLM traffic at a gateway and serves it back over MCP. Two halves:

- **Write:** point the app at `https://gateway.trace-flow.dev/{provider}`. The gateway streams the response through untouched and captures bodies, tokens, timing, cost, and errors out of band.
- **Read:** `https://mcp.trace-flow.dev/mcp` exposes traces, spans, events, usage rollups, and agent analytics as tools.

API keys: <https://trace-flow.dev/app/api-keys>. Docs: `/docs/quick-start`, `/docs/sdk-reference`, `/docs/opentelemetry`, `/docs/mcp` on <https://trace-flow.dev>.

## Instrument an app

Three edits. Keep the upstream provider key exactly as the app already configures it; Trace Flow is additive.

1. Add `TRACE_FLOW_API_KEY` to the env file the app already uses (`.env`, `.env.local`, `.dev.vars`).
2. Swap the provider base URL for the gateway path.
3. Send `X-Trace-Flow-Api-Key` as a header.

```typescript
import { createOpenAI } from '@ai-sdk/openai';

const openai = createOpenAI({
  baseURL: 'https://gateway.trace-flow.dev/openai/v1',
  apiKey: process.env.OPENAI_API_KEY,
  headers: { 'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY },
});
```

| Provider   | Gateway path       | Proxies to                            |
| ---------- | ------------------ | ------------------------------------- |
| OpenAI     | `/openai/v1/*`     | `api.openai.com/v1/*`                 |
| Anthropic  | `/anthropic/v1/*`  | `api.anthropic.com/v1/*`              |
| Google     | `/google/v1beta/*` | `generativelanguage.googleapis.com/*` |
| OpenRouter | `/openrouter/v1/*` | `openrouter.ai/api/v1/*`              |
| Groq       | `/groq/v1/*`       | `api.groq.com/openai/v1/*`            |

Everything after `/{provider}` is forwarded verbatim, so any endpoint the provider serves works, streaming included. Native SDKs work the same way: set the SDK's base URL and default headers.

If the repo has an `.mcp.json` or equivalent, merge the `trace-flow` server in; never rewrite the file.

## Trace context

Traces are only as good as the IDs. Send W3C headers on each call:

```typescript
headers: {
  traceparent: `00-${traceId}-${newSpanId()}-01`,
  baggage: 'operation=chat,user_id=user_123',
}
```

- One `trace-id` per user request or turn; reuse it for every LLM call in that turn.
- A **new** `span-id` for every call. Reusing one overwrites the earlier span.
- Never mint a fresh trace id per LLM call inside one workflow, and never reuse one across unrelated requests.
- With OpenTelemetry already in the app, use `propagation.inject(context.active(), headers)` instead of building the string.

Baggage keys `operation` and `user_id` are the indexed ones: `operation` is the workflow label you filter and group by in every rollup tool, `user_id` drives unique-user metrics. Other keys are stored on the root span as `baggage.*` and readable via `get_trace_spans` with `expand: ["baggage"]`, but they are not filterable.

## Verify before claiming it works

Send one real request and read the response headers:

- `X-Trace-Flow-Recording: true` — captured.
- `X-Trace-Flow-Recording: false` — the key was valid but nothing was recorded. `X-Trace-Flow-Recording-Reason` says why: `suspended`, `canceled`, `no_subscription`, `exceeded` (with `X-Trace-Flow-Period-Reset`), or `internal_error`. That is a billing or plan problem, not a wiring problem; retrying will not help.

Then confirm the read path: `list_trace_summaries` with `hours: 1` should show the request.

## Other write-path controls

- `X-Trace-Flow-Omit-Body: true` — per-request privacy. Tokens, timing, cost, and errors are still captured; request and response bodies are not stored.
- Custom spans: `POST https://gateway.trace-flow.dev/v1/traces` accepts OTLP/HTTP (JSON or protobuf, gzip/deflate) with the same `X-Trace-Flow-Api-Key` header. Point an `OTLPTraceExporter` at it to land your own spans in the same trace tree as the LLM calls.

## Read data over MCP

```json
{
  "mcpServers": {
    "trace-flow": {
      "type": "http",
      "url": "https://mcp.trace-flow.dev/mcp"
    }
  }
}
```

First use triggers OAuth against the user's Trace Flow account; tokens refresh after that. Every tool is scoped to that account's organization.

| Question                       | Tool                                                         |
| ------------------------------ | ------------------------------------------------------------ |
| Which apps/keys can I see?     | `list_api_keys` (IDs feed `api_key_ids` on every other tool) |
| What ran recently?             | `list_trace_summaries` (one row per trace)                   |
| Row-level model-call index     | `list_traces`                                                |
| One trace, whole shape         | `get_trace`                                                  |
| Which step was slow or failed? | `get_trace_spans`                                            |
| Message/tool-call sequencing   | `get_trace_events`                                           |
| Cost, latency, error KPIs      | `get_usage_summary`                                          |
| Most expensive workflow        | `list_operation_usage`                                       |
| Model comparison               | `list_model_usage`                                           |

Rules that save wasted calls:

- **Aggregate tools over summing rows.** `get_usage_summary`, `list_operation_usage`, and `list_model_usage` are correct by construction; adding up `list_traces` rows is not.
- **`list_traces` is span-level.** The same `trace_id` appears once per model call. Use `list_trace_summaries` for one row per trace, or `trace_id` on it for an exact lookup that bypasses other filters.
- **`get_trace`'s top-level `duration_ms` is end-to-end wall time**; `summary.totals.duration_ms` is summed span time and runs higher when calls are parallel. Do not report them as the same number.
- **Empty results usually mean wrong scope or window**, not missing data. Check `list_api_keys`, then widen `hours`.
- **Filter server-side** with `provider`, `model`, `operation`, `status`, then sort with `sort_by: "cost_usd" | "duration_ms" | "tokens"` instead of pulling rows and sorting locally.
- **`get_trace_spans` returns a lean base shape.** Ask for what you need via `expand` (`provider`, `model`, `tokens`, `costs`, `ttft`, `parent`, `url`, `http`, `status_message`, `baggage`, `operation`) and filter with `span_names` (trailing `*` prefixes like `chat *` work), `min_duration_ms`, or `top_n`.
- **`get_trace_events` never returns prompt or response bodies** — role, message index, content type, tool name, and tool id only. For bodies, open the trace in the dashboard.
- Everything paginates by `cursor`; follow it rather than raising `limit` past its cap.

## Agent analytics

If the org runs the Trace Flow collector, coding-agent conversations (Claude, Codex, Cursor) are queryable too.

Call `describe_agent_analytics` first. It returns the allowed views, filter keys, view-specific parameters, and the org's actual `sources`, `models`, and `repo_fingerprints` for the window. Repo fingerprints are opaque hashes, so guessing them is wasted effort.

Then `query_agent_analytics` with a `view`:

`summary` (KPI row) · `timeseries` (`group_by`, `granularity`) · `breakdown` (`dimension`, `order_by`) · `context_health` (context pressure vs `attention_threshold_tokens`, default 140000) · `tool_failures` (`min_events`) · `tool_deltas` (period over period) · `projects` (repo fingerprints for filtering) · `review_units` (PR/MR cost estimate, only when a transcript links exactly one same-repo review).

Windows accept `hours`, or explicit `start_time`/`end_time` (ISO) or `start_time_ms`/`end_time_ms`.

## Recipes

- **A call failed.** `list_trace_summaries` with `status: "STATUS_CODE_ERROR"`, `hours: 1` → `get_trace_spans` on the top hit with `expand: ["status_message", "http", "url", "provider", "model"]`.
- **Costs jumped.** `get_usage_summary` for the window → `list_operation_usage` to find the workflow → `list_model_usage` to see whether a model changed → `list_trace_summaries` with `sort_by: "cost_usd"` for the worst offenders.
- **It got slow.** `list_model_usage` for p95 by model → `list_trace_summaries` with `sort_by: "duration_ms"` → `get_trace_spans` with `top_n` and `sort_by: "duration_ms"` to find the step.
- **Tool loop misbehaving.** `get_trace_events` filtered to `input.tool_use` and `input.tool_result` to check ordering.
- **Agent spend by project.** `query_agent_analytics` `view: "projects"` → `view: "summary"` or `view: "breakdown"` filtered to that `repo_fingerprint`.
