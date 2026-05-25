# Roadmap & Status Board

Claimable tasks for Agent Conversation Analytics. See [`README.md`](./README.md) for the coordination
protocol. The ADR ([`agent-conversation-analytics.md`](../../adr/agent-conversation-analytics.md)) is
the design source of truth — **column lists, engines, and identity rules live there**, not here.

Status legend: `☐ todo` · `🚧 <branch>` · `✅ done` · `⛔ blocked`

## Board

| ID  | Task                                        | Status | Depends on     |
| --- | ------------------------------------------- | ------ | -------------- |
| 0a  | Wire contract + Rust mirror                 | ☐ todo | —              |
| 0b  | Rust workspace scaffold                     | ☐ todo | —              |
| 0c  | `@trace-flow/pricing` package               | ☐ todo | —              |
| 1a  | 9 `agent_*` datasources                     | ☐ todo | 0a             |
| 1b  | Launch-query pipes                          | ☐ todo | 1a             |
| 1c  | COPY rollup pipes                           | ☐ todo | 1a             |
| 2a  | Convex control plane                        | ☐ todo | 0a             |
| 2b  | `apps/agent-ingest` worker                  | ☐ todo | 0a, 2a         |
| 2c  | `apps/agent-consumer` worker                | ☐ todo | 0c, 1a, 2b     |
| 2d  | models.dev pricing import                   | ☐ todo | 0c             |
| 2e  | Wrangler / dev wiring                       | ☐ todo | 2b, 2c         |
| 3a  | `collector-parser`                          | ☐ todo | 0a             |
| 3b  | `collector-sync`                            | ☐ todo | 0a, 3a         |
| 3c  | `collector-api-client` + `collector-common` | ☐ todo | 0a             |
| 3d  | Headless end-to-end run                     | ☐ todo | 2e, 3a, 3b, 3c |
| 4a  | Dashboard pages                             | ☐ todo | 1b, 2a         |
| 4b  | `org_id` agent JWT in web                   | ☐ todo | 2a             |
| 4c  | Connected Desktops surface                  | ☐ todo | 2a             |
| 5a  | Tauri desktop shell                         | ☐ todo | 3d             |
| 5b  | Connect + Stronghold credential             | ☐ todo | 3d, 5a         |
| 5c  | Notifications + diagnostics                 | ☐ todo | 5a             |
| 6a  | Collector CI job                            | ☐ todo | 0b             |
| 6b  | macOS arm64 signed release                  | ☐ todo | 5b             |

---

## Phase 0 — Contract & foundations

Locks the seam between the Rust collector and the TS backend so later phases proceed in parallel.

### 0a — Wire contract + Rust mirror

- **Files:** `packages/types/src/agent-ingest.ts` (new, mirror `packages/types/src/queue.ts`);
  `packages/collector-contracts/` (new Rust crate).
- **Do:** Define `AgentIngestEnvelope` (`batch{source, collector_batch_id, desktop_version,
parser_version, raw_upload_requested}`, `facts{messages[], tool_events[], file_events[],
capability_snapshots[], pull_request_links[]}`) and the typed `Agent*Fact` shapes. The collector
  sends vendor IDs, timestamps, tokens, model, redaction counters, normalized git remote string —
  **never** OrgId/UserId/cost/final `*_pk`. Also define `AgentIngestQueueMessage` (worker → consumer,
  carries the assembled `*_pk`). Rust mirror with serde renames matching the JSON exactly; keep both
  in lockstep. Explicit named types, no `Partial<>` chains.
- **Verify:** `bun run type-check`; a Rust round-trip fixture test serializes an envelope in Rust and
  deserializes it against the TS shape (guards drift).

### 0b — Rust workspace scaffold

- **Files:** `Cargo.toml` (repo root, new).
- **Do:** Root `Cargo.toml` with members `packages/collector-*` (and `apps/desktop/src-tauri` once
  Phase 5 scaffolds it). Turborepo does **not** manage Cargo — keep cargo builds out of the Turbo
  graph; a dedicated CI job (6a) runs `cargo` directly.
- **Verify:** `cargo metadata` resolves the workspace; `cargo fmt --check` and `clippy` are clean.

### 0c — `@trace-flow/pricing` package

- **Files:** `packages/pricing/` (new); extract from `apps/proxy-consumer/src/pricing.ts`.
- **Do:** Move the server-side cost chain into `packages/pricing` (used by both consumers). Add
  `gpt-5.5` context-tier awareness (~2x above 200k context) and the canonical `buildPricedUsageView`
  rule for **Agent Session Authoring Cost**: count nested/sidechain message usage; count tool-result
  subagent usage **only when no matching sidechain message exists** (avoid double counting).
- **Verify:** `packages/pricing` unit tests cover the subagent reconciliation fixtures (double-count
  avoided; fallback-only marked `fallback`); `proxy-consumer` still type-checks against the extract.

## Phase 1 — Tinybird data layer

Verifiable with synthetic rows alone. Columns/engines per ADR "Data model" + "Table physics".

### 1a — 9 `agent_*` datasources

- **Files:** `datasources/agent_messages.datasource`, `agent_tool_events`, `agent_file_events`,
  `agent_capability_snapshots`, `agent_pull_request_links`, `agent_sessions`, `agent_usage_1h`,
  `agent_usage_1d`, `agent_tool_usage_1h`. Mirror `datasources/llm_requests.datasource`.
- **Do:** Base facts → `ReplacingMergeTree(IngestedAt)`, sorting key `OrgId, session_pk, <row>_pk`,
  partition `toYYYYMMDD(EventAt)`, TTL `EventAt + 1 YEAR`. Event timestamps (`EventAt`, `IngestedAt`,
  `LastEventAt`, `StartedAt`, `VendorStartedAt`) are `DateTime64(3)` (not `llm_requests`' Int64
  epoch-nanos: agent facts are parsed transcripts with no ns source), so partition/TTL read the
  column directly with no `/1e9`. `agent_sessions` is **rebuilt from base `FINAL`** via the canonical
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
  `pipes/agent_session_outliers.pipe`. Mirror `pipes/llm_usage_summary.pipe`.
- **Do:** Query base `FINAL` (query-time first). `failure_rate` **excludes** `unknown` status.
- **Verify:** `tb build`; each pipe returns expected rows against synthetic data; `failure_rate`
  excludes `unknown`.

### 1c — COPY rollup pipes

- **Files:** `pipes/agent_priced_usage.pipe` (canonical priced-usage view: applies the subagent
  dedup rule once), `pipes/agent_sessions_copy.pipe`, `pipes/agent_usage_1h_copy.pipe`,
  `agent_usage_1d_copy.pipe`, `agent_tool_usage_1h_copy.pipe`. Mirror `pipes/llm_usage_1h_copy.pipe`.
- **Do:** `COPY_MODE replace` reading base `FINAL` (whole-target swap, **not** materialized-view
  append, which hits the ReplacingMergeTree retraction trap). `agent_sessions`, `agent_usage_*`, and
  PR cost all read `agent_priced_usage`, so the subagent-dedup rule lives in one place and they agree
  by construction. Optimization layer over 1b. Tune `COPY_SCHEDULE` for a one-year base scan (less
  frequent than the proxy's 10-min cadence); do not copy the proxy cadence verbatim.
- **Verify:** `tb build`; COPY populates each target; re-running replaces (no double count); a session
  whose facts span two `EventAt` days yields exactly **one** `agent_sessions` row after rebuild.

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
  fixed-param path in `generateToken` (diverges from `api_keys`). Dev only: `bunx convex dev --once`.
- **Verify:** `bunx convex dev --once`; `bunx convex run collectorCredentials:mint …` returns a test
  secret; credential absent from `apiKeys.list`; `generateToken` emits the `org_id` fixed_param.

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
- **Verify:** curl a synthetic `AgentIngestEnvelope` → 202; assert 401 (no cred), 429 (over limit),
  413 (oversized), `upgrade_required` (bump min version), `session_owner_conflict` (second user,
  same session).

### 2c — `apps/agent-consumer` worker

- **Files:** `apps/agent-consumer/` (new, stateless, **NO** batching DO);
  `packages/tinybird-client/` (factor `insertIntoTinybird` out of `apps/proxy-consumer/src/tinybird.ts`).
- **Do:** Read `AGENT_QUEUE`, price each message via `@trace-flow/pricing` from tokens+model (KV
  catalog), one batched insert per **base** datasource reusing `insertIntoTinybird`. The consumer
  writes base facts only (per-message `cost_usd`, etc.); it does **not** compute or insert
  `agent_sessions` or the rollups. Session cost, hourly/daily usage, and PR cost are derived in
  Tinybird from `agent_priced_usage` (1c), so the subagent-dedup rule lives in exactly one place.
  `cost_usd` null when token coverage is missing or the model is unpriced.
- **Verify:** queue → consumer → priced rows in `agent_messages FINAL`; rebuild `agent_sessions` and
  confirm its cost matches a hand-summed `agent_priced_usage` for the session; re-post an identical
  envelope, base `FINAL` counts unchanged; unpriced model → `cost_usd` null.

### 2d — models.dev pricing import

- **Files:** `packages/convex/billing/modelPricing.ts`, `packages/convex/schema.ts` (enum), pricing types.
- **Do:** `importFromModelsDev` (mirror `importFromOpenRouter`), daily cron, **first-party
  `anthropic`/`openai` entries ONLY** (skip ~25 gateway re-listings), `gpt-5.5` tier rates,
  `codex-auto-review`/Cursor house-model normalization, `source='models.dev'` added to the enum.
- **Verify:** `bunx convex dev --once`; import populates first-party rows only; `gpt-5.5` tier rates present.

### 2e — Wrangler / dev wiring

- **Files:** `apps/agent-ingest/wrangler.jsonc`, `apps/agent-consumer/wrangler.jsonc`, root dev scripts.
- **Do:** New `AGENT_QUEUE` + DLQ, `COLLECTOR_CREDS` KV, `AGENT_INGEST_LIMITER` (2006); add both
  workers to `dev:all` with the shared `--persist-to`. Queue consumers only connect under `bun run dev:all`.
- **Verify:** `bun run dev:all` boots both workers; an envelope flows ingest → queue → consumer
  locally; shared `--persist-to` makes KV/queue visible across workers.

## Phase 3 — Headless Rust collector

Vendors and refactors Otto's working code (`~/src/otto` read-only; see `otto-extraction-reference.md`).
Build and test headless against fixtures + the real local stores + the Phase 2 worker, before any UI.

### 3a — `collector-parser`

- **Files:** `packages/collector-parser/` (from `otto-parser`).
- **Do:** Strip local pricing (ship tokens+model only). Claude: collapse repeated `message.usage` by
  `message.id`. Codex: sum `last_token_usage` deltas, **NEVER** `total_token_usage` (the ~331x trap).
  Fold tool-use + tool-result (same `tool_use_id`) into ONE Tool Event. Reuse `redaction.rs` with
  drop-not-upload + counters. Emit Capability Snapshots (Codex `base_instructions`/`dynamic_tools`,
  counts/hashes/sizes only). **Net-new Cursor `state.vscdb` parser:** read-only snapshot via SQLite
  backup API, `GLOB` never `LIKE`, `composerData:`=sessions, `bubbleId:`=messages, ~0.9% nonzero
  tokens → `partial`/`missing` coverage, model-label normalization, degrade gracefully on an
  inconsistent snapshot.
- **Verify (cargo):** canary fixtures — Claude `message.id` collapse, Codex cumulative-token trap
  (session sum matches final `total_token_usage`), tool-pair fold, Cursor `GLOB` index plan; no
  `cost_usd` on any fact.

### 3b — `collector-sync`

- **Files:** `packages/collector-sync/` (from `otto-sync`).
- **Do:** Direct cursor reads/writes in local SQLite (Tauri SQL plugin schema, **not** a durable
  upload queue). Git remote resolve+freeze with a `cwd→remote` cache. `collector_started_at` + 24h
  grace on first run. History-import presets 7d/30d/1y. One-job-at-a-time orchestrator
  (`Watching/Syncing/Importing history/Paused/Error`). POST the envelope and handle every response
  variant. 5-min poll supplements the FSEvents watcher for Cursor.
- **Verify (cargo):** orchestrator state transitions; cursor advances only after a 2xx; git-remote
  freeze cache.

### 3c — `collector-api-client` + `collector-common`

- **Files:** `packages/collector-api-client/` (from `otto-api-client`), `packages/collector-common/`
  (from `otto-common`).
- **Do:** `Bearer` Collector Credential (not Otto Basic), gzip, retry only `policy_unavailable`.
  `collector-common`: paths incl. macOS Cursor dirs.
- **Verify (cargo):** auth header shape; gzip round-trip; retry only on `policy_unavailable`.

### 3d — Headless end-to-end run

- **Files:** integration test crate / `#[ignore]` E2E.
- **Do:** Run the headless binary against the live corpus. `#[ignore]` E2E parses real
  `~/.claude/projects` → valid envelope → mock/real worker accepts → cursor advances.
- **Verify (cargo):** no `cost_usd` on any fact; **no `agent_file_events` path contains `/Users/`**;
  real rows appear in `agent_*` via the Phase 1 pipes.

## Phase 4 — Dashboards

### 4a — Dashboard pages

- **Files:** `apps/web/src/app/app/...` (mirror `UsageAnalytics`/`OperationsAnalytics`).
- **Do:** New pages/components via `useTinybirdQuery` (Recharts + shadcn chart): failure leaderboard,
  period-over-period delta, session outliers (cost + file count), repo grouping (remote-backed vs
  Provisional), and a prominent **priced-token coverage %** + **"estimated cost"** labeling (not "$ spent").
- **Verify:** each page renders against real data; coverage % shown; cost labeled estimated.

### 4b — `org_id` agent JWT in web

- **Files:** `apps/web` (`useTinybirdQuery` / token flow).
- **Do:** Extend the token flow for the `org_id`-scoped agent JWT (Phase 2 `generateToken`).
- **Verify:** agent pipes authorize with the `org_id` JWT; tier gating clamps a hobby org to 7 days
  while pro sees the full window.

### 4c — Connected Desktops surface

- **Files:** `apps/web` (new surface reading the `collectorCredentials` control plane).
- **Do:** Device label, platform, last seen, status, revoke. Never shows the secret; separate from
  the API Keys page.
- **Verify:** lists devices; revoking stops that device server-side **without** changing any
  `session_pk`/dedupe identity.

## Phase 5 — Trace Flow Desktop (Tauri)

Per `trace-flow-desktop-collector.md`. Fresh Tauri id `com.traceflow.desktop`, **no** Otto state migration.

### 5a — Tauri desktop shell

- **Files:** `apps/desktop/` (new, `@trace-flow/desktop`; adapt Otto's `apps/desktop/src-tauri`).
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
- **Stronghold unlock UX** and macOS FSEvents missing atomic renames (mitigated by the 5-min poll).
- **models.dev first-party pinning** is mandatory or models silently mis-price.

## Feature complete when

- A Claude, a Codex, and a Cursor session each parse to deduped, server-priced typed facts in
  `agent_*` for the owning org, filterable by `source` and `repo_fingerprint`; subagent transcripts
  attach to the parent `session_pk` with `agent_depth>0`; the only Nullable column is `cost_usd`;
  no stored file path contains a home dir or username.
- The three launch queries render in the dashboard with coverage % and estimated-cost labeling; tier
  gating clamps visibility; Connected Desktops lists/revokes devices without exposing secrets or
  fragmenting identity.
- Trace Flow Desktop installs on macOS arm64, connects with a hidden Stronghold-stored credential,
  gates first egress behind "Start syncing," then watches and syncs across relaunch; re-syncing a
  session never inflates counts (`FINAL` stable); a cross-user re-upload is rejected as
  `session_owner_conflict`. A signed, auto-updating build ships from `workflow_dispatch`.
