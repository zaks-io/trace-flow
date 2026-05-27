# Roadmap & Status Board

Claimable tasks for Agent Conversation Analytics. See [`README.md`](./README.md) for the coordination
protocol. The ADR ([`agent-conversation-analytics.md`](../../adr/agent-conversation-analytics.md)) is
the design source of truth — **column lists, engines, and identity rules live there**, not here.

Status legend: `☐ todo` · `🚧 <branch>` · `✅ done` · `⛔ blocked`

## Board

| ID  | Task                                        | Status                                                                              | Depends on     |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------- | -------------- |
| 0a  | Wire contract + Rust mirror                 | ✅ done                                                                             | —              |
| 0b  | Rust workspace scaffold                     | ✅ done                                                                             | —              |
| 0c  | `@trace-flow/pricing` package               | ✅ done                                                                             | —              |
| 0d  | CF resource provisioning + deploy-gate      | ✅ done                                                                             | —              |
| 1a  | 9 `agent_*` datasources                     | ✅ done                                                                             | 0a             |
| 1b  | Launch-query pipes                          | ✅ done                                                                             | 1a             |
| 1c  | COPY rollup pipes                           | ✅ done                                                                             | 1a             |
| 1d  | Deploy `agent_*` schema (Tinybird)          | ✅ done                                                                             | 1a, 1b, 1c     |
| 2a  | Convex control plane                        | ✅ done                                                                             | 0a             |
| 2b  | `apps/agent-ingest` worker                  | ✅ done                                                                             | 0a, 2a         |
| 2c  | `apps/agent-consumer` worker                | ✅ done                                                                             | 0c, 1a, 2b     |
| 2d  | models.dev pricing import                   | ✅ done                                                                             | 0c, 2a         |
| 2e  | Wrangler / dev wiring                       | ✅ done                                                                             | 2b, 2c, 1d     |
| 2f  | Observability + ops runbook                 | 🚧 code landed; live alerts pending                                                 | 2b, 2c         |
| 2g  | PR CI for new TS packages                   | ✅ done                                                                             | 0c, 2b, 2c     |
| 3a  | `collector-parser`                          | ✅ Claude+Codex emitters + `session_facts` assembler (Cursor `3a*` fast-follow)     | 0a             |
| 3b  | `collector-sync`                            | ✅ freeze cache + orchestrator + cursor store + import-window/envelope + drive loop | 0a, 3a         |
| 3c  | `collector-api-client` + `collector-common` | ✅ done                                                                             | 0a             |
| 3d  | Headless end-to-end run                     | 🚧 discovery scan/selection landed; read+assemble + E2E pending                     | 2e, 3a, 3b, 3c |
| 4a  | Dashboard pages                             | ☐ todo                                                                              | 1b, 2a         |
| 4b  | `org_id` agent JWT in web                   | ☐ todo                                                                              | 2a             |
| 4c  | Connected Desktops surface                  | ☐ todo                                                                              | 2a, 5b         |
| 5a  | Tauri desktop shell                         | ☐ todo                                                                              | 3d             |
| 5b  | Connect + Stronghold credential             | ☐ todo                                                                              | 3d, 5a         |
| 5c  | Notifications + diagnostics                 | ☐ todo                                                                              | 5a             |
| 6a  | Collector CI job                            | ☐ todo                                                                              | 0b             |
| 6b  | macOS arm64 signed release                  | ☐ todo                                                                              | 5b             |

### Milestones

The accepted ADR designs all three sources and the desktop app. This board sequences that design: the
first autonomously-built milestone (**slice B**) ships the economic-truth path for the two sources that
carry full economics, then Cursor and the desktop wrapper land as a fast-follow.

- **v1 (slice B — Claude + Codex economic-truth):** `0a 0b 0c 0d` · `1a 1b 1c 1d` · `2a 2b 2c 2d 2e 2f 2g` ·
  `3a*` `3b 3c 3d` · `4a 4b`. End state: headless collector → deduped, server-priced facts → the three
  launch dashboards on real Claude/Codex data.
- **Fast-follow:** Cursor `state.vscdb` parser (the `3a*` portion) · `4c` · `5a 5b 5c` · `6a 6b`.

The pipeline is source-agnostic (`source` is a dimension, not a branch), so Cursor returns as a
**parser-only** change with no schema or pipeline rework; the desktop app is a distribution wrapper over
the same Rust crates. Deferring them keeps the riskiest, lowest-economic-value code out of the milestone
the driver self-merges to `main`. See README "Scope decisions baked in".

---

## Phase 0 — Contract & foundations

Locks the seam between the Rust collector and the TS backend so later phases proceed in parallel.

### 0a — Wire contract + Rust mirror

- **Files:** `packages/types/src/agent-ingest.ts` (new, mirror `packages/types/src/queue.ts`);
  `packages/collector-contracts/` (new Rust crate); `fixtures/redaction-canary.json` (new, shared
  redaction test corpus consumed by 2b and 3a); `fixtures/agent-envelope.sample.json` (new, shared
  envelope contract fixture loaded by both the Rust and the TS round-trip tests).
- **Do:** Define `AgentIngestEnvelope` (`batch{source, collector_batch_id, desktop_version,
parser_version, raw_upload_requested}`, `facts{messages[], tool_events[], file_events[],
capability_snapshots[], pull_request_links[]}`) and the typed `Agent*Fact` shapes. The collector
  sends vendor IDs, timestamps, tokens, model, redaction counters, normalized git remote string —
  **never** OrgId/UserId/cost/final `*_pk`. Also define `AgentIngestQueueMessage` (worker → consumer,
  carries the assembled `*_pk`). Rust mirror with serde renames matching the JSON exactly; keep both
  in lockstep. Explicit named types, no `Partial<>` chains. Also commit
  `fixtures/redaction-canary.json`: one language-neutral redaction canary corpus (AWS keys,
  GitHub/`Bearer` tokens, `.env` values, JWTs, absolute home paths) that **both** the Rust parser test
  (3a) and the TS server re-redact test (2b) load and assert against, so the two layers of the
  redaction trust boundary cannot drift.
- **Verify:** `bun run type-check`; **one committed `fixtures/agent-envelope.sample.json` is the
  shared contract fixture**: the Rust test serializes a fully-populated `AgentIngestEnvelope` and
  asserts it is field-equal to that file, and a TS test deserializes the **same** file into the TS
  `AgentIngestEnvelope`, asserting every field is present and typed; a serde or type rename on either
  side then fails its own assertion, so the contract cannot silently drift to 3d; `redaction-canary.json`
  parses and is referenced by the 3a and 2b test specs.

### 0b — Rust workspace scaffold

- **Files:** `Cargo.toml` (repo root, new).
- **Do:** Root `Cargo.toml` with members `packages/collector-*` (and `apps/desktop/src-tauri` once
  Phase 5 scaffolds it). Turborepo does **not** manage Cargo — keep cargo builds out of the Turbo
  graph; a dedicated CI job (6a) runs `cargo` directly.
- **Verify:** `cargo metadata` resolves the workspace; `cargo fmt --check` and `clippy` are clean.

### 0c — `@trace-flow/pricing` package

- **Files:** `packages/pricing/` (new); extract from `apps/proxy-consumer/src/pricing.ts`.
- **Do:** Move the **per-message** server-side cost chain into `packages/pricing` (used by both
  consumers): `getPricing` / `calculateCost` / `microdollarsToDollars`, plus `gpt-5.5` context-tier
  awareness (~2x above 200k context). This package prices **one message** from tokens + model and
  nothing else. It does **not** own subagent dedup: the canonical Agent Session Authoring Cost rule
  (count nested/sidechain usage; count tool-result subagent usage **only when no matching sidechain
  exists**) is implemented once in SQL as `agent_priced_usage.pipe` (1c) — the sole runtime path, so
  `agent_sessions` / `agent_usage_*` / PR cost agree by construction. If a `buildPricedUsageView` TS
  helper is written at all, it is a **test spec the pipe is validated against**, never a second runtime
  the consumer or any aggregate calls. One source of truth for dedup; avoids the two-shortcut
  divergence the ADR warns about.
- **Verify:** `packages/pricing` unit tests cover per-message pricing only (`gpt-5.5` tier boundary;
  unpriced model → null `cost_usd`); `proxy-consumer` still type-checks against the extract. Subagent
  no-double-count correctness is asserted in **1c against the pipe**, not here.

### 0d — CF resource provisioning + deploy-gate

- **Files:** none in CI yet — provision via `wrangler`, then wire IDs into the worker
  `wrangler.jsonc` files created in 2b/2c/2e. Touch `.github/workflows/*` only to **keep both new
  workers out of the deploy matrix** (or behind a disabled/503 route) until 2e.
- **Do:** Provision the Cloudflare resources this feature needs, since they are not code:
  `wrangler queues create agent-ingest-dev` + `wrangler queues create agent-ingest-dlq-dev` (mirror
  the proxy `trace-flow-requests*` queues), and `wrangler kv namespace create COLLECTOR_CREDS`
  (separate namespace from the API-key store). The `AGENT_INGEST_LIMITER` rate-limit binding
  (namespace **2006**) is config-only in `wrangler.jsonc` — no provisioning call. Record the generated
  queue/KV IDs for 2e. **Gate deploy:** until 2e wires the end-to-end path, the agent-ingest and
  agent-consumer workers must not be in the CI deploy workflow (or must serve a 503/disabled route), so
  a mid-phase self-merge to `main` leaves an inert, deploy-safe state. Blast radius stays `*-dev`.
- **Verify:** `wrangler queues list` shows both queues; `wrangler kv namespace list` shows
  `COLLECTOR_CREDS`; the CI deploy workflow does **not** deploy the two new workers (grep the workflow
  for the worker names → absent or gated); a `main` build with Phases 0–2 merged deploys cleanly with
  the agent path inert.

## Phase 1 — Tinybird data layer

Verifiable with synthetic rows alone. Columns/engines per ADR "Data model" + "Table physics".

### 1a — 9 `agent_*` datasources

- **Files:** `datasources/agent_messages.datasource`, `agent_tool_events`, `agent_file_events`,
  `agent_capability_snapshots`, `agent_pull_request_links`, `agent_sessions`, `agent_usage_1h`,
  `agent_usage_1d`, `agent_tool_usage_1h`. Mirror `datasources/llm_requests.datasource`.
- **Do:** Base facts → `ReplacingMergeTree(IngestedAt)`, sorting key `OrgId, session_pk, <row>_pk`,
  partition `toYYYYMMDD(EventAt)`, TTL `EventAt + 1 YEAR`. Event timestamps (`EventAt`, `IngestedAt`,
  `LastEventAt`, `StartedAt`, `VendorStartedAt`) are `DateTime64(3)`. **Deliberate new convention:**
  no existing datasource uses `DateTime64` — every `llm_requests` timestamp is Int64 epoch-nanos and
  `BucketStart` is plain `DateTime`. Agent facts are parsed transcripts with no nanosecond source, so
  they store millisecond precision and partition/TTL read the column directly with no `/1e9`
  (rationale in ADR "Table physics"). `VendorStartedAt`'s zero sentinel is the epoch. `agent_sessions` is **rebuilt from base `FINAL`** via the canonical
  priced-usage view (Copy Pipe, `COPY_MODE replace`); `ReplacingMergeTree(IngestedAt)` keyed
  `OrgId, session_pk`, **no partition key** (partitioning by the mutable `LastEventAt` would split a
  re-synced session across partitions where `FINAL` cannot dedupe), TTL `LastEventAt + 1 YEAR`.
  Rollups → `AggregatingMergeTree` keyed `BucketStart, OrgId, source, model, repo_fingerprint, …`
  (low to high cardinality; the `repo_fingerprint` hash last). `cost_usd Nullable(Float64)` is the
  **only** nullable column; sparse metrics use `0` + coverage columns (`token_coverage`,
  `cache_coverage`); `status` in {success, failure, unknown}. Mark `source`, `command_family`,
  `tool_name`, `repo_source`, `model`, `token_coverage`, `cache_coverage`, `status`
  `LowCardinality(String)`, never the `*_pk` / `repo_fingerprint` hashes. Sorting key holds **stable
  identity only**: re-parsed columns (`model`, `command_family`) are regular columns.
- **Verify:** `tb build` validates every file; POST synthetic NDJSON to `/v0/events?name=agent_messages`,
  `SELECT … FINAL` returns it; insert the same `message_pk` twice with newer `IngestedAt`, `FINAL`
  count stays 1.

### 1b — Launch-query pipes

- **Files:** `pipes/agent_failure_leaderboard.pipe`, `pipes/agent_tool_period_delta.pipe`,
  `pipes/agent_session_outliers.pipe`.
- **Do:** Query base `FINAL` (query-time first). For the read pattern follow a base-`FINAL` reader —
  e.g. `pipes/llm_usage_1h_copy.pipe`'s `FROM llm_requests FINAL` — **not** `pipes/llm_usage_summary.pipe`,
  which reads the rollup tables (that is the 1c optimization, not a query-time-first launch pipe).
  `failure_rate` **excludes** `unknown` status (counted, but out of the denominator).
- **Verify:** `tb build`; **committed synthetic NDJSON fixtures with hand-computed expected
  aggregates** — each pipe asserts exact rows and values (e.g. the leaderboard's
  `failure_rate`/`event_count` per `(tool_name, command_family)`), not "returns rows"; `failure_rate`
  excludes `unknown`; the display floor hides a tool with a single failure.

### 1c — COPY rollup pipes

- **Files:** `pipes/agent_priced_usage.pipe` (canonical priced-usage view: applies the subagent
  dedup rule once), `pipes/agent_sessions_copy.pipe`, `pipes/agent_usage_1h_copy.pipe`,
  `agent_usage_1d_copy.pipe`, `agent_tool_usage_1h_copy.pipe`. Mirror `pipes/llm_usage_1h_copy.pipe`.
- **Do:** `COPY_MODE replace` reading base `FINAL` (whole-target swap, **not** materialized-view
  append, which hits the ReplacingMergeTree retraction trap). `agent_sessions`, `agent_usage_*`, and
  PR cost all read `agent_priced_usage`, so the subagent-dedup rule lives in one place and they agree
  by construction. Optimization layer over 1b. Set `COPY_SCHEDULE` to a concrete starting cadence of
  **hourly** (`0 * * * *`), deliberately slower than the proxy's 10-min; revisit under load (see
  Watch-items: `agent_sessions` whole-table rebuild). Do not copy the proxy cadence verbatim.
- **Verify:** `tb build`; COPY populates each target; re-running replaces (no double count); a session
  whose facts span two `EventAt` days yields exactly **one** `agent_sessions` row after rebuild; a
  **constant-cost fixture** (N base messages × one fixed price) rebuilds `agent_sessions` to the
  **exact** expected total (relocated from 2c, which writes those base rows but does not depend on 1c,
  so the rollup assertion lives where the pipe does).
  **Subagent no-double-count (canonical-rule gate, the one place dedup is proven — see 0c):** a
  committed fixture carrying both a sidechain subagent message and a matching tool-result subagent
  usage row asserts `agent_priced_usage` counts the overlap **exactly once**; a fallback-only fixture
  (tool-result usage, no sidechain) counts that usage and marks subagent cost coverage `fallback`.

### 1d — Deploy `agent_*` schema (Tinybird)

- **Files:** none new. Deploys the `datasources/agent_*` and `pipes/agent_*` files from 1a/1b/1c to
  the Tinybird **dev** workspace; optionally a `scripts/deploy-agent-tinybird.sh` wrapper.
- **Do:** Tinybird has no CI deploy today (`SETUP.md` deploys manually), so the autonomous path needs
  an explicit schema deploy or the consumer (2c) and the end-to-end run (2e) POST to datasources that
  do not exist. Deploy the agent data layer to the **dev** workspace with `tb deploy` (confirm the verb
  against the installed CLI: `SETUP.md` still uses the older `tb push`). Keep the **prod** deploy gated
  (manual, aligned with the 0d deploy-gate) until 2e lifts it, so a mid-phase self-merge to `main`
  stays inert. Local fixture tests (1a/1b/1c, 2c) can run against `tb build` or a local `tb` workspace;
  this task owns the **cloud dev** deploy that 2e's end-to-end run reads. Record the exact deploy
  command in the 2f runbook.
- **Verify:** `tb build` is clean; the dev deploy succeeds; `tb --cloud sql "SELECT count() FROM
agent_messages"` resolves where it errored before the deploy; prod is not deployed until 2e.

## Phase 2 — Server ingest pipeline

Proves the whole backend with curl + synthetic envelopes, no client needed.

### 2a — Convex control plane

- **Files:** `packages/convex/schema.ts`, `packages/convex/collectorCredentials.ts` (new, mirror
  `apiKeys.ts`), `packages/convex/integrations/cloudflare.ts`, `packages/convex/http.ts`,
  `packages/convex/integrations/tinybird.ts`.
- **Do:** Add tables `collectorCredentials`, `agentSessionOwners`, `collectorCompatibilityPolicy`.
  Mint/revoke/list (hashed secret only, hidden from `apiKeys.list`). KV sync for a new
  `COLLECTOR_CREDS` namespace (mirror `syncKeyToKV`). HTTP routes `/agent-ingest/claim-sessions` and
  `/agent-ingest/compatibility-policy` (shared-secret guarded like `/usage/record`). `org_id`
  fixed-param path in **both** `generateToken` and `generateTokenInternal` (the MCP entry point at
  `integrations/tinybird.ts`; diverges from `api_keys`) — miss either and one client path silently
  issues an unscoped agent JWT. Dev only: `bunx convex dev --once`.
- **Verify:** `bunx convex dev --once`; `bunx convex run collectorCredentials:mint …` returns a test
  secret; credential absent from `apiKeys.list`; **both** `generateToken` and `generateTokenInternal`
  emit the `org_id` fixed_param; a **concurrent first-writer claim** test fires two simultaneous
  `claim-sessions` mutations for the same `OrgId+session_pk` and asserts exactly one wins (the other
  resolves to `session_owner_conflict`), no torn state (Convex OCC).

### 2b — `apps/agent-ingest` worker

- **Files:** `apps/agent-ingest/` (new; mirror `apps/proxy` + `apps/proxy/src/otlp/index.ts`):
  `auth.ts`, `policy.ts`, `ids.ts`, `ownership.ts`, `chunker.ts`, `handler.ts`, `wrangler.jsonc`.
- **Do:** `auth.ts` validates `X-Trace-Flow-Collector-Secret` against `COLLECTOR_CREDS` KV.
  `policy.ts` fetches + edge-caches the compatibility policy (fail-closed `policy_unavailable` on
  cold miss, stale-while-degraded otherwise). `ids.ts` assembles every `*_pk` (Codex `message_pk`
  falls back to positional turn index; `repo_fingerprint = hash(normalized remote)` with path-hash
  fallback + `repo_source`). `ownership.ts` claims `OrgId+session_pk` first-writer via Convex.
  `chunker.ts` splits to sub-128KB queue messages. `handler.ts`: auth → policy → rate-limit
  (`AGENT_INGEST_LIMITER` ns **2006**) → size cap → re-redact/cap excerpts → assemble → claim →
  enqueue. Bindings **required** (fail loudly). **Log every error before returning an HTTP error.**
  **Named failure paths (never a silent drop or false 202):** `ownership.ts` Convex unreachable →
  retryable **503** (do not drop, do not 202); `AGENT_QUEUE.send()` failure → **5xx** (never 202 on
  lost data); an envelope with empty `facts` arrays → **202 no-op** (not 400); partial-conflict
  batches skip only the conflicting sessions and continue. The re-redact step runs the **shared
  redaction canary corpus** (`fixtures/redaction-canary.json` from 0a, the same fixture the 3a parser
  test asserts against) and drops/masks each, incrementing `dropped_sensitive`.
- **Verify:** curl a synthetic `AgentIngestEnvelope` → 202; assert 401 (no cred), 429 (over limit),
  413 (oversized), `upgrade_required` (bump min version), `session_owner_conflict` (second user,
  same session); **Convex-down → 503** (not 202/drop); **enqueue failure → 5xx** (not 202);
  **empty-facts envelope → 202 no-op**; **policy cold-miss → fail-closed** (cold cache plus a failed
  policy fetch returns **503 `policy_unavailable`**, never a fail-open 202); the **shared redaction
  canary corpus** (0a) is fully dropped/masked and `dropped_sensitive` increments per planted secret.

### 2c — `apps/agent-consumer` worker

- **Files:** `apps/agent-consumer/` (new, stateless, **NO** batching DO);
  `packages/tinybird-client/` (extract a generic insert transport core out of
  `apps/proxy-consumer/src/tinybird.ts`); `apps/proxy-consumer/src/tinybird.ts` (refactored to call the
  shared core).
- **Do:** Read `AGENT_QUEUE`, price each message via `@trace-flow/pricing` from tokens+model (KV
  catalog), one batched insert per **base** datasource. **Insert path (split, not verbatim reuse):**
  `insertIntoTinybird` (`apps/proxy-consumer/src/tinybird.ts:46`) is typed to `TinybirdTrace[]` and
  hard-codes OTel reshaping (it rebuilds nested `Events{}`/`Links{}`), so it cannot take flat agent
  rows as-is. Extract the generic transport core (NDJSON + POST + `TinybirdInsertError`) as
  `insertRows(rows, token, datasource, host)` in `packages/tinybird-client`; leave the OTel reshape in
  proxy-consumer as a thin caller of the core; agent-consumer calls the core with flat rows. **Requeue
  safety:** the Events API is non-idempotent, so a queue-redelivery re-POST writes duplicate physical
  rows, safe here only because `ReplacingMergeTree(IngestedAt)` keyed on `*_pk` collapses them under
  `FINAL` (proxy-consumer cannot lean on this, hence its DO-alarm retry). The consumer
  writes base facts only (per-message `cost_usd`, etc.); it does **not** compute or insert
  `agent_sessions` or the rollups. Session cost, hourly/daily usage, and PR cost are derived in
  Tinybird from `agent_priced_usage` (1c), so the subagent-dedup rule lives in exactly one place.
  **Price cache:** read the KV price catalog **once per `(provider, model)` per invocation/batch**
  (module-scope or per-invocation map), never per message — a backfill batch makes O(distinct models)
  KV reads, not O(messages). **Named failure paths:** a malformed queue message → **DLQ** (never a
  silent drop); a Tinybird insert failure → **retry then DLQ** (queue `max_retries`, then dead-letter),
  never a silent drop. `cost_usd` null when token coverage is missing or the model is unpriced.
- **Verify:** queue → consumer → priced rows in `agent_messages FINAL`; a **constant-cost fixture**
  (N messages × one fixed price) sums to the **exact** expected per-message total in
  `agent_messages FINAL` (no hand-summing); the downstream `agent_sessions` rollup is **1c's to
  verify** (2c does not depend on 1c, so it asserts only the base facts it writes); re-post an
  identical envelope, base `FINAL` counts unchanged; unpriced model → `cost_usd` null; a **malformed
  message → DLQ**; a forced Tinybird insert failure → **retry then DLQ**; a **backfill load test** replaying thousands of synthetic messages asserts **no per-message
  KV read** (O(distinct models) only) and bounded subrequests (drains without shedding to the DLQ);
  **proxy-consumer regression**: its existing `tinybird` tests still pass after the transport-core
  extraction.

### 2d — models.dev pricing import

- **Files:** `packages/convex/billing/modelPricing.ts`, `packages/convex/schema.ts` (enum), pricing types.
- **Do:** `importFromModelsDev` (mirror `importFromOpenRouter`), daily cron, **first-party
  `anthropic`/`openai` entries ONLY** (skip ~25 gateway re-listings), `gpt-5.5` tier rates,
  `codex-auto-review`/Cursor house-model normalization, `source='models.dev'` added to the enum.
- **Verify:** `bunx convex dev --once`; import populates first-party rows only; `gpt-5.5` tier rates
  present; **named first-party models resolve non-null** — e.g. `claude-opus-4-7` and `gpt-5.5` price
  to a non-null rate (guards a silent regression to gateway/empty prices); an unknown model → null.

### 2e — Wrangler / dev wiring

- **Files:** `apps/agent-ingest/wrangler.jsonc`, `apps/agent-consumer/wrangler.jsonc`, root dev scripts.
- **Do:** Bind the **0d-provisioned** `AGENT_QUEUE` + DLQ and `COLLECTOR_CREDS` KV (by their recorded
  IDs) plus `AGENT_INGEST_LIMITER` (2006); add both workers to `dev:all` with the shared
  `--persist-to`. Queue consumers only connect under `bun run dev:all`. **Lift the 0d deploy-gate
  here:** the end-to-end path is complete, so add both workers as deploy jobs in
  `.github/workflows/deploy.yml` **and** to that workflow's `deploy-status.needs` list (a deploy job
  missing from `needs` lets a failed agent deploy report green). The `agent_*` Tinybird schema must
  already be live on dev (**1d**) for the end-to-end run.
- **Verify:** `bun run dev:all` boots both workers (new `.jsonc` config alongside the existing `.toml`
  workers) under one shared `--persist-to`; an envelope flows ingest → queue → consumer locally; the CI
  deploy workflow includes both workers **and** lists them in `deploy-status.needs`; the agent\_\*
  datasources are live on dev (1d) so `deploy:dev` brings the full path up.

### 2f — Observability + ops runbook

- **Files:** `apps/agent-ingest/`, `apps/agent-consumer/` (logging + Sentry wiring) and a runbook under
  `docs/guides/agent-conversation-analytics/`. Reuse `@trace-flow/logging` and the existing Sentry setup.
- **Do:** Structured logs at ingest entry/exit and each branch (auth, policy, claim, enqueue) carrying
  request/collector/session context — **never** secrets or excerpts. Sentry on consumer errors and DLQ
  sends. Alerts: **DLQ non-empty**, **consumer error rate**, and **priced-coverage% health**
  (`count(cost_usd) / count(*)` drop → fires if a `models.dev` import silently regresses to
  gateway/empty prices). A **DLQ-drain runbook** stub: how to inspect, re-drive, the manual
  `tb` / `wrangler` teardown that a `git revert` does **not** perform (dev-only blast radius, per §9),
  and the **1d** Tinybird deploy command (Tinybird is not in CI, so schema deploy is manual/scripted).
- **Verify:** a forced consumer error surfaces in Sentry; a message diverted to the DLQ raises the
  DLQ-non-empty alert; dropping a priced model from the catalog fixture trips the coverage% alert; the
  runbook names the exact `tb` / `wrangler` cleanup commands.

### 2g — PR CI for new TS packages

- **Files:** `.github/workflows/ci.yml`.
- **Do:** `ci.yml` runs only on PRs, and its `changes` paths-filter plus `status.needs` enumerate only
  the existing workers/packages, so a PR touching `packages/pricing`, `apps/agent-ingest`, or
  `apps/agent-consumer` matches no filter, runs no typed job, and `status` goes green regardless. For a
  self-merging driver that is a false green: the first compile of the new code happens only in
  `deploy.yml`'s root `ci` job post-merge, where a type error blocks **all** production deploys (every
  deploy job is `needs: [ci]`). Add `pricing`, `agent-ingest`, `agent-consumer` outputs to the
  `changes` filter (glob `packages/pricing/**`, `apps/agent-ingest/**`, `apps/agent-consumer/**` plus
  their `packages/types` / `utils` deps); add `packages/pricing/**` to the **existing** `proxy-consumer`
  filter too (it now imports the extracted package); add a per-package lint/type-check/test job for each
  (mirror the `proxy-consumer` job, with `build` for the two workers); add all three to the `status`
  job's `needs`. Rust CI stays in 6a; do not duplicate it here.
- **Verify:** a PR touching only `apps/agent-ingest` runs its job; an intentional type error in any of
  the three fails `status` (not a false green); the `status` job's `needs` includes the three new jobs.

## Phase 3 — Headless Rust collector

Vendors and refactors Otto's working code (`~/src/otto` read-only; see `otto-extraction-reference.md`).
Build and test headless against fixtures + the real local stores + the Phase 2 worker, before any UI.

### 3a — `collector-parser`

- **Files:** `packages/collector-parser/` (vendored from `otto-parser`; every file carries the
  provenance/SPDX header from `otto-extraction-reference.md` "Provenance and licensing").
- **Do:** Strip local pricing (ship tokens+model only). Claude: collapse repeated `message.usage` by
  `message.id`. Codex: sum `last_token_usage` deltas, **NEVER** `total_token_usage` (the ~331x trap).
  Fold tool-use + tool-result (same `tool_use_id`) into ONE Tool Event. Reuse `redaction.rs` with
  drop-not-upload + counters, validated against the **shared redaction canary corpus**
  (`fixtures/redaction-canary.json` from 0a, the same fixture the 2b server re-redact asserts against).
  Emit Capability Snapshots (Codex
  `base_instructions`/`dynamic_tools`, counts/hashes/sizes only). **Cursor `state.vscdb` parser is
  fast-follow, not slice B:** when built — read-only snapshot via SQLite backup API, `GLOB` never
  `LIKE`, `composerData:`=sessions, `bubbleId:`=messages, ~0.9% nonzero tokens →
  `partial`/`missing` coverage, model-label normalization, degrade gracefully on an inconsistent
  snapshot. Slice B ships Claude + Codex only; `source` is a dimension, so Cursor is purely additive.
- **Verify (cargo):** canary fixtures — Claude `message.id` collapse, Codex cumulative-token trap
  (session sum matches final `total_token_usage`), tool-pair fold; the **shared redaction canary
  corpus** (0a) is fully dropped/masked; **every `agent_file_events` path is repo-relative** (no
  `/Users/`, no `$HOME`, no username; a file outside the primary repo collapses to the `outside_repo`
  coarse category, never an absolute path), so a path-relativization bug fails here at 3a, not only at
  3d's end-to-end scan; **Codex turn-index determinism** — re-parsing the same Codex
  session does
  **not** renumber `message_pk` positional turn indices (stable pk across re-parse); no `cost_usd` on
  any fact. (Cursor `GLOB` index-plan canary lands with the fast-follow Cursor parser.)

### 3b — `collector-sync`

- **Files:** `packages/collector-sync/` (vendored from `otto-sync`; provenance/SPDX header per
  `otto-extraction-reference.md`).
- **Do:** Direct cursor reads/writes in local SQLite (Tauri SQL plugin schema, **not** a durable
  upload queue). Git remote resolve+freeze with a `cwd→remote` cache. `collector_started_at` + 24h
  grace on first run. History-import presets 7d/30d/1y. One-job-at-a-time orchestrator
  (`Watching/Syncing/Importing history/Paused/Error`). POST the envelope and handle every response
  variant. 5-min poll supplements the FSEvents watcher for Cursor.
- **Verify (cargo):** orchestrator state transitions; cursor advances only after a 2xx; git-remote
  freeze cache.

### 3c — `collector-api-client` + `collector-common`

- **Files:** `packages/collector-api-client/` (from `otto-api-client`), `packages/collector-common/`
  (from `otto-common`); both vendored, provenance/SPDX header per `otto-extraction-reference.md`.
- **Do:** Collector Credential sent in the `X-Trace-Flow-Collector-Secret` header (matching the 2b
  `agent-ingest` worker; not Otto Basic, not `Authorization: Bearer`), gzip the request body, retry
  only `policy_unavailable`. `collector-common`: paths incl. macOS Cursor dirs.
- **Verify (cargo):** auth header shape; gzip round-trip; retry only on `policy_unavailable`.

### 3d — Headless end-to-end run

Split into three leaves; the discovery scan is the production half the drive loop needs to be fed:

1. **Discovery — scan + selection (✅ landed):** `packages/collector-sync/src/discovery.rs` —
   `walk_transcripts` enumerates `.jsonl` under the root; `select_changed` narrows to in-window,
   new-or-changed files via the SQLite cursor (size + mtime + head-hash, otto's unchanged test). Pure,
   tempfile-unit-tested. No file opened except to confirm a head hash.
2. **Read + assemble (next):** read each selected file, resolve a `SessionContext` (git normalization
   via `resolve_git_metadata`/`GitRemoteCache`, parse Claude records for cwd/session-id/started-at/
   depth/head-sha, set `repo_root` for path relativization), assemble `SyncUnit { records, ctx,
next_cursor }` with `next_cursor = { mtime, byte_offset = size, content_hash_head = head_hash(text) }`.
3. **E2E (`#[ignore]`, live-infra STOP point):** integration test parses real `~/.claude/projects` →
   valid envelope → mock/real worker accepts → cursor advances. Needs `bun run dev:all` + the Tinybird
   dev workspace; stop and report if that infra is unreachable headlessly.

- **Verify (cargo):** no `cost_usd` on any fact; **no `agent_file_events` path contains `/Users/`**;
  real rows appear in `agent_*` via the Phase 1 pipes.

## Phase 4 — Dashboards

### 4a — Dashboard pages

- **Files:** `apps/web/src/app/app/...` (mirror `UsageAnalytics`/`OperationsAnalytics`, including its
  state handling).
- **Do:** New pages/components via `useTinybirdQuery` (Recharts + shadcn chart): failure leaderboard,
  period-over-period delta, session outliers (cost + file count), repo grouping (remote-backed vs
  Provisional), and a prominent **priced-token coverage %** + **"estimated cost"** labeling (not "$
  spent"). Define all four interaction states per surface — **LOADING** (skeleton), **EMPTY**,
  **ERROR** (pipe/JWT → retry), **PARTIAL** (coverage% banner) — mirroring `UsageAnalytics`. The
  **EMPTY** state reflects the **headless** slice-B path ("no agent activity yet") and must **not** CTA
  to the deferred desktop app.
- **Verify:** **smoke assertion, not "renders"** — given a pipe response each surface shows the
  expected rows **and** the coverage% field; LOADING/EMPTY/ERROR/PARTIAL each render for their
  condition; the EMPTY state has **no desktop-app CTA**; cost is labeled estimated.

### 4b — `org_id` agent JWT in web

- **Files:** `apps/web` (`useTinybirdQuery` / token flow).
- **Do:** Extend the token flow for the `org_id`-scoped agent JWT (Phase 2 `generateToken`).
- **Verify:** agent pipes authorize with the `org_id` JWT; tier gating clamps a hobby org to 7 days
  while pro sees the full window.

### 4c — Connected Desktops surface

> **Fast-follow, not slice B** — depends on the desktop app (Phase 5). Slice B syncs headless, so
> there are no "connected desktops" to list yet.

- **Files:** `apps/web` (new surface reading the `collectorCredentials` control plane).
- **Do:** Device label, platform, last seen, status, revoke. Never shows the secret; separate from
  the API Keys page.
- **Verify:** lists devices; revoking stops that device server-side **without** changing any
  `session_pk`/dedupe identity.

## Phase 5 — Trace Flow Desktop (Tauri)

> **Fast-follow, not slice B.** The desktop app is the distribution wrapper over the same
> `collector-*` packages; value is provable headless (3d) → dashboards (4a) without it. Phases 5–6
> are also **human-gated** (Apple signing certs, Stronghold review) and outside the autonomous
> driver's scope. The headless collector (Phase 3) already syncs real data; this packages it.

Per `trace-flow-desktop-collector.md`. Fresh Tauri id `com.traceflow.desktop`, **no** Otto state migration.

### 5a — Tauri desktop shell

- **Files:** `apps/desktop/` (new, `@trace-flow/desktop`; adapt Otto's `apps/desktop/src-tauri`,
  carrying the provenance/SPDX header per `otto-extraction-reference.md` for any vendored file).
- **Do:** Menu-bar/tray (status, last sync, source counts, pause/resume, run sync/backfill, recent
  errors, open logs, quit) + a small settings window (connect/login, source enable/disable + custom
  paths, autostart default-on, open dashboard; raw-upload toggle stubbed off).
- **Verify:** `tauri dev` on macOS; first-run shows detected sources + autostart; pause halts all
  local work.

### 5b — Connect + Stronghold credential

- **Files:** `apps/desktop` (connect flow, Stronghold integration).
- **Do:** Connect mints a hidden Collector Credential scoped to one org; secret stored in
  **Stronghold** (OS-keychain-protected); reconnect mints a replacement on unlock failure;
  credentials **never** via argv. Login does not auto-start sync; explicit **"Start syncing"** gates
  first egress.
- **Verify:** no egress until "Start syncing"; survives quit/relaunch via autostart; disconnect
  revokes + clears Stronghold while keeping the non-secret SQLite.

### 5c — Notifications + diagnostics

- **Files:** `apps/desktop` (notifications, diagnostics export).
- **Do:** Quiet-by-default notifications (action-required only, no persistent success banners);
  sanitized diagnostics export (no transcripts/excerpts/secrets/absolute paths).
- **Verify:** no success banners; diagnostics export contains no transcript/secret/absolute path.

## Phase 6 — Desktop CI + release (macOS arm64)

> **Fast-follow, not slice B** — packages and signs Phase 5. Human-gated (signing secrets) and
> outside the autonomous driver's scope.

### 6a — Collector CI job

- **Files:** `.github/workflows/ci.yml`.
- **Do:** Add a `collector` job (`cargo test/clippy/fmt` on the workspace, excluding the Tauri crate
  from headless CI).
- **Verify:** PR CI green; the cargo job runs on the workspace.

### 6b — macOS arm64 signed release

- **Files:** `.github/workflows/desktop-release.yml` (new; adapt Otto's).
- **Do:** `workflow_dispatch`; signed `aarch64-apple-darwin` DMG + app tarball, updater manifest
  `traceflow-desktop-latest.json`, signed prompted updates, independent SemVer
  (`traceflow-desktop-v{version}`). Windows x64 matrix entry scaffolded but **commented**; Apple +
  Tauri signing secrets configured in GitHub.
- **Verify:** a manual release produces a signed installable build that auto-update-prompts against
  the manifest; updates do not interrupt an active sync.

---

## Deferred (documented, not built here)

- **Raw transcript replay**: opt-in gzip bundle → Tenant-Key encryption → R2 `agent-transcripts/…`
  (90-day lifecycle) → `STORAGE_BUDGET` Durable Object reservation → server replay loop. The
  `raw_upload_requested` flag and `RawSessionBundle` slot stay plumbed so this is additive.
- **Windows x64** packaging/signing (workflow entry already scaffolded).
- **Provider usage / codexbar** (`provider-usage-tracking.md`): separate feature, separate ingest scope.
- Context Bloat/Rot metrics (data retained via `agent_capability_snapshots`, analysis deferred),
  multi-repo/multi-PR split-cost, the Project Convex entity, materialized-rollup hardening.

## Watch-items

- **Namespace 2006** — document the registry to avoid the next clash (2001–2005 already taken).
- **Codex positional `message_pk`** is the weakest dedupe key; surface as provisional, no surrogate backstop.
- **Cursor `state.vscdb`** is the largest net-new parse and the most schema-fragile; guard with
  `parser_version` + canary fixtures; never touch the live DB; leave `agentKv:` blobs unparsed.
- **Rollup correctness**: COPY `replace` over complete buckets, never MV append; any `EventAt`
  correction needs an affected-partition rebuild before replay.
- **`agent_sessions` whole-table rebuild**: unlike the time-bucketed `agent_usage_*` rollups,
  `agent_sessions` is keyed per session, so `COPY_MODE replace` re-swaps the entire table every cycle
  and its cost scales with total session count, not the recent window. This is why 1c starts
  `COPY_SCHEDULE` at hourly, not the proxy's 10-min. If the cycle time creeps under load, partition
  the target on a coarse bucket (e.g. session-start month) so `replace` can target partitions, or move
  it incremental. Revisit before the table is large, not after.
- **Stronghold unlock UX** and macOS FSEvents missing atomic renames (mitigated by the 5-min poll).
- **models.dev first-party pinning** is mandatory or models silently mis-price.

## v1 slice complete when (slice B — the autonomous milestone)

This is the bar the driver builds to (tasks `0a 0b 0c 0d · 1a 1b 1c 1d · 2a 2b 2c 2d 2e 2f 2g · 3a 3b
3c 3d · 4a 4b`). Verifiable outcomes:

- A **Claude** and a **Codex** session each parse to deduped, server-priced typed facts in `agent_*`
  for the owning org, filterable by `source` and `repo_fingerprint`; subagent transcripts attach to
  the parent `session_pk` with `agent_depth>0`; the only Nullable column is `cost_usd`; **no stored
  file path contains a home dir or username** (3d asserts no `/Users/`).
- `agent_priced_usage` (1c) is the **sole** subagent-dedup runtime; re-syncing a session never
  inflates counts (`FINAL` stable, proven by the 2c constant-cost fixture); a cross-user re-upload is
  rejected as `session_owner_conflict`.
- **Every ingest/consumer failure path is named, tested, and logged** — Convex-down→503 (not
  drop/202), `AGENT_QUEUE.send` fail→5xx (never 202), malformed→DLQ, Tinybird-insert fail→retry→DLQ,
  pricing-unavailable→`cost_usd` null, `models.dev` regression→coverage% alert. No silent drops.
- The **three launch queries** (failure leaderboard, period delta, session outliers) render with
  coverage % + "estimated cost" labeling and **all four** LOADING/EMPTY/ERROR/PARTIAL states; the
  `org_id` JWT authorizes and tier-gates (hobby 7d, pro full window); the EMPTY state has **no
  desktop-app CTA** (slice B is headless).
- **Observability live (2f):** DLQ-non-empty, consumer-error-rate, and priced-coverage% alerts fire
  on their conditions; the DLQ-drain runbook names the manual `tb`/`wrangler` teardown a `git revert`
  does not perform.
- Both workers reach dev **only after 2e** wires the full path and lifts the 0d deploy-gate; a `main`
  merge before 2e leaves them inert (deploy-safe), per the autonomous self-merge model.
- **The build's own safety nets hold:** the `agent_*` schema is live on dev before 2e lifts the gate
  (1d), and every new TS package (`agent-ingest`, `agent-consumer`, `pricing`) is gated by PR CI with
  a typed job in the `status` check (2g), so a type or test failure in new code red-X's the PR instead
  of slipping through to a post-merge deploy.

## Feature complete when (full feature — adds the fast-follow)

Everything in the v1 slice, plus the deferred work added back on top of the source-agnostic pipeline:

- A **Cursor** session also parses to the same `agent_*` facts (parser-only change; `source` is a
  dimension), filterable alongside Claude and Codex.
- **Connected Desktops** (4c) lists/revokes devices without exposing secrets or fragmenting identity.
- Trace Flow Desktop installs on macOS arm64, connects with a hidden Stronghold-stored credential,
  gates first egress behind "Start syncing," then watches and syncs across relaunch. A signed,
  auto-updating build ships from `workflow_dispatch`.
