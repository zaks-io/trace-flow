# Agent Conversation Analytics

Status: accepted

Captured: 2026-05-23

Trace Flow becomes the analytics system of record for local AI-agent activity (Claude Code, Codex, Cursor), alongside proxied LLM Requests. A local Collector parses transcripts into typed facts and syncs them to an ApiKey-authed ingest Worker. The Worker rate-limits, assembles canonical IDs, and enqueues. A stateless consumer prices the facts server-side and writes them into bespoke Tinybird datasources that mirror the `llm_requests` pattern. The Collector is Otto's CLI and desktop code vendored into this repo and modified for Trace Flow; Otto's Convex backend is not ported.

## Context

Otto proved the data is valuable and exposed the hard parts: identity is unstable across worktrees, dedupe is easy to get wrong, raw conversation rows are expensive, and wide aggregate documents rot. Trace Flow already has the architecture this needs: edge ingestion, a durable queue, Tinybird with materialized rollups, retention-aware reads, and a working server-side pricing chain.

Otto is an incomplete prototype, not a system to port. Its parser, source discovery, and git/sync layers work and encode hard-won transcript knowledge, but it prices locally, its Cursor support targets the older `~/.cursor/projects` JSONL layout (not the current `acp-sessions` store), and it folds nothing at the tool-pair level. We vendor that code rather than rebuild it (see Collector below) and redo the parts that conflict with the decisions here. The parser already normalizes sources into one `NormalizedEvent` stream (a Turn), resolves the git remote in its sync layer, extracts Codex exit codes, command families, and subagent facts, and stamps `parser_version`. The research note's open questions (Codex-first vs Claude-first, weak Codex repo attribution, a bespoke `session_fingerprint` hash) are dissolved by the decisions below, not by the prototype.

### Local survey

| Store                    | Shape                 |        Size / count | Notes                                                                               |
| ------------------------ | --------------------- | ------------------: | ----------------------------------------------------------------------------------- |
| `~/.claude/projects`     | JSONL conversations   | 6,619 files, 1.8 GB | Rich model/token/cache/tool data; many worktree variants.                           |
| `~/.codex/sessions`      | JSONL sessions        |     70 files, 84 MB | Rich tool execution, exit codes, command families.                                  |
| `~/.cursor/projects`     | JSONL conversations   |             ~173 MB | UUID session id in path; subagents as separate files. The layout Otto parses today. |
| `~/.cursor/acp-sessions` | Agent Client Protocol |  ~808 MB, 102k dirs | Current Cursor store; UUID dir name + `meta.json`. Not parsed by Otto yet.          |

Those totals are mostly raw conversation text. (The `~/.cursor` directory is ~37 GB on disk, but ~35 GB of that is git worktrees, actual checkouts, not transcripts; the two rows above are the real Cursor corpus.) The Collector always ships parsed facts; when raw upload is enabled it also sends a gzip-compressed copy of each processed transcript (see Raw transcript storage and replay), a fraction of the on-disk size at roughly 10x compression, with the fact rows smaller still. All three sources reduce to similar fact volumes.

### Corpus measurement

One heavy user (135-day span, 2026-01-08 to 2026-05-23): 427,759 messages (~3,170/day), 166,868 tool uses (~1,240/day), roughly 4,400 combined fact rows/day. At about 150 bytes/row:

- Base fact tables at 1-year TTL: ~240 MB/user. 1,000 such users: ~240 GB, about $14/month at the $0.058/GB-month storage overage rate.
- Hourly/daily rollups at 1-year TTL: ~28 MB/user. 1,000 users: ~28 GB, about $1.65/month.

Storage is not the cost driver on Tinybird (vCPU-hours are), so keeping the facts a full year is cheap (~$14/month at 1,000 heavy users). The 90-day cap applies only to raw transcripts, where it is a deliberate privacy choice rather than a cost ceiling; the derived facts carry no conversation text and live the full year. Rollups serve the dashboards so base-table scans stay rare.

## Scope (v1)

A vertical slice that proves ingestion, dedupe, pricing, rollup, and the three launch queries end to end, for all three sources from day one. No source fork. `source` is a dimension column, not a branch in the pipeline.

## Decisions

### Collector (vendored, not rewritten)

The Collector is Otto's Rust CLI and desktop (Tauri tray) code, pulled into this repo, rebranded, and modified for Trace Flow rather than rewritten. Otto is an incomplete prototype, but its multi-source parser, source discovery, and git-remote resolution work and carry format-specific detail that is expensive to rediscover. Vendoring keeps that head start.

Four modifications make it Trace Flow's:

1. Strip local pricing. Otto's parser computes `cost_usd` from a price map; Trace Flow prices server-side (Cost and pricing), so that path is removed and the Collector ships tokens and model only.
2. Point sync at the `ApiKey` ingest Worker instead of Otto's backend, with Trace Flow `ApiKey` auth and the opt-in raw-transcript upload.
3. Assemble canonical IDs in the ingest Worker, not the Collector (Tenancy and identity); the parser's own `source_record_id` (which mixes in redacted text and line position) is not used as a dedupe key.
4. Extend Cursor coverage to the current `acp-sessions` store; Otto only parses the older `~/.cursor/projects` JSONL layout.

The trade-off: we inherit Otto's parser shape and its gaps as known work (unparsed Cursor `acp-sessions`, no tool-pair folding, synthetic Codex message IDs) in exchange for not rebuilding a working parser. Vendoring is close to one-way once we begin modifying, which is why it is recorded here.

### Tenancy and identity

Facts are org-scoped and stamped with `ApiKey` only. Org, User, and Project resolve at read time through Convex, the same way Span reads work. Project is a read-time grouping that spans agent and LLM data; it is not stamped onto facts and its Convex entity is deferred.

Identity is vendor-ID-first, assembled at the ingest Worker:

- `session_pk` = hash(`source`, vendor session ID), a stable UUID for Claude, Codex, and Cursor.
- `message_pk` adds the vendor message ID. Claude and Cursor carry one; Codex does not, so for Codex it falls back to (vendor session ID, positional turn index). That positional surrogate is the only identity component derived from parse position rather than vendor bytes, so a re-parse that renumbers Codex turns can move it; it is the weakest dedupe key and is flagged as provisional (Trust boundary).
- `tool_use_pk` adds the tool-use block's `tool_use_id`; when that is absent, substitute (vendor message ID, block index).
- `repo_fingerprint` = hash(normalized git remote); the Collector resolves the remote string and the ingest Worker hashes it, keeping hashing in one place. Codex carries the remote in-band (`session_meta.payload.git.repository_url`); Claude and Cursor do not, so the Collector resolves it from the session's `cwd` the moment it first observes the session — while that worktree is still live — and freezes it, keeping a durable `cwd → remote` cache so a worktree deleted before sync stays resolvable. SSH and HTTPS remote forms normalize to one fingerprint. When no remote resolves (pre-install history, an already-deleted uncached worktree, a local-only repo), the fact falls back to a normalized path hash stamped `repo_source = path`; since `repo_fingerprint` is a regular column, a later remote-bearing re-sync heals the rows upward. Path/`cwd` is never the trusted identity.
- Content-hash is a last-resort session identity for any source where no vendor UUID is recoverable, not a Cursor default. Cursor exposes a UUID (the `acp-sessions` directory name, and the `projects/.../agent-transcripts/<uuid>/` path), so it normally takes `session_pk` like the others. Where the fallback is unavoidable, the hash must be over stable vendor bytes (never parser output) and byte-stable across versions, the same determinism `StartedAt` requires, or a re-sync mints a new identity and inflates counts.
- Cursor stores subagent transcripts as separate files (`agent-transcripts/<parent>/subagents/<uuid>.jsonl`). The Collector links them to the parent `session_pk` from the path and emits their facts under it with `agent_depth` > 0, never as standalone Agent Sessions. Claude subagents are inline (`isSidechain`); Codex subagents run in the same transcript.

This replaces the research note's compound `session_fingerprint` algorithm. Hashing and ID assembly live in one place (the ingest Worker), not in the Collector or scattered across the consumer.

### Transport

Local parse, then upload the facts and, when the user opts in, the compressed raw transcript. Raw upload is explicit and default-off; the facts path works without it.

```
Collector (desktop tray)            ApiKey ingest Worker              Queue              Consumer
  parse transcripts          ->     auth + ORG rate limit      ->   durable buffer ->   price (KV)
  resolve repo_fingerprint          size cap, chunk to <128KB         DLQ                reconcile
  POST facts + gzip(raw)            assemble IDs                                         one batched insert
  (tokens + model, no price)        encrypt raw -> R2 (90d)                              -> typed datasources
                                    202 / 429 / 413
```

The Collector parses locally, ships facts, and never computes price. When raw upload is enabled it also sends the gzip-compressed transcript over TLS; the ingest Worker encrypts those bytes with the org's Tenant Encryption Key (the mechanism Body Objects already use) and writes them to R2, where plaintext is never persisted. See Raw transcript storage and replay below.

The ingest Worker authenticates the `ApiKey`, applies a per-org rate limit (new `AGENT_INGEST_LIMITER`, namespace `2005`, mirroring `ORG_LIMITER`'s pattern) and a request-size cap, returns 202/429/413, and chunks oversized POSTs into sub-128KB queue messages.

The consumer is stateless: bounded `max_concurrency`, one batched insert per invocation, with the queue's DLQ for poison messages.

### Raw transcript storage and replay

Raw upload is opt-in: explicit, default-off, never required. It is the one switch that makes ingestion a one-time act, so anyone who wants to sync once and reprocess forever turns it on. When enabled, the Collector uploads each in-window transcript gzip-compressed and lossless (no truncation, unlike Body Objects); the ingest Worker encrypts it with the org's Tenant Encryption Key and stores it in R2 Infrequent Access at `agent-transcripts/{orgId}/{session_pk}` under a 90-day lifecycle rule. It skips sessions whose `StartedAt` is already outside that 90-day raw window — deliberately shorter than the one-year fact horizon (see Retention and visibility), so raw never outlives its replay-and-analysis purpose even while the facts live on. At roughly 10x compression this runs about $40 to $80 per year for 1,000 heavy users (`specs/costs/cloudflare-pricing.md`), so storage cost is not a design input.

Raw transcripts exist for two reasons, both bounded to the 90-day window:

- Reprocess without re-syncing. A parser fix, a new derived column, or a pricing correction re-reads the stored transcript server-side, re-parses, and re-inserts; ReplacingMergeTree heals the rows by newest `IngestedAt`. This is the primary dev loop and the whole point of ingest-once: the source machine is never touched again. With raw off, the same fix has to re-sync from the machine, which is the cost of opting out.
- Bounded deep analysis. Agentic or analyst scanning of conversation content runs against this store, inside the same window.

Replay heals rather than duplicates only because the dedupe key is stable identity (see Table physics). One caveat: a fix that changes `StartedAt` moves rows to a different partition, where ReplacingMergeTree will not collapse them against the originals, so a `StartedAt` correction means dropping the affected partitions before replaying, not a bare re-insert.

A session's raw transcript expires at 90 days, but its per-turn facts live a year (Table physics), so the two capabilities decouple. Re-pricing spans the full fact lifetime: a cost-only fix re-runs pricing over the stored token columns in place (no raw read, no re-parse) any time within that year, including after the transcript is gone. Structural re-derivation or new columns need the raw, so that is the capability bounded to 90 days; past it a structural fix needs a fresh import. Past one year the facts expire too and only the longer-lived rollups and `agent_sessions` summary remain, and those cannot be re-priced. So 90 days is the window to get structural derivation right; pricing has the full year.

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

The parser emits the tool-use block and the tool-result block as separate events sharing one `tool_use_id`; `extracted_success`, `extracted_exit_code`, and duration live on the result. The Collector folds the pair into one Tool Event fact before sync, carrying both the invocation (tool name, command family, extracted files/queries) and the outcome (status, exit code, duration). This is required for correctness. The use and result blocks share one `tool_use_id`, hence one `tool_use_pk`: keep them as two rows and the failure-rate denominator double-counts every invocation; let ReplacingMergeTree dedupe them on that key and it collapses the pair into a single row holding only half the fields (invocation or outcome, whichever wins on `IngestedAt`). Folding the pair in the Collector avoids both. This single reconciled row replaces the research note's `tool_phase` column.

### Table physics

```
agent_messages
  ENGINE ReplacingMergeTree(IngestedAt)
  SORTING KEY ApiKey, session_pk, message_pk
  PARTITION BY toYYYYMMDD(StartedAt)
  TTL StartedAt + INTERVAL 1 YEAR

agent_tool_events
  ENGINE ReplacingMergeTree(IngestedAt)
  SORTING KEY ApiKey, session_pk, tool_use_pk
  PARTITION BY toYYYYMMDD(StartedAt)
  TTL StartedAt + INTERVAL 1 YEAR

session_pk  = hash(source, vendor_session_id)
message_pk  = hash(source, vendor_session_id, vendor_message_id)
tool_use_pk = hash(source, vendor_session_id, tool_use_id)
```

The sorting key holds stable identity only, because ReplacingMergeTree dedupes on the entire sorting key, so any column in it becomes part of row identity. `llm_requests` can keep `Model`, `Provider`, and the rest in its key because the proxy emits those once and never re-derives them. Agent facts are the opposite: they are re-parsed, and `model`, `repo_fingerprint`, `command_family`, and `tool_name` are parser outputs that improve over time. In the key, a better `command_family` on re-sync would mint a new row instead of replacing the old one, and counts would inflate. So they live as regular columns, free to change, while the `*_pk` surrogates hash immutable vendor IDs and never move. This gives up `repo`/`model` locality on raw scans (the rollups carry those dimensions) in exchange for making re-import idempotent and self-healing.

`ApiKey` leads for org-scoped reads; `session_pk` groups a session's rows for drilldown. Partition and TTL both key on `StartedAt` (transcript time), never ingest time. Partitioning there lets a re-synced old session land in its original partition and dedupe; anchoring TTL there too makes retention a rolling one-year window of agent facts, expired by cheap whole-partition drops rather than row-level rewrites. The consequence is deliberate: a one-time historical backfill keeps only the last year of facts, because rows with an older `StartedAt` are TTL-eligible on arrival (raw transcripts upload only for the last 90 days, their shorter window). `StartedAt` is the earliest observed conversation-turn timestamp (`user`/`assistant` records only), computed in the ingest Worker rather than the fact parser so it stays a pure function of the session's turn bytes and never moves when derived columns improve. It is deliberately the first activity we can observe, not the Source's declared session start; that declared value is captured separately as `VendorStartedAt` (Codex emits it in `session_meta`; Claude's UUIDv4 id does not, so it stores a zero sentinel to preserve the single-Nullable-column rule). Excluding app-metadata record types (`ai-title`, `queue-operation`, `attachment`, `pr-link`, `last-prompt`) from the anchor keeps Claude Code version drift from shifting it; a change that does shift the earliest turn splits the event across partitions and never collapses, so it is handled like any `StartedAt` correction — drop the affected partitions before replaying (Raw transcript storage covers the deliberate-change path).

### Dedupe

ReplacingMergeTree keyed on the stable surrogate identity (`*_pk`), with `IngestedAt` as the version column. Reads use `FINAL`; rollups are built `FROM ... FINAL`. Re-syncing the same session collapses to one row per ID, newest `IngestedAt` winning. A re-parse under a newer `parser_version` self-heals the row.

### Cost and pricing

Cost is computed server-side in the consumer from tokens and model, reusing the chain Trace Flow already runs for proxied LLM Requests. The Collector ships tokens and model only and never prices. Otto's parser computes `cost_usd` locally from a price map; that path is removed when the parser is vendored (Collector), so pricing exists in exactly one place. Server-side is the natural home: it is one pricing implementation to maintain and correct, it is where proxied LLM Requests are already priced, and it keeps the per-model price catalog and KV out of the desktop client.

A shared `@trace-flow/pricing` workspace package holds the calculation, used by both the proxy consumer and the agent consumer. A daily Convex cron `importFromModelsDev` mirrors `importFromOpenRouter`: it pulls `models.dev/api.json` into the `modelPricing` table, then syncs to Cloudflare KV. First-party providers only; gateway re-listings of the same model are skipped. `importFromOpenRouter` stays for `provider=openrouter`. The `source` enum gains `'models.dev'` (three files: `schema.ts`, `modelPricing.ts`, `pricing.ts`).

models.dev does not publish reasoning or 1-hour-cache rates, so `calculateCost` falls back gracefully for those components. `cost_usd` is `Nullable(Float64)`: null means no price exists for the model, 0 means a genuinely free model. This is the one deliberate exception to the avoid-Nullable rule. That rule targets always-present and sorting-key columns, where the hidden null-map is pure overhead; `cost_usd` is neither, and it needs a real not-applicable state, so the null-map is the honest representation rather than waste. null drives the coverage metric below (`count(cost_usd) / count(*)`) and backfills to a price on re-sync once the catalog covers the model.

Cost is a derived value the store can rebuild, not a number frozen at first ingest. Tokens are immutable stored columns, so across the fact rows' one-year life a cost-only fix re-runs pricing over them in place — no fresh import, no raw read; a deeper correction replays the raw transcript, which is available for the first 90 days.

### Failure semantics

`status` is `LowCardinality(String)` in {`success`, `failure`, `unknown`}, mapped from `extracted_success` (None becomes `unknown`). This avoids a Nullable boolean. `failure_rate = failure / (success + failure)`. `unknown` is excluded from the denominator but counted, so a source with poor outcome signal shows up as low coverage rather than as false success.

### Retention and visibility

Storage splits by sensitivity, not by frequency. Raw transcripts in R2 live 90 days; everything derived from them lives at least a year. The fact tables (per-turn, per-tool, per-file) carry a one-year TTL, and the rollups and `agent_sessions` summary live a year or longer, staying useful for longitudinal outlier review after the facts age out. Capping raw transcripts at 90 days is the deliberate bound: it is the window for replay and for analyst or agent scanning of full conversations, after which we are not holding raw conversations indefinitely. The derived facts carry no conversation text, so they live the full year and keep cost and usage history queryable at row grain.

Visibility is tier-gated at read time and decoupled from storage: a hobby org sees the last 7 days, a pro org the full retained window. A tier upgrade reveals already-stored history without re-ingestion, an upsell lever rather than an accident. Both terms are defined in the glossary (Retention Window, Visibility Window).

### Launch queries

All deterministic, zero tuning. The research note's "failing above baseline" detector is dropped; it would have needed fine-tuning to be useful.

1. **Failure leaderboard.** Rank (`tool_name`, `command_family`) by failure rate and count over a window, with a display floor of at least N events so rare tools do not top the chart on one failure.
2. **Period-over-period delta.** This window versus the prior, sorted by movement, via a self-join on `agent_tool_usage_1h`.
3. **Session outliers.** Top sessions by cost and file count (the "$400 and 200 files" case) from the `agent_sessions` aggregate.

`agent_tool_usage_1h` is an `AggregatingMergeTree` keyed on `BucketStart` (hour), `ApiKey`, `source`, `repo_fingerprint`, `tool_name`, `command_family`, with `countState()` for success/failure/unknown and `sumState()` for duration.

### Trust boundary

Trusted in v1: deduped counts, windowed trends, source attribution, remote-resolved repo attribution (`repo_source = remote`), deterministic rankings.

Provisional, surfaced honestly rather than hidden:

- Path-fallback repo attribution (`repo_source = path`), shown as low-confidence until a remote-bearing re-sync heals it. Affects pre-install history and worktrees deleted before the Collector first observed the session.

- Codex per-message dedupe. Codex exposes no vendor message ID, so its `message_pk` uses a positional turn index; a re-parse that renumbers turns can move it, splitting or merging a Codex message row. Claude and Cursor, with real message IDs, are unaffected.

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
- The Project Convex entity.

## Trade-offs

- Eventual consistency. Facts appear seconds after a sync, like the proxy path.
- Collector-side reconciliation means the desktop app owns more parsing logic, but it keeps the payload to one row per tool invocation and the consumer simple.
- Storage is tier-independent (the 90-day raw-transcript window and the one-year fact/aggregate window apply to every org); only visibility is tiered. The corpus math shows it is around $20 a month at 1,000 heavy users.
- No DO means no second batching tier; we rely on the Collector pre-batching and accept slightly larger per-invocation inserts.
- Replay, deep analysis, and structural re-derivation are a 90-day capability, bounded by the raw-transcript window; raw is purged after it to avoid hoarding conversations, so a structural fix after 90 days needs a fresh import. Pricing is the exception: tokens are stored fact columns, so a cost correction re-runs over the full one-year fact lifetime with no raw read. The raw window is sized so structural derivation gets validated before it closes.

## Done

Verifiable outcomes for the v1 slice:

- A local transcript parsed by the Collector becomes queryable typed facts (`agent_messages`, `agent_tool_events`, `agent_file_events`) for the owning org, filterable by `source` and `repo_fingerprint`.
- A Claude session, a Codex session, and a Cursor session (from both `~/.cursor/projects` and `~/.cursor/acp-sessions`) each parse to facts under a vendor-UUID `session_pk`; a Cursor subagent file lands under its parent's `session_pk` with `agent_depth` > 0, not as a standalone Agent Session.
- Re-syncing the same Agent Session twice does not change counts after `FINAL`; rollups built `FROM ... FINAL` match the deduped base counts.
- `agent_messages.cost_usd` is computed in the consumer from KV pricing; no pricing math runs in the Collector; priced-token coverage % is queryable.
- The vendored parser's local pricing path is gone: the Collector source has no cost calculation, and a fact reaches the consumer carrying tokens and model but no price.
- The daily `importFromModelsDev` cron populates `modelPricing` with `source='models.dev'`; a known first-party model resolves to a non-zero price; an unknown model lands with null `cost_usd` and is backfilled on a later run once the catalog covers it.
- The failure leaderboard returns ranked (`tool_name`, `command_family`) with the display floor applied; the period delta returns movers via the rollup self-join; the session-outlier query returns top sessions by cost and file count.
- `status` is one of {`success`, `failure`, `unknown`}; `unknown` is excluded from the failure-rate denominator; the schema's only Nullable column is `cost_usd` (null = unpriced model).
- No stored `agent_file_events` path contains a home directory or username (verified by scanning a sample for `/Users/` and `$HOME`); stored paths are repo-relative.
- An oversized POST returns 413; an over-rate org returns 429; the ingest Worker chunks a large batch into sub-128KB queue messages; a backfill of the 135-day heavy-user corpus drains through the queue without the consumer hitting CPU/subrequest limits or shedding to the DLQ.
- Fact tables carry a one-year TTL on `StartedAt`; re-syncing a session older than its original partition still dedupes (partition/TTL key on transcript time, not ingest time); a backfilled session whose `StartedAt` predates the one-year fact window does not survive the next merge; a hobby org's reads are clamped to the last 7 days while a pro org sees the full retained window.
- Raw and facts sit on different horizons: a session aged past 90 days still has queryable facts but no raw transcript (raw 90-day R2 lifecycle, facts one-year TTL); a cost-only re-price over that session's stored tokens still succeeds, while a structural re-derivation reports the raw is gone.
- Raw upload is off by default and never blocks fact ingestion; a stored raw transcript is encrypted at rest (no plaintext object in R2) and decrypts only with the org's Tenant Encryption Key; the object carries a 90-day R2 lifecycle and is gone afterward; the Collector does not upload raw for a session already outside the 90-day window.
- Replaying a session from its stored raw transcript (within the 90-day raw window) re-derives facts and updates rows in place with no re-sync from the source machine: the post-replay count is unchanged and the newest `IngestedAt` wins.
- Re-running pricing over stored tokens corrects `cost_usd` with no fresh import and no raw-transcript read, for any session still inside the one-year fact window (including ones whose raw transcript has already expired).
