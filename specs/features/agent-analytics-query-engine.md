# Agent Analytics: Generic Statistical Query Engine

## Status

Proposed. Foundational product direction for `/app/agents` and every consumer of agent
conversation data. This supersedes the pattern of shipping a bespoke pipe + bespoke chart
per question.

## The Problem This Solves

Trace Flow already captures agent-conversation facts at full fidelity: one row per turn,
with the complete token breakdown (input, output, cache-read, cache-creation incl. 5m/1h
split, reasoning), priced `cost_usd`, keyed by `session_pk` + `turn_index`, joinable to
session, repo, model, source, tool events, file events, and calendar day.

The data is there. **The ability to interrogate it generically is not.**

Today every analytical question requires an engineer to hand-build a dedicated Tinybird
pipe and a dedicated UI surface. The dashboard is a fixed set of canned views. The MCP
exposes a fixed set of canned views. When a user has a question those views did not
anticipate — "which conversations are expensive _and why_", "does cost grow with turn
count", "what's the cache-read share of my most expensive sessions" — there is no answer
short of someone shipping new code.

This is the gap. It surfaced concretely when a user saw the dashboard's
"top 10% of conversations = 66% of spend" concentration chart and found **no way, anywhere
in the product, to learn which conversations or why.** But the cost-concentration case is
just _one example_. The defect is general: the platform cannot answer arbitrary statistical
questions about data it already holds.

## Principles (non-negotiable)

1. **Generic, not per-question.** The system answers a _class_ of statistical questions over
   the fact data, configured by parameters. A new question is new parameters, **never a new
   pipe and never a new bespoke chart.** If solving the cost case produces a "cost feature",
   we have failed. Cost concentration must fall out as one configuration of the generic
   engine.

2. **Facts, not opinions.** The engine computes **statistics over raw facts** and presents
   them. It does not editorialize, diagnose, or render judgment. "94% of this session's cost
   is cache-read; cost grew monotonically across 7,000 turns with no reset; p95 turn cost is
   12x the p50" are facts. The user draws the conclusion ("never compacted"). No
   auto-diagnosis, no advisory copy, no "you should" — the value is correct statistics over
   real data, surfaced so the cause is self-evident.

3. **Relationships are first-class.** The cause of a cost is almost never a single summed
   measure — it is a _relationship between facts_: cost vs turn count, context size vs turn
   index, cache-read share vs session length. An engine that aggregates `cost_usd` by session
   but cannot simultaneously surface that session's **turn count** is useless. The engine MUST
   hold measures and their explanatory dimensions together. Grouping by session must be able
   to return both `sum(cost_usd)` AND `count(turns)` AND `max(turn_index)` AND
   `sum(cache_read_tokens)` in the same result — and to compute measures _across_ a dimension
   (cost over turn_index, context over turn_index).

4. **One engine, every surface.** The website, the MCP, and the CLI/API are **adapters over a
   single query engine and a single contract.** No surface gets its own bespoke query logic.
   The dashboard's charts become saved configurations of the engine. The MCP issues the same
   queries programmatically. The CLI/API pulls the same results for scripting. This is the
   entire point of the app — not a side feature. Org-scoping is enforced server-side by the
   token in every adapter; it is never part of the query contract the caller controls.

## What "Generic" Means Concretely

The engine operates over the agent fact tables (per-turn, per-session, per-tool-event,
per-file-event, and their time/dimension rollups). A query selects:

- **Facts** — which grain to query (e.g. per-turn `agent_message_facts`).
- **Dimensions** — what to slice/group by: `session_pk`, `turn_index`, `source`, `model`,
  `repo_fingerprint`, calendar day, `tool_name`, `command_family`, coverage flags, etc.
- **Measures** — numeric facts to aggregate: every token type, `cost_usd`, `duration_ms`,
  and **counts/positions** (turn count per session, max turn_index, message count).
- **Statistics** — the operation applied: sum, avg, count, percentiles, histogram,
  concentration (Gini / Lorenz), correlation, time-trend, leaderboard — applicable to any
  measure across any dimension.
- **Filters, ordering, limit.**

The defining test: **a single query can group by `session_pk` and return, together,
`sum(cost_usd)`, `count(turns)` / `max(turn_index)`, and `sum(cache_read_tokens)`** — so the
relationship between cost and conversation length is directly visible. And: **a query can
compute a measure _across_ `turn_index` within a session** (cost-per-turn curve, context-per-
turn curve) — so growth-over-the-conversation is directly visible.

Cost concentration is then nothing special: `concentration(cost_usd) grouped by session_pk`,
with `count(turns)` and `sum(cache_read_tokens)` alongside so the _why_ travels with the
_what_.

## Fact Model Reference

This is the contract the engine is designed against. Sourced from the live
`datasources/agent_*.datasource`, `packages/types/src/agent-ingest.ts`, and `pipes/agent_*.pipe`.
All raw fact tables: partitioned by `toYYYYMMDD(EventAt)`, 1-year TTL, sorting key starts with
`OrgId` (tenancy) then `session_pk`. Consumer appends via `agent_consumer_append`.

### Raw fact tables (the engine reads these — rollups are for fast serving, not for analysis)

| Table                             | Grain (one row =)       | Sorting key                                 | Notes                                                      |
| --------------------------------- | ----------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| `agent_message_facts`             | one model call / turn   | `OrgId, session_pk, message_pk`             | **The core table.** Per-turn token breakdown + cost.       |
| `agent_tool_event_facts`          | one tool invocation     | `OrgId, session_pk, tool_use_pk`            | Status/duration/command family; subagent token fallback.   |
| `agent_file_event_facts`          | one file operation      | `OrgId, session_pk, file_event_pk`          | read/write/edit/create/delete/rename + repo-relative path. |
| `agent_capability_snapshot_facts` | one capability snapshot | `OrgId, session_pk, capability_snapshot_pk` | Retained for Context Bloat; not in v1 queries.             |
| `agent_pull_request_link_facts`   | one PR-link observation | `OrgId, session_pk, pull_request_link_pk`   | Passive; ≤1 canonical PR per session attributes.           |

Serving/rollup tables (`AggregatingMergeTree`, rebuildable from raw): `agent_session_summaries`
(per-session: MessageCount, per-token sums, CostUsd, PricedMessageCount, counts, timestamps),
`agent_usage_daily` / `agent_usage_hourly`, `agent_tool_usage_daily` / `_hourly`,
`agent_context_call_buckets_hourly`, `agent_repositories` (label lookup).

### agent_message_facts — fields that matter to the engine

- **Identity/join**: `OrgId`, `session_pk` (join key across ALL fact tables),
  `message_pk`, `vendor_session_id`, `vendor_message_id`.
- **Position**: `turn_index` (UInt32, 0-indexed, **populated on every row**) — this is the
  field that makes "cost vs turn count" and per-turn curves possible.
- **Tokens (UInt32, 0 not null)**: `input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_creation_tokens`, `cache_creation_5m_tokens`, `cache_creation_1h_tokens`,
  `reasoning_tokens`.
- **Cost**: `cost_usd` (Nullable(Float64) — the only nullable column; null = unpriced).
- **Quality/scope**: `token_coverage` (full/partial/missing), `cache_coverage` (full/missing),
  `role` (only `assistant` is priced), `agent_depth`, `is_sidechain`, `is_subagent_spawn`,
  `agent_id`.
- **Dimensions**: `source` (claude/codex/cursor), `model`, `repo_fingerprint`, `repo_source`,
  `git_branch`, `git_head_sha`.
- **Time**: `EventAt` (transcript ms), `IngestedAt`, `VendorStartedAt`.

### Relationships / join keys

| From                         | To      | Key                                                         | Cardinality |
| ---------------------------- | ------- | ----------------------------------------------------------- | ----------- |
| turn                         | session | `session_pk`                                                | N:1         |
| turn position within session | —       | `turn_index` (0-indexed)                                    | —           |
| tool event                   | session | `session_pk`                                                | N:1         |
| tool event                   | turn    | `session_pk` + `vendor_message_id` (+ `source_block_index`) | N:1         |
| file event                   | turn    | `session_pk` + `vendor_message_id` + `source_block_index`   | N:1         |
| any fact                     | repo    | `repo_fingerprint`                                          | N:1         |
| any fact                     | day     | `toDate(EventAt)` / `BucketStart`                           | N:1         |

### Dimensions vs measures (the engine's vocabulary)

- **Dimensions** (group/slice): `OrgId`, `source`, `model`, `repo_fingerprint`, `repo_source`,
  `session_pk`, `turn_index`, `agent_depth`, `is_sidechain`, `role`, `tool_name`,
  `command_family`, `status`, `token_coverage`, `cache_coverage`, `EventAt`/`BucketStart`.
- **Measures** (aggregate): all 7 token columns, `cost_usd`, `duration_ms`, and
  counts/positions — `count(turns)`, `count(DISTINCT turn_index)`, `max(turn_index)`,
  `MessageCount`, `ToolEventCount`, `FileEventCount`, `UniqueFileCount`, `FailureCount`,
  `SessionCount`, `PricedMessageCount`.
- **Common derived metrics** (computed, not stored): context = `input + cache_read +
cache_creation`; generated = `input + output + reasoning`; cache-inclusive = generated +
  `cache_creation`; failure rate = failures / (successes + failures).

### Verified capabilities (the acceptance bar is real, not aspirational)

- **Cost + turn count + cache-read together, one query**: `GROUP BY session_pk` on
  `agent_message_facts` returns `count(DISTINCT turn_index)`, `sum(cost_usd)`,
  `sum(cache_read_tokens)` simultaneously. ✅ The relationship the engine must preserve is a
  single GROUP BY.
- **Per-turn cost/context curve within a session**: `GROUP BY (session_pk, turn_index)`,
  order by `turn_index`. ✅
- **Population growth curve (cost at turn N across all sessions)**: `GROUP BY turn_index`,
  quantiles. ✅
- **Cost concentration (Gini/Lorenz)**: per-session `cost_usd` → concentration stat. ✅ (one
  configuration, NOT a special feature).
- **Main-thread vs subagent**: filter `agent_depth = 0 AND is_sidechain = 0`. ✅

### Known join limitations (engine must allow these, they need a session_pk + message join)

- Tool failures correlated to `agent_depth`: tool events lack `agent_depth`; join back to
  messages via `session_pk` + `vendor_message_id`.
- File operations by tool: file events lack `tool_name`; join via
  `session_pk` + `vendor_message_id` + `source_block_index`.

_Full per-column reference for every table lives in the audit; ADR
`docs/adr/0012-agent-conversation-analytics.md` documents identity assembly and the ingest
contract._

## Surfaces

| Surface       | Role                                                                                                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Website**   | Built ON the engine. Every chart is a saved query. Users pose new statistical questions in-product without an engineer shipping a pipe. The expensive-conversation drill-down (ranked sessions WITH token breakdown + turn count, per-turn cost/context curves) is one configuration, not a special feature. |
| **MCP**       | An agent issues the same generic statistical queries and gets facts back. No bespoke tool per question.                                                                                                                                                                                                      |
| **CLI / API** | Programmatic/terminal access to the same engine for pulling results into scripts. Requires an org-scoped _read_ auth path the CLI does not have today (it holds only a write-only collector credential) — see Open Questions.                                                                                |

All three are adapters over the **same engine + contract**. This is the non-negotiable.

## Non-Goals

- No raw-SQL passthrough exposed to callers (leaks internal schema/engineering into the
  client; breaks the bounded, safe contract). Generic ≠ arbitrary SQL.
- No auto-diagnosis / advisory copy / opinions. Statistics only.
- No per-question pipes or per-question charts. If a change adds either, it is wrong.

## Open Questions

- **Statistics boundary — DECIDED.** A bounded catalog of robust statistical operations
  (concentration, distribution, relationship, trend, decomposition, outlier), each applicable
  to any dimension/measure — NOT arbitrary SQL, NOT open-ended measure-algebra. The full
  catalog with definitions, correct sample estimators, failure modes, and sources is
  **ADR 0021 (`docs/adr/0021-agent-analytics-statistical-methods.md`)**. Every method is
  robust-by-construction or nonparametric (the data is heavy-tailed; classical stats lie).
- **CLI read auth.** The CLI's login mints a _write-only_ collector credential and cannot read
  analytics. Exposing the engine via CLI requires adding an org-scoped read-token path
  (device-flow extension + Convex read-token mint + keychain storage). Real work; sequence
  after website + MCP unless the CLI is required in the first cut.
- **Engine home.** Shared contract package (`packages/agent-query` or extend
  `packages/mcp-core`) + one org-scoped endpoint on the API worker that both MCP and CLI call;
  the website may call the same endpoint or the engine directly. apps/api already has
  org-scoped auth and Tinybird-query patterns to reuse.

## Done

- A user can answer a statistical question about agent data that **no one pre-built a view
  for**, from the website, with facts only.
- The expensive-conversation case is answerable end-to-end: ranked sessions WITH turn count
  and token breakdown, drill into per-turn cost/context curves — and it is demonstrably a
  _configuration_ of the generic engine, not special-cased code.
- The same query is issuable from the MCP and returns the same facts.
- Adding the _next_ statistical question requires no new pipe and no new bespoke chart.
- Every surface routes through one engine + one contract; org-scoping is server-side in each.
