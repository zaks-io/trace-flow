# Agent Conversation Analytics

Status: accepted

Captured: 2026-05-23

Trace Flow becomes the analytics system of record for local AI-agent activity (Claude Code, Codex, Cursor), alongside proxied LLM Requests. A local Collector parses transcripts into typed facts and syncs them to an ApiKey-authed ingest Worker. The Worker rate-limits, assembles canonical IDs, and enqueues. A stateless consumer prices the facts server-side and writes them into bespoke Tinybird datasources that mirror the `llm_requests` pattern. We learn from Otto's Convex implementation but do not port it.

## Context

Otto proved the data is valuable and exposed the hard parts: identity is unstable across worktrees, dedupe is easy to get wrong, raw conversation rows are expensive, and wide aggregate documents rot. Trace Flow already has the architecture this needs: edge ingestion, a durable queue, Tinybird with materialized rollups, retention-aware reads, and a working server-side pricing chain.

The otto-parser (Rust, shared) already normalizes all three sources into one `ParsedTranscript`. It dispatches on source type, and Cursor rides the Claude parser path. It extracts Codex exit codes by regex, command families, file paths, subagent facts, and stamps `parser_version`. The questions the original research note treated as open (Codex-first vs Claude-first, weak Codex repo attribution, a bespoke `session_fingerprint` hash) are already answered by the parser or are dissolved by the decisions below.

### Local survey

| Store                | Shape               |        Size / count | Notes                                                     |
| -------------------- | ------------------- | ------------------: | --------------------------------------------------------- |
| `~/.claude/projects` | JSONL conversations | 6,619 files, 1.8 GB | Rich model/token/cache/tool data; many worktree variants. |
| `~/.codex/sessions`  | JSONL sessions      |     70 files, 84 MB | Rich tool execution, exit codes, command families.        |
| `~/.cursor`          | Mixed Cursor state  |               37 GB | Noisy; useful transcripts are a small subset.             |

The 1.8 GB and 37 GB are mostly raw conversation text we do not ingest. We ship parsed facts, not transcripts. All three sources reduce to similar fact volumes.

### Corpus measurement

One heavy user (135-day span, 2026-01-08 to 2026-05-23): 427,759 messages (~3,170/day), 166,868 tool uses (~1,240/day), roughly 4,400 combined fact rows/day. At about 150 bytes/row:

- Raw facts at 90-day TTL: ~60 MB/user. 1,000 such users: ~60 GB, about $3.50/month at the $0.058/GB-month storage overage rate.
- Hourly/daily rollups at 1-year TTL: ~28 MB/user. 1,000 users: ~28 GB, about $1.65/month.

Storage is not the cost driver on Tinybird (vCPU-hours are). This is why retention is generous and flat: keeping raw facts longer is cheap, and rollups serve the dashboards so raw scans stay rare.

## Scope (v1)

A vertical slice that proves ingestion, dedupe, pricing, rollup, and the three launch queries end to end, for all three sources from day one. No source fork. `source` is a dimension column, not a branch in the pipeline.

## Decisions

### Tenancy and identity

Facts are org-scoped and stamped with `ApiKey` only. Org, User, and Project resolve at read time through Convex, the same way Span reads work. Project is a read-time grouping that spans agent and LLM data; it is not stamped onto facts and its Convex entity is deferred.

Identity is vendor-ID-first, assembled at the ingest Worker:

- `session_id` = hash(`source`, vendor session ID). Stable UUID for Claude and Codex.
- `message_id` adds the vendor message ID.
- `tool_use_id` comes from the tool-use block; fall back to (`session_id`, `message_id`, block index) when absent.
- `repo_fingerprint` = hash(normalized git remote), resolved by the Collector. Path/`cwd` is a fallback, never the identity.
- Content-hash fallback for session identity applies to Cursor only, where vendor IDs are unreliable.

This replaces the research note's compound `session_fingerprint` algorithm. Hashing and ID assembly live in one place (the ingest Worker), not in the Collector or scattered across the consumer.

### Transport

Local parse, no raw upload.

```
Collector (desktop tray)            ApiKey ingest Worker             Queue              Consumer
  parse transcripts          ->     auth + ORG rate limit     ->   durable buffer ->   price (KV)
  resolve repo_fingerprint          size cap, chunk to <128KB        DLQ                reconcile
  POST canonical facts              assemble IDs                                        one batched insert
  (tokens + model, no price)        202 / 429 / 413                                     -> typed datasources
```

The Collector parses locally and ships facts. It never uploads raw transcript text and never computes price. R2 storage of raw payloads is deferred.

The ingest Worker authenticates the `ApiKey`, applies a per-org rate limit (new `AGENT_INGEST_LIMITER`, namespace `2005`, mirroring `ORG_LIMITER`'s pattern) and a request-size cap, returns 202/429/413, and chunks oversized POSTs into sub-128KB queue messages.

The consumer is stateless: bounded `max_concurrency`, one batched insert per invocation, with the queue's DLQ for poison messages.

### No Durable Object

The proxy path uses `TraceBatcher` (a Durable Object) because individual LLM Requests arrive unbatched and need accumulation. Agent ingest diverges: the Collector already pre-batches a sync, and ReplacingMergeTree dedups on read, so a second batching tier buys nothing. Skipping the DO keeps the consumer simple and avoids per-shard state we would otherwise have to flush and monitor.

### Data model

Bespoke typed fact tables written directly by the consumer, the `llm_requests` analogue. Never routed through `otel_traces`. Agent conversations are not proxied LLM Requests; forcing them into the span schema would lose the turn and tool grain.

Three base tables, two rollups, one session aggregate:

| Table                    | Grain                                        | Role                                                            |
| ------------------------ | -------------------------------------------- | --------------------------------------------------------------- |
| `agent_messages`         | one turn (Agent Message)                     | model, tokens, cost. The `llm_requests` twin.                   |
| `agent_tool_events`      | one tool invocation (Tool Event)             | failures, command families, durations, subagent facts.          |
| `agent_file_events`      | one file touch                               | repeated-path attention and hotspots. Repo-relative paths only. |
| `agent_usage_1h` / `_1d` | hour / day, by org/source/repo/model         | token, cost, cache, message, session trends.                    |
| `agent_tool_usage_1h`    | hour, by org/source/repo/tool/command_family | tool mix and failure rates.                                     |
| `agent_sessions`         | one Agent Session (aggregate)                | session-level outliers (cost, file count, duration).            |

Tool mix, web/research domains, and task subjects/statuses are cheap queries over the base tables, not their own rollups. Subagent patterns ride on `is_subagent_spawn` / `agent_depth` (messages) and `extracted_subagent_*` (tool events), not a separate table.

#### Tool use/result reconciliation

The parser emits the tool-use block and the tool-result block as separate events sharing one `tool_use_id`; `extracted_success`, `extracted_exit_code`, and duration live on the result. The Collector folds the pair into one Tool Event fact before sync, carrying both the invocation (tool name, command family, extracted files/queries) and the outcome (status, exit code, duration). This is required for correctness: keying `agent_tool_events` on `tool_use_id` with ReplacingMergeTree would otherwise let use and result collide, and the failure-rate rollup would double-count. This single reconciled row replaces the research note's `tool_phase` column.

### Table physics

```
agent_messages
  ENGINE ReplacingMergeTree(IngestedAt)
  SORTING KEY ApiKey, source, repo_fingerprint, model, session_id, message_id
  PARTITION BY toYYYYMMDD(StartedAt)
  TTL StartedAt + INTERVAL 90 DAY

agent_tool_events
  ENGINE ReplacingMergeTree(IngestedAt)
  SORTING KEY ApiKey, source, repo_fingerprint, tool_name, command_family, session_id, tool_use_id
  PARTITION BY toYYYYMMDD(StartedAt)
  TTL StartedAt + INTERVAL 90 DAY
```

`ApiKey` leads the sorting key because every read is org-scoped. Partition and TTL key on `StartedAt` (transcript time, stable across re-syncs), never ingest time. If they keyed on ingest time, re-syncing an old session would write into a new partition and dedupe would never fire. Daily `StartedAt` partitions handle time pruning; the rollups serve time-series so the base tables do not need a time-leading sort key.

### Dedupe

ReplacingMergeTree keyed on the stable canonical ID, with `IngestedAt` as the version column. Reads use `FINAL`; rollups are built `FROM ... FINAL`. Re-syncing the same session collapses to one row per ID, newest `IngestedAt` winning. A re-parse under a newer `parser_version` self-heals the row.

### Cost and pricing

Cost is computed server-side in the consumer from tokens and model, reusing the existing chain. The Collector ships tokens and model only.

A shared `@trace-flow/pricing` workspace package holds the calculation, used by both the proxy consumer and the agent consumer. A daily Convex cron `importFromModelsDev` mirrors `importFromOpenRouter`: it pulls `models.dev/api.json` into the `modelPricing` table, then syncs to Cloudflare KV. First-party providers only; gateway re-listings of the same model are skipped. `importFromOpenRouter` stays for `provider=openrouter`. The `source` enum gains `'models.dev'` (three files: `schema.ts`, `modelPricing.ts`, `pricing.ts`).

models.dev does not publish reasoning or 1-hour-cache rates, so `calculateCost` falls back gracefully for those components. `cost_usd` is `Nullable(Float64)`: null means no price exists for the model, 0 means a genuinely free model. This is the one deliberate exception to the avoid-Nullable rule. That rule targets always-present and sorting-key columns, where the hidden null-map is pure overhead; `cost_usd` is neither, and it needs a real not-applicable state, so the null-map is the honest representation rather than waste. null drives the coverage metric below (`count(cost_usd) / count(*)`) and backfills to a price on re-sync once the catalog covers the model.

### Failure semantics

`status` is `LowCardinality(String)` in {`success`, `failure`, `unknown`}, mapped from `extracted_success` (None becomes `unknown`). This avoids a Nullable boolean. `failure_rate = failure / (success + failure)`. `unknown` is excluded from the denominator but counted, so a source with poor outcome signal shows up as low coverage rather than as false success.

### Retention and visibility

Storage is flat and tier-independent. Raw facts: 90-day TTL. Rollups: 1 year or longer. Visibility is tier-gated at read time: a hobby org sees the last 7 days, a pro org sees the full retained window. The two are decoupled, so a tier upgrade reveals already-stored history without re-ingestion. That gap is an upsell lever, not an accident. Both terms are defined in the glossary (Retention Window, Visibility Window).

### Launch queries

All deterministic, zero tuning. The research note's "failing above baseline" detector is dropped; it would have needed fine-tuning to be useful.

1. **Failure leaderboard.** Rank (`tool_name`, `command_family`) by failure rate and count over a window, with a display floor of at least N events so rare tools do not top the chart on one failure.
2. **Period-over-period delta.** This window versus the prior, sorted by movement, via a self-join on `agent_tool_usage_1h`.
3. **Session outliers.** Top sessions by cost and file count (the "$400 and 200 files" case) from the `agent_sessions` aggregate.

`agent_tool_usage_1h` is an `AggregatingMergeTree` keyed on `BucketStart` (hour), `ApiKey`, `source`, `repo_fingerprint`, `tool_name`, `command_family`, with `countState()` for success/failure/unknown and `sumState()` for duration.

### Trust boundary

Trusted in v1: deduped counts, windowed trends, repo/source attribution, deterministic rankings.

Provisional, surfaced honestly rather than hidden:

- Absolute cost. Show priced-token coverage % (the share of rows with non-null `cost_usd`), not a bare "$X spent," until coverage is high.
- Cross-version totals. Every fact carries `parser_version`; re-ingest self-heals via newer `IngestedAt`; windows mixing versions are flagged.
- Outcome attribution beyond `status` is deferred; facts stay descriptive.
- Raw rows are counted only through `FINAL`/rollups, never trusted pre-merge.
- Paths are normalized to repo-relative at ingest, which doubles as a privacy guard stripping the home directory and username.

Data quality is surfaced inline (coverage %, version flags) rather than in a separate detector table.

## Deferred

Explicitly out of v1, to be added when a real need appears:

- Separate `agent_subagent_events` table (covered by message and tool-event fields).
- Anomaly-feature table (`agent_anomaly_features_1h`) and z-score detectors.
- `agent_source_observations` and `agent_import_batches` provenance tables.
- R2 storage of raw transcripts.
- The Project Convex entity.

## Trade-offs

- Eventual consistency. Facts appear seconds after a sync, like the proxy path.
- Collector-side reconciliation means the desktop app owns more parsing logic, but it keeps the payload to one row per tool invocation and the consumer simple.
- Flat retention spends a little storage to avoid retention-tier complexity in the raw tables. The corpus math shows it is a few dollars a month at 1,000 heavy users.
- No DO means no second batching tier; we rely on the Collector pre-batching and accept slightly larger per-invocation inserts.

## Done

Verifiable outcomes for the v1 slice:

- A local transcript parsed by the Collector becomes queryable typed facts (`agent_messages`, `agent_tool_events`, `agent_file_events`) for the owning org, filterable by `source` and `repo_fingerprint`.
- Re-syncing the same Agent Session twice does not change counts after `FINAL`; rollups built `FROM ... FINAL` match the deduped base counts.
- `agent_messages.cost_usd` is computed in the consumer from KV pricing; no pricing math runs in the Collector; priced-token coverage % is queryable.
- The daily `importFromModelsDev` cron populates `modelPricing` with `source='models.dev'`; a known first-party model resolves to a non-zero price; an unknown model lands with null `cost_usd` and is backfilled on a later run once the catalog covers it.
- The failure leaderboard returns ranked (`tool_name`, `command_family`) with the display floor applied; the period delta returns movers via the rollup self-join; the session-outlier query returns top sessions by cost and file count.
- `status` is one of {`success`, `failure`, `unknown`}; `unknown` is excluded from the failure-rate denominator; the schema's only Nullable column is `cost_usd` (null = unpriced model).
- No stored `agent_file_events` path contains a home directory or username (verified by scanning a sample for `/Users/` and `$HOME`); stored paths are repo-relative.
- An oversized POST returns 413; an over-rate org returns 429; the ingest Worker chunks a large batch into sub-128KB queue messages; a backfill of the 135-day heavy-user corpus drains through the queue without the consumer hitting CPU/subrequest limits or shedding to the DLQ.
- Raw facts carry a TTL on `StartedAt` (90 days); re-syncing a session older than its original partition still dedupes (partition/TTL key on transcript time, not ingest time); a hobby org's reads are clamped to the last 7 days while a pro org sees the full retained window.
