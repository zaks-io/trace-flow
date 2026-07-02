# Agent Analytics Derived Signal Read Models

Status: Accepted
Captured: 2026-06-06

Trace Flow should expose agent optimization guidance from a derived signal layer, not by querying raw agent facts directly from the dashboard or MCP.

## Context

The first raw Tinybird review against `zaks-io/agent-paste` showed that the agent data can produce useful repo-optimization signals:

- long-running sessions with many small steps dominate spend
- cache replay is the main token multiplier
- file attention is strong enough to build repo maps
- tool failures cluster into actionable categories
- PR links, session shape, and capability snapshots are useful when treated with the right confidence

The same review also exposed the limits of direct raw querying:

- raw `agent_message` and `agent_tool_*` scans are fast enough for ad hoc diagnosis when tightly filtered, but not the right product contract
- path extraction from shell search commands is currently weak
- error categorization is mostly derived from free-form error text
- broad unbounded `FINAL` scans can time out
- high-cardinality arrays or raw excerpts would create unbounded MCP token output
- daily-only batching would miss the active-session risk that is most useful to an agent while it is still working

The existing `agent_usage_hourly` and `agent_tool_usage_hourly` rollups are useful cost and tool-count foundations, but they do not express the higher-level signals we need: session risk, file attention, error categories, confidence, freshness, and bounded guidance payloads.

## Decision

Add a derived signal read-model layer over the raw agent facts. Raw facts remain the source of truth and replay base. Product endpoints, dashboard panels, and MCP tools read from bounded derived tables plus a small live tail when freshness requires it.

The read-model family should be narrow, typed, and query-oriented:

- `agent_session_signals`: one row per agent session, keyed by org and stable session identity. Stores message counts, duration, token totals, cache ratios, tool counts, failure counts, navigation counts, file counts, PR-link counts, fixed error-category counts, coverage flags, and a derived runaway score/band.
- `agent_session_file_signals`: one row per session and normalized path. Stores read/edit/write counts, first/last touch time, and enough repo identity to power file-attention maps without repeatedly scanning raw tool calls.
- hourly repo signal rollups: bounded 1-hour tables for session shape, tool failures, error categories, file hotspots, PR-link coverage, cache pressure, and active-session risk.
- daily repo baselines: p50/p90/p99 session shape, normal cache ratio, normal failure rate, stable file hotspots, and longer-term confidence context.

The MCP-facing contract should return bounded guidance, not raw analytics:

- always require org and repo/project scope
- default to short windows and small limits
- include `generated_at`, source windows, rollup watermark, confidence level, and coverage notes
- cap file hints, failure hints, and session-risk rows
- omit raw transcript excerpts by default
- expose drilldown tools separately for humans or explicit agent follow-up

Freshness should use a hot/cold pattern:

- compute session-level derived facts as close to ingest as practical
- refresh hot hourly rollups every 5 to 15 minutes over a bounded recent window
- merge in a live raw tail only after the latest rollup watermark when an endpoint needs near-real-time data
- compute daily baselines on a daily cadence

Do not add more full-target `COPY_MODE replace` jobs on a short schedule for every signal. They are acceptable for small existing tables, but the signal layer must be designed so table growth does not turn endpoint reads or scheduled materialization into unbounded scans.

## Confidence Model

Signal consumers must distinguish evidence strength:

- High confidence: session shape, token/cache pressure, structured tool failures, file read/edit/write attention, and PR-link coverage.
- Medium confidence: inferred error categories, capability snapshot size, shell navigation volume, and workflow loop shape.
- Low confidence: search target intent from shell command strings, natural-language task intent, and root-cause claims from free-form text.
- Non-signals: raw counts without normalization, exact dollar precision from estimated cost fields, and any guidance based on broad all-history scans.

The read models should carry coverage fields where gaps matter, such as missing repo identity, missing structured command args, missing error category, missing PR URL, and unknown model/source attribution.

## Query Guardrails

Every public signal query must be bounded:

- require org scope
- require repo/project scope unless the endpoint is explicitly a small account-wide summary
- clamp time windows
- apply hard result limits
- avoid query-time substring scans over raw excerpts
- avoid returning large arrays or transcript text
- use sorting keys and pre-aggregated dimensions before joins
- expose `unknown` and `insufficient_data` instead of pretending low-coverage signals are precise

For Tinybird specifically, derived endpoints should filter on sorting-key dimensions first and avoid broad `FINAL` reads. Full raw scans remain a diagnostic/admin workflow, not the runtime product path.

Agent signal Tinybird files carry a static query contract in
`scripts/verify-agent-signal-query-guardrails.mjs`:

- public signal endpoints must filter by `OrgId`, derive `start_time_ms` / `end_time_ms`, and apply
  that window in the query
- repo/project-scoped signal endpoints must return no rows unless `repos` or `repo_fingerprint` is
  supplied
- account-wide signal endpoints are allowed only as explicit small summaries or discovery pages,
  capped at 100 rows or a single aggregate row
- MCP-facing outputs must not return raw transcript text, raw excerpts, or unbounded arrays
- `FINAL` is not allowed in public signal endpoints or signal materializations; broad raw `FINAL`
  scans stay admin-only diagnostics
- signal materializations must be incremental `TYPE MATERIALIZED` resources grouped by organization
  and stable serving grain; scheduled replacement copies are repair-only and must stay unscheduled

Representative query performance is checked with
`scripts/tinybird-agent-signal-performance-report.sh`, which times fixture-backed Tinybird tests for
session risk, file hotspots, tool failures, and daily repo-baseline movement.

## Alternatives Considered

### Query raw facts directly from dashboard and MCP

Rejected. The initial ad hoc queries were useful, but this would make product latency, Tinybird compute, and MCP token output scale with raw fact growth.

### Build one giant insight JSON table

Rejected. It would be easy to return to agents, but hard to filter, version, backfill, validate, and keep bounded. It would also blur confidence levels and make dashboards less flexible.

### Daily-only derived tables

Rejected. Daily baselines are useful, but the most actionable intervention is during an active or recent runaway session. A daily-only system would explain yesterday's waste while missing today's.

### Full-table replacement every few minutes

Rejected as the default pattern for this signal family. It is simple, but it turns every new derived signal into a growing scheduled scan. Use bounded hot windows, session-grain replacement, or rebuildable cold baselines instead.

### Treat all extracted signals as equally trustworthy

Rejected. File touches and session shape are much stronger than inferred task intent or search-command path parsing. The product should expose confidence and coverage instead of flattening everything into one "recommendation" stream.

## Consequences

This adds storage and pipeline complexity, but it gives Trace Flow a stable product contract:

- dashboard queries become predictable and cheap
- MCP tools can return small, current, high-signal guidance
- agents can receive repo-navigation hints without reading dashboards or raw traces
- weak signals stay visible as weak instead of being promoted into facts
- raw facts remain replayable when parsers improve

The main operational risk is derived-table drift. Mitigate it with fixture-backed parser tests, rollup backfill checks, query performance checks, and explicit freshness metadata in every endpoint response.

## Implementation Tickets

- [TRA-136](https://linear.app/zaks-io/issue/TRA-136/build-derived-agent-analytics-signals-for-repo-optimization): parent tracking issue.
- [TRA-137](https://linear.app/zaks-io/issue/TRA-137/classify-agent-tool-errors-and-navigation-events-at-ingest): parser and structured extraction improvements.
- [TRA-138](https://linear.app/zaks-io/issue/TRA-138/build-the-agent-session-signal-read-model): session signal read model.
- [TRA-139](https://linear.app/zaks-io/issue/TRA-139/build-the-agent-session-file-attention-read-model): file attention read model.
- [TRA-140](https://linear.app/zaks-io/issue/TRA-140/add-guardrails-for-agent-signal-tinybird-queries): query and compute guardrails.
- [TRA-141](https://linear.app/zaks-io/issue/TRA-141/add-bounded-repo-signal-rollups-and-daily-baselines): hourly rollups and daily baselines.
- [TRA-142](https://linear.app/zaks-io/issue/TRA-142/expose-bounded-mcp-guidance-for-repo-optimization): MCP guidance contract.
- [TRA-143](https://linear.app/zaks-io/issue/TRA-143/add-dashboard-panels-for-agent-optimization-signals): dashboard signal surfaces.
- [TRA-144](https://linear.app/zaks-io/issue/TRA-144/validate-agent-signal-confidence-across-multiple-repos): cross-repo confidence validation.

## Done

This decision is implemented when:

- the derived session and file signal tables exist with tests or fixtures
- hourly repo signal rollups are bounded and have query-performance checks
- daily baselines exist for stable context
- MCP-facing endpoints return bounded guidance with confidence, coverage, and freshness metadata
- dashboard surfaces read derived signal endpoints rather than scanning raw facts
- Linear tickets cover parser improvements, read models, rollups, MCP tools, dashboard surfaces, and compute guardrails
