---
name: trace-flow-observability
description: Loads project context (Worker names, KV/R2/queue IDs, Tinybird datasources, Axiom dataset, MCP servers) for investigating Trace Flow production and dev systems. Use when debugging a prod issue, querying logs or metrics, inspecting a trace, checking deploys, or needing any service ID for this monorepo. Triggers include "check sentry", "axiom logs", "what's the dataset", "look at the trace", "production issue", "queue stuck", "consumer error", "tinybird query", "cf worker logs".
---

# Trace Flow Observability Context

Reference for investigating Trace Flow systems. All four workers run on Cloudflare; traces land in Tinybird; logs in Axiom; errors in Sentry; live trace data via the Trace Flow MCP.

## Quick IDs

- Cloudflare account: `a461d640900eb3905d7b6619c8c0da91` (Isaac@zaks.io's Account)
- Sentry org slug: `zaksio` | regionUrl: `https://us.sentry.io` | project slug: `trace-flow`
- Axiom dataset: `cloudflare` (workers ingest here; sibling datasets `convex`, `vercel`, `fly-io` exist for other systems)
- Tinybird host: `https://api.us-west-2.aws.tinybird.co`

## Workers (Cloudflare)

Four workers, three environments each (`dev`, `preview`, `production`). Names follow `trace-flow-<role>[-<env>]`.

| Role     | Prod name (worker tag)                                     | Dev name (tag)                                                 | Preview name (tag)                                                 | Routes / domain                        |
| -------- | ---------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| Proxy    | `trace-flow-proxy` (`851c8b5cb6e9414f9a40c9c4d7563241`)    | `trace-flow-proxy-dev` (`c2dcbee4c3ed4a68a08dbd9627f93e10`)    | `trace-flow-proxy-preview` (`b38b99a10a424d2c95b7018c34ff9d2b`)    | `gateway.trace-flow.dev/*`             |
| Consumer | `trace-flow-consumer` (`bd6990f8779c4b08a13d09891ddec100`) | `trace-flow-consumer-dev` (`586d2324fac9438dae024d1e8a809ad7`) | `trace-flow-consumer-preview` (`17184c68ab07464bbad12d05eeb3c23d`) | (queue + cron, no public route)        |
| API      | `trace-flow-api` (`e2506f205a4948aeb8a4d112b7c86679`)      | `trace-flow-api-dev` (`2b791615e88d4de994c19e5bd9ca1668`)      | `trace-flow-api-preview` (`08e5e21f11d5441184a5d6d5c53393e7`)      | `api.trace-flow.dev/*`                 |
| Web      | `trace-flow-web` (`9043998632db45a29bd6f93524a65bcf`)      | `trace-flow-web-dev` (`e580dd1223134b04a08ab84f1c0e6a66`)      | (n/a)                                                              | `trace-flow.dev` (OpenNext on Workers) |

Public surfaces: `https://gateway.trace-flow.dev` (proxy), `https://api.trace-flow.dev` (API), `https://trace-flow.dev` (web), `https://mcp.trace-flow.dev/mcp` (MCP).

## Cloudflare resource IDs

KV namespaces:

| Binding         | Prod ID (title)                                                 | Dev/Preview ID (title)                                         |
| --------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| `API_KEYS`      | `f004c21e2b8c4754af5947c08069bd00` (`trace-flow-api-keys-prod`) | `30c9a31ff3af4b408b4d64b8ecfa98a5` (`trace-flow-api-keys-dev`) |
| `MODEL_PRICING` | `45dd0d5e619d44fc831ccab01ed428a4` (`production-MODEL_PRICING`) | `25a35f71a8d64884a8e8935056880dba` (`MODEL_PRICING`)           |

R2 buckets: `trace-flow-storage-prod`, `trace-flow-storage-dev`. Object key format: `bodies/${requestId}` (single object holds request + response).

Queues: `trace-flow-requests-{prod,dev,preview}` with DLQs `trace-flow-requests-dlq-{prod,dev,preview}`.

Durable Objects: `UsageTracker` (USAGE_TRACKER, in proxy), `TraceBatcher` (TRACE_BATCHER, in consumer).

Analytics Engine datasets: `trace-flow-proxy`, `trace-flow-proxy-dev`, `trace-flow-consumer`, `trace-flow-consumer-dev`.

Cron: consumer runs `*/5 * * * *` to flush stale TraceBatcher shards.

## Tinybird

- Host: `https://api.us-west-2.aws.tinybird.co`
- Datasources (in `datasources/`): `otel_traces`, `otel_traces_genai`, `llm_requests`, `llm_usage_1h`, `llm_usage_1d`, `llm_usage_1mo`
- Pipes (in `pipes/`): `mcp_*` for MCP-fronted reads, `llm_usage_*` for dashboard usage queries, `llm_request_stats`, `filter_options`, `llm_cost_*`
- Auth: frontend gets short-lived JWT from Convex (`api.tinybird.generateToken`), 10 min TTL, includes `fixed_params` (api_keys, retention_days). Admin token never reaches the browser.

## Axiom

- Worker dataset: `cloudflare` (set as `AXIOM_DATASET` in every wrangler env). All four workers ingest via `AXIOM_TOKEN` secret.
- Sibling datasets in this account: `convex` (Convex function logs), `vercel`, `fly-io`.
- **Field gotcha (verified):** `service` is the runtime label and equals `"cloudflare-worker"` for every worker. The actual worker identity lives in **`runtime`** (e.g. `runtime == "proxy-consumer"`, `"proxy"`, `"api"`, `"web"`). Filtering on `service == "trace-flow-..."` returns nothing.
- `event` carries structured event names (e.g. `consumer.trace_batcher_unhealthy`, `consumer.flush_complete`). great for `summarize count() by event`.
- Useful real fields: `level`, `event`, `component`, `request_id`, `trace_id`, `parent_span_id`, `org_id`, `user_id`, `provider`, `operation`, `route`, `method`, `error_name`, `error_message`, `error_stack`, `cf_ray`, `convex_function`, plus typed `data.*` fields (`data.latencyMs`, `data.status`, `data.batchSize`, `data.shardId`, `data.queuedTraces`, `data.unhealthyShards`, `data.checkedShards`, `data.lastSuccessfulFlushAgeMs`, `data.totalTokens`, `data.r2Stored`, `data.requestId`, ...).

## Sentry

- Org slug: `zaksio` | regionUrl: `https://us.sentry.io` | dashboard: `https://zaksio.sentry.io`
- Project slug: `trace-flow` (single project covers all four workers + web)
- Sibling projects in same org: `apictx`, `medical-mcp`, `neuron-app`, `news`, `otto`, `panda-pet`, `scrape`, `time`
- Env: `SENTRY_ENVIRONMENT` = `development` | `preview` | `production`. Workers send via `env.SENTRY_DSN`; web via `NEXT_PUBLIC_SENTRY_DSN`.

## Convex

- Functions in `packages/convex` (per `convex.json`). Web requires `bunx convex dev` running locally.
- Convex actions sign Tinybird JWTs (`api.tinybird.generateToken`) and proxy auth.

## MCPs to use

The four MCPs that matter for this project, ranked by frequency of use:

### 1. Axiom: logs and queries (`mcp__claude_ai_Axiom__*`)

The workhorse for "what happened in production." All worker logs (proxy, consumer, api, web) land in dataset `cloudflare`.

- `queryDataset`: APL queries (KQL-style). Default workhorse.
- `getDatasetFields`: get the schema before guessing field names.
- `getSavedQueries`: check for shared/starred queries first (currently empty for this account).
- `listMetrics`, `queryMetrics`: only for `otel-metrics-v1` datasets (none configured here today; `cloudflare` is `events` kind).
- `listDashboards`, `getDashboard`: useful when a teammate has a dashboard you can read instead of re-deriving.

### 2. Cloudflare Developer Platform (`mcp__claude_ai_Cloudflare_Developer_Platform__*`)

For "is this actually deployed?" and infra inspection.

- `workers_get_worker`: deploy state, bindings, last modified.
- `workers_get_worker_code`: the real (bundled) source running in prod. Use this to confirm a fix is live, not just merged.
- `workers_list`, `accounts_list`, `set_active_account`: discovery + auth.
- `kv_namespaces_list`, `kv_namespace_get`: KV inventory and config.
- `r2_buckets_list`, `r2_bucket_get`: R2 inventory.
- `d1_database_query`: only if D1 ever gets added (none in this project today).
- `search_cloudflare_documentation`: first stop for CF Workers behavior questions.

### 3. Sentry (`mcp__claude_ai_Sentry__*`)

For exception triage. The trace-flow project covers all four workers + web.

- `search_issues`: natural-language LIST of grouped issues. "what's broken?"
- `search_events`: natural-language COUNTS or individual events. "how many ... " or "show me the events from..."
- `search_issue_events`: drill into one issue (filter by env, release, trace, user).
- `get_issue_tag_values`: tag distribution for a single issue (e.g. which routes/users are affected).
- `get_sentry_resource`: when given a Sentry URL, fetch the full resource directly.
- `find_releases`: confirm which release introduced a regression.

### 4. Trace Flow MCP for LLM trace data (`mcp__trace-flow-prod__*`)

The only way to read trace data without a Tinybird JWT. Scoped to the API keys the MCP authenticated against, so empty results often mean "wrong scope," not "no data." Run `list_api_keys` first.

- `list_trace_summaries`: one row per trace_id (preferred for "show me recent traces").
- `list_traces`: span-level rows; the same trace_id can appear multiple times.
- `get_trace`, `get_trace_spans`, `get_trace_events`: single-trace deep dive.
- `get_usage_summary`, `list_model_usage`, `list_operation_usage`: cost/latency/token rollups.
- `list_api_keys`: discover scope.
- `mcp__trace-flow-dev__*` exists as a parallel MCP for dev environment; requires `authenticate` first.

## Best practices (from probing the MCPs)

### Axiom (APL)

- **Discover schema before querying.** Run `['cloudflare'] | take 1` against your time window first. The tool returns every populated field for that row, which is faster than `getDatasetFields` and shows you which fields actually have data right now.
- **Filter by `runtime`, not `service`.** `service == "cloudflare-worker"` for every Worker; the role is in `runtime` (`proxy`, `proxy-consumer`, `api`, `web`).
- **Always restrict time.** Default `now-30m` is fine for live debugging; widen explicitly with `startTime: "now-24h"`. The 65k row cap is a query failure mode, not just a truncation.
- **Aggregate, don't dump.** `summarize count() by event, runtime` over `take 100` for trends. Reserve `take` for schema discovery and single-trace inspection.
- **Project narrowly.** `| project _time, runtime, event, level, error_message` keeps responses readable; otherwise rows include 80+ columns.
- **Bracket fields with dots.** `['data.latencyMs']` or just unquoted `data.latencyMs` (both work); special-char fields (e.g. `data.firstSpanAttributes.agent\.id`) need brackets.
- **Time math:** `bin(_time, 5m)` for histograms; `ago(2h)` for relative ranges.

### Cloudflare

- **Call `set_active_account` once per session.** Active account ID for this user: `a461d640900eb3905d7b6619c8c0da91`. Without it, account-scoped tools fail.
- **Use `workers_get_worker_code` to verify deploys.** A merged commit isn't a live fix until `wrangler deploy` ran. The bundled code is what the edge serves.
- **Don't mutate KV/R2 from MCP.** Reads and metadata are fine; writes (delete bucket, edit KV value) are easy to misfire and there's no undo.
- **Scope by name.** This account holds 25+ workers (`apictx-*`, `neuron-*`, `synet-*`, `otto-*`, ...). Always filter `workers_list` results by `trace-flow-` prefix in your head.

### Sentry

- **Pass `regionUrl: "https://us.sentry.io"` on every call.** The org is on US region; omitting it sometimes routes wrong.
- **Use `org/project` shorthand.** `search_events` and `search_issues` accept `organizationSlug: "zaksio"` + `projectSlug: "trace-flow"` directly without prior `find_*` lookups.
- **`search_issues` vs `search_events`:** Issues = grouped problems (lists). Events = counts, sums, or raw event timelines. Picking the wrong one returns confusing or empty results.
- **Natural language is LLM-translated.** Concrete phrasing wins: "unresolved errors in production from last 24 hours" beats "show me errors". Pass `includeExplanation: true` once when a query returns unexpected results to see how it parsed.

### Trace Flow MCP

- **Top-level `duration_ms` ≠ `summary.totals.duration_ms`.** Top-level is end-to-end wall time. `summary.totals` is summed span time across the trace (often higher when spans run in parallel). Documented in `get_trace`, easy to misread.
- **`list_traces` is span-level.** The same `trace_id` can appear N times, one per model call. Use `list_trace_summaries` for one row per trace, or `get_trace` for a single trace's full structure.
- **Empty rollups usually mean wrong scope.** `get_usage_summary` returning zeros most often means the MCP's API key has no traffic for that window, not that there's no data globally. Run `list_api_keys` to see which keys are visible.
- **Default windows are generous.** `list_trace_summaries` defaults to 168h (7d), max 4320h (180d). For "what's happening right now," pass `hours: 1`.
- **Sort by what you're investigating.** `sort_by: "cost_usd"` to find the expensive traces; `"duration_ms"` for slow ones; `"tokens"` for the chatty ones.
- **Filter early.** `provider`, `model`, `operation`, `status` shrink the result set server-side. `operation` maps to `baggage.operation` (e.g. `chat`, `heartbeat`, `key-art`).

## Common investigation patterns

- **"Why did this request fail?"** Get `requestId` -> `trace-flow-prod.get_trace` for spans/events -> if body needed, hit `https://api.trace-flow.dev/r2/bodies/<requestId>` (auth required) -> Axiom query on `cloudflare` dataset filtering `request_id` for proxy/consumer logs.
- **"Queue is backed up."** Cloudflare MCP `workers_get_worker` for `trace-flow-consumer` deploy state -> Axiom on `runtime == "proxy-consumer"` for batcher errors (look at `data.unhealthyShards`, `data.queuedTraces`, `data.lastSuccessfulFlushAgeMs`) -> check DLQ `trace-flow-requests-dlq-prod` via Cloudflare dashboard. Recent fix history: see commits 2b45bbf (stale TraceBatcher) and 8e585ce (SQL param overflow).
- **"Spike in errors."** Sentry `search_issues` filtered by `environment:production` -> cross-reference Axiom `cloudflare` dataset for the same window -> if proxy error, check `trace-flow-proxy` analytics dataset for skip rate.
- **"Tinybird query slow."** Check sorting key order in the relevant `.datasource` (highest-cardinality filter first), prefer `PREWHERE` on small columns, filter before joins. Pipes live in `pipes/`.
- **"Schema migration."** Use `FORWARD_QUERY` for zero-downtime; validate with `tb build`; deletes need `--allow-destructive-operations`: Bad rows land in `<datasource>_quarantine`.

## Notes

- Prod deploys only via GH Actions on merge to `main`: Order: Convex -> workers in parallel -> web. Never deploy prod manually.
- Auth0 (API worker): domain `auth0.zaks.io`, client IDs `iyvisDUHrcsFGZYWdxZrX7LH8rtnT50W` (dev/preview) and `asEG3J6UWZOeKWclu2WxONmoIhTsCfdp` (prod).
- The Cloudflare account also holds non-trace-flow workers (`apictx-*`, `neuron-*`, `synet-*`, `otto-*`); always scope queries by worker name.
