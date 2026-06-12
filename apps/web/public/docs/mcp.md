# MCP Server

Connect your AI assistant directly to Trace Flow data with MCP.

Endpoint: `https://mcp.trace-flow.dev/mcp`

## What it gives you

- Query recent traces from inside your editor
- Drill into grouped trace summaries, spans, events, and usage rollups
- Speed up debugging, incident triage, and cost investigation workflows

## Configuration

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

## Available tools

## `list_traces`

Query recent trace rows with optional filtering.

Important: this is a recent model-call index, not a trace-unique list. The same `trace_id` can appear more than once.

Parameters:

- `provider` (string): filter by provider
- `model` (string): filter by model
- `status` (enum): `STATUS_CODE_OK` or `STATUS_CODE_ERROR`
- `hours` (number): lookback window (default 24, max 168)
- `limit` (number): result limit (default 10, max 25)
- `cursor` (string): pagination cursor

## `list_trace_summaries`

List unique traces with aggregated rollup fields.

Use this when you want one row per `trace_id` before drilling into `get_trace`, `get_trace_spans`, or `get_trace_events`.

Parameters:

- `provider` (string): filter to traces that include this provider
- `model` (string): filter to traces that include this model
- `status` (enum): `STATUS_CODE_OK` or `STATUS_CODE_ERROR`
- `operation` (string): filter by baggage operation / workflow label
- `trace_id` (string): exact trace ID lookup (bypasses other filters)
- `hours` (number): lookback window (default 168)
- `limit` (number): result limit (default 20, max 100)
- `cursor` (string): pagination cursor
- `sort_by` (enum): `timestamp`, `duration_ms`, `cost_usd`, `tokens`
- `order` (enum): `asc` or `desc`

## `get_trace`

Fetch a specific trace by ID.

Important: top-level `duration_ms` is end-to-end wall time. `summary.totals.duration_ms` is summed span time across the trace.

Parameters:

- `trace_id` (required string): 32-char trace ID

## `get_trace_spans`

Fetch paginated spans for a trace with optional filtering and expansion.

Span filters support trailing-`*` prefixes, so patterns like `chat *`, `embeddings *`, and `gen_ai.response.*` work.

## `get_trace_events`

Fetch paginated, sequencing-focused events for a trace.

This tool returns safe metadata only, such as role, message index, content type, tool name, and tool ID. It does not return prompt or response bodies.

## `get_usage_summary`

Fetch aggregated usage, cost, latency, and error totals for a time range.

Use this before drilling into traces when you want a quick KPI snapshot for a workflow, provider, or model.

## `list_operation_usage`

Fetch operation-level usage rollups for a time range.

Use this for top cost, p95 latency, cache hit rate, and unique-user impact by workflow/operation.

## `list_model_usage`

Fetch model-level usage rollups for a time range.

Use this for top cost, p95 latency, and cost efficiency by model.

## `describe_agent_analytics`

Describe the agent analytics query contract and list usable filter values for your org.

Call this before `query_agent_analytics` so your agent can discover valid repo fingerprints, model names, sources, views, and view-specific parameters instead of guessing.

Common parameters:

- `hours` (number): lookback window, default 168
- `start_time` / `end_time` (string): explicit ISO date/time window
- `start_time_ms` / `end_time_ms` (number): explicit Unix millisecond window
- `filters.sources` (array): scope discovered values to `claude`, `codex`, or `cursor`
- `filters.models` (array): scope discovered values to model names
- `filters.repo_fingerprints` (array): scope discovered values to repo/project fingerprints
- `include_values` (boolean): set false to return only the static contract
- `limit` (number): max discovered values per dynamic list. Defaults to 25 and caps at 50.

Returns:

- allowed views for `query_agent_analytics`
- allowed filter keys and static enum values
- allowed view-specific parameters
- discovered `sources`, `models`, and `repo_fingerprints` for the selected date range

## `query_agent_analytics`

Query agent conversation analytics with one generic, allowlisted tool.

Use `view` to choose the read model:

- `summary`: one KPI row for cost, tokens, messages, sessions, and priced coverage
- `timeseries`: bucketed usage and tool-event metrics
- `breakdown`: ranked usage by `source`, `model`, or `repo`
- `sessions`: recent or expensive agent sessions
- `tool_failures`: tool failure leaderboard
- `tool_deltas`: period-over-period tool usage movement
- `projects`: available repo/project fingerprints for filtering

Common parameters:

- `hours` (number): lookback window, default 168
- `start_time` / `end_time` (string): explicit ISO date/time window
- `start_time_ms` / `end_time_ms` (number): explicit Unix millisecond window
- `filters.sources` (array): `claude`, `codex`, or `cursor`
- `filters.models` (array): model names
- `filters.repo_fingerprints` (array): repo/project fingerprints from `view="projects"`

View-specific parameters:

- `group_by`: for `timeseries`, `none`, `source`, `model`, or `repo`
- `granularity`: for `timeseries`, `auto`, `hour`, or `day`
- `dimension`: for `breakdown`, `source`, `model`, or `repo`
- `order_by`: for `breakdown`, `cost_usd`, `total_tokens`, `message_count`, or `session_count`
- `sort`: for `sessions`, `recent`, `cost`, `files`, `duration`, or `messages`
- `min_events`: for `tool_failures`
- `limit` / `offset`: bounded row paging for every multi-row view. Defaults to 25 rows except `timeseries`, which is capped at 50 rows per page.

## Example prompts for your agent

- "Use `list_trace_summaries` with status `STATUS_CODE_ERROR` and `hours=1` to find failed traces, then inspect the top result with `get_trace_spans`."
- "Use `get_trace_spans` with `expand=[\"status_message\",\"http\",\"url\",\"provider\",\"model\",\"baggage\"]` to diagnose why this trace failed."
- "Use `get_trace_events` filtered to `input.tool_use` and `input.tool_result` to verify the tool loop order."
- "Use `get_usage_summary` and `list_operation_usage` for the last 168 hours to identify the most expensive workflows."
- "Use `list_model_usage` to compare p95 latency and cost efficiency across models."
- "Use `describe_agent_analytics` for the last 7 days to discover available repo fingerprints and models."
- "Use `query_agent_analytics` with `view=\"projects\"`, then query `view=\"summary\"` with a repo fingerprint to show tokens spent on that project in the last week."

## Auth behavior

First-time use triggers OAuth authorization with your Trace Flow account. After consent, tokens refresh automatically.
