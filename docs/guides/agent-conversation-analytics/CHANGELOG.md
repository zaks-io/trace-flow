# Changelog

Append-only progress log. **Newest entry on top** so parallel PRs merge without conflicts. One entry
per working session or task hand-off. Copy the template.

## Template

```text
## YYYY-MM-DD — <task IDs> — <branch or agent>
**Status:** ✅ done | 🚧 in progress | ⛔ blocked
**Changed:** what landed (files, behavior)
**Verified:** command(s) run + result
**Next / blockers:** handoff for the next agent
```

---

## 2026-05-27 — 3d (`collector-sync`: git remote normalizer — leaf 2b-i) — t3code/ab83918d

**Status:** 🚧 in progress (3d leaf 2b split; this is leaf 2b-i, the pure normalizer)
**Changed:** Added `packages/collector-sync/src/git_remote.rs` + `pub mod` / re-export. Pure, no I/O.

- **`normalize_git_remote(raw) -> String`** canonicalizes whatever `git config remote.origin.url`
  reports — scp-like (`git@host:owner/repo.git`), `https://`, `ssh://` (incl. explicit port), `git://`,
  with optional `user@`/`user:token@` — into one stable `host/owner/repo`. Two clones of the same repo
  over different transports collapse to the **identical** string, so the ingest Worker's repo
  fingerprint can't split them into phantom repos. Host is lowercased (DNS is case-insensitive); the
  owner/repo path case is preserved; the `.git` suffix and surrounding slashes are stripped.
- **Unparseable / pathless remote → `""`**, which downstream reads as "no remote" so the session falls
  back to its path label rather than fingerprinting garbage. A flat single-segment server path
  (`host/repo.git`) is kept — that's a real repo, not garbage.
- **scp parsing strips `user@` before the host:path colon**, so an embedded `user:token@` can't be
  mistaken for the host separator. No panics on arbitrary input (every split/strip returns `Option`).
- Original Trace Flow code: otto-sync stored the raw remote and never normalized one (no otto
  equivalent). SPDX MIT + provenance header.

**Verified:** `cargo fmt --check -p collector-sync`; `cargo clippy -p collector-sync --all-targets -- -D
warnings` (clean); `cargo test -p collector-sync` = **60 passed** (7 git_remote tests: transport
equivalence incl. scp subgroup, host-lowercase/path-preserve, multi-segment subgroups, flat
single-segment server, trailing-slash/whitespace trim, embedded-userinfo misfire guard, unparseable →
`""`); `cargo build`. Local code-review (code-reviewer subagent, sonnet): CHANGES REQUESTED on pass 1
(scp `user:token@host:path` misfire — fixed by stripping userinfo before the colon split; plus added
tests), then READY TO LAND on a fresh confirmation pass.
**Next / blockers:** 3d leaf 2b-ii — the async read + assemble: read each selected file (JSONL →
`Vec<Value>`, skip blank/malformed lines so one bad record can't strand a session), resolve git via
`GitRemoteCache::resolve(cwd).await` + `normalize_git_remote`, build a `SessionContext` (2a's fields +
`repo_root` from the git root, `repo_path_fallback`, `git_branch` with 2a's hint as fallback,
`agent_id`/`git_head_sha` = `""` since neither is available headlessly), and assemble `SyncUnit {
records, ctx, next_cursor }` with `next_cursor.content_hash_head = head_hash(full_text)` so the cursor
matches discovery's `read_head_hash` next scan. Then leaf 3 — the `#[ignore]` E2E against real
`~/.claude/projects` + live worker + Tinybird rows (needs `bun run dev:all` + the Tinybird dev
workspace; STOP point if unreachable headlessly). 3d stays 🚧 until all leaves land; only then is the
Phase 3 boundary reached (PR to `main`, no self-merge).

---

## 2026-05-27 — 3d (`collector-sync`: Claude session-field extraction — leaf 2a) — t3code/ab83918d

**Status:** 🚧 in progress (3d leaf 2 split again; this is leaf 2a, the pure record-reading half)
**Changed:** Added `packages/collector-sync/src/claude_session.rs` + `pub mod` / re-exports. The
record-reading half of building a session's `SessionContext` — it reads only the records, no git, no
filesystem.

- **`claude_session_fields(records) -> ClaudeSessionFields`** pulls the per-session identity a Claude
  transcript repeats on every line: `vendor_session_id` (`sessionId`), `vendor_started_at` (the
  **earliest** parseable `timestamp`, so an undated leading record or out-of-order file still yields the
  true start), `cwd`, and a `git_branch` hint (`gitBranch`). Field names confirmed against otto-parser's
  Claude parser; `vendor_started_at` reuses the parser's `rfc3339_to_epoch_ms` (no new `chrono` dep).
- **First-non-empty wins** for the repeated string fields (trimmed; blank/whitespace skipped), matching
  the git freeze cache's first-`cwd` key. Absent values degrade to `None`/`""` — the ingest Worker
  resolves the final `*_pk`, never this layer.
- **`agent_depth_from_transcript_path(path) -> i64`** gives whole-file nesting depth: `1` under a
  `subagents/` path segment (exact-segment match, not substring), else `0`. Capped at 1 per the current
  Claude layout; the E2E leaf confirms deeper nesting if it exists.
- Pure and sync (no filesystem, no git); the async git resolve + remote normalization + `SyncUnit`
  assembly that consume these fields are leaf 2b.

**Verified:** `cargo fmt --check -p collector-sync`; `cargo clippy -p collector-sync --all-targets -- -D
warnings` (clean); `cargo test -p collector-sync` = **53 passed** (6 new claude_session tests:
all-fields extraction, earliest-timestamp-regardless-of-order, empty-slice defaults, blank-string skip,
unparseable-timestamp skip, top-level-vs-subagents depth); `cargo build`. Local code-review
(code-reviewer subagent, sonnet) → READY TO LAND over two passes (no P1/P2; added an
intentional-depth-cap comment between passes).
**Next / blockers:** 3d leaf 2b — read each selected file (JSONL → `Vec<Value>`), resolve git via
`GitRemoteCache`/`resolve_git_metadata`, normalize the remote into `normalized_git_remote`, set
`repo_root`/`repo_path_fallback`/`git_branch` (falling back to 2a's hint), assemble `SessionContext` +
`SyncUnit { records, ctx, next_cursor }` with `next_cursor.content_hash_head = head_hash(full_text)`.
(`GitMetadata` carries no head SHA and the Claude record has none either, so `git_head_sha` stays `""`
unless 2b extends git resolution.) Then leaf 3 — the `#[ignore]` E2E against real `~/.claude/projects` +
live worker + Tinybird rows, which needs `bun run dev:all` + the Tinybird dev workspace and is a STOP
point if unreachable headlessly. 3d stays 🚧 until all leaves land; only then is the Phase 3 boundary
reached (PR to `main`, no self-merge).

---

## 2026-05-27 — 3d (`collector-sync`: transcript discovery — scan/selection leaf) — t3code/ab83918d

**Status:** 🚧 in progress (3d split into 3 leaves; this is leaf 1 of 3)
**Changed:** Added `packages/collector-sync/src/discovery.rs` (the scan + selection half of 3d) +
`pub mod` / re-exports. This is the production layer the landed drive loop assumes — it prepares the
`SyncUnit` inputs (which files to read), without the read/parse yet.

- **`walk_transcripts(root)`** recursively enumerates and stats every `.jsonl` under the transcript
  root (`walkdir`, no symlink-follow), sorted oldest-mtime-then-path so a partial pass makes
  deterministic progress. A missing root → empty (normal first-run). Unreadable/unstattable entries
  are skipped, not fatal — they reappear next scan.
- **`select_changed(files, store, source, window)`** drops files outside the `ImportWindow`, then keeps
  only those new-or-changed vs their SQLite `FileCursor` using otto's unchanged test: skip iff cursor
  exists **and** `size == byte_offset` **and** mtime not newer **and** head-hash non-empty and matches.
  An in-place rewrite that preserved size+mtime is still caught by the head hash.
- **Whole-file model (ADR / otto).** `byte_offset` = file size at last ingest, not an incremental
  offset; a changed file is re-read in full and server-side `ReplacingMergeTree` dedupe absorbs the
  repeat. `head_hash(text)` (`"sha256:"` + hex of SHA-256 of the first 4096 chars) is the public
  fingerprint the next leaf writes into the cursor; `read_head_hash` reads only the worst-case byte
  budget (4096×4) so the in-memory and on-disk hashes provably match for identical content.
- **Error asymmetry.** Only a `CursorStoreError` (broken local DB) aborts selection; an unreadable head
  degrades to "treat as changed" (re-read) — a wrong skip would drop data, a lost skip is harmless.
- **Sync I/O** to match the synchronous `CursorStore`; adapted from otto-sync `files.rs`/`engine.rs`
  (SPDX MIT + provenance header), pricing/provider_usage deliberately not carried over.
- **Deps.** Added `walkdir = "2"` (recursive walk) and `sha2 = "0.10"` (head-hash, same convention as
  `collector-parser`) to `[dependencies]`.

**Verified:** `cargo fmt --check -p collector-sync`; `cargo clippy -p collector-sync --all-targets -- -D
warnings` (clean); `cargo test -p collector-sync` = **47 passed** (9 new discovery tests: nested-walk
filtering, missing-root, no-cursor/unchanged/grown/newer-mtime/in-place-rewrite selection, window
drop-before-cursor-check, in-memory-vs-disk hash parity); `cargo build` (workspace). Local code-review
(code-reviewer subagent, sonnet) → READY TO LAND over two passes (no P1/P2; added a `>`-not-`>=` mtime
comment between passes).
**Next / blockers:** 3d leaf 2 — read + `SessionContext` resolve (git normalization + Claude record
parse for cwd/session-id/started-at/depth/head-sha + `repo_root` for redaction) + `SyncUnit` assembly.
Then leaf 3 — the `#[ignore]` E2E against real `~/.claude/projects` + live worker + Tinybird rows; that
needs `bun run dev:all` + the Tinybird dev workspace and is a STOP point if unreachable headlessly. 3d
stays 🚧 until all three land; only then is the Phase 3 boundary reached (PR to `main`, no self-merge).

---

## 2026-05-27 — 3b (`collector-sync`: drive loop — 3b COMPLETE) — t3code/ab83918d

**Status:** ✅ done (closes 3b)
**Changed:** Added `packages/collector-sync/src/sync_cycle.rs` (the async drive loop) + `pub mod` /
re-exports. Fifth and final leaf of 3b: it composes the four landed leaves into one sync cycle.

- **`run_sync_cycle(client, store, orchestrator, meta, units, mint_batch_id, cancel)`** iterates a
  batch of `SyncUnit`s; for each it calls `collector-parser::session_facts(meta.source, records, ctx)`,
  wraps the facts with the landed `build_envelope(...)`, POSTs via the 3c client, and **advances the
  SQLite cursor only on `Ok(IngestOk)`** — every error path leaves the cursor untouched so the file
  re-sends next cycle (ADR cursor discipline). `CursorStoreError` propagates, never swallowed.
- **Client trait seam.** `IngestClient` is the one-method (`ingest`) trait the loop needs; the real
  `CollectorApiClient` implements it by delegating, and tests inject a scripted mock — no network.
- **One terminal orchestrator trigger per cycle** (not per file): `JobSucceeded` only when nothing
  failed and the cycle wasn't aborted, else `JobFailed`. A cancelled cycle is **not** a success.
- **Error classification.** `is_cycle_fatal` (Unauthorized / UpgradeRequired / RateLimited) aborts the
  cycle early — those reject every remaining POST; per-envelope failures strand only their own unit.
- **Deps.** Promoted `serde_json` to a real dep (records are `Vec<Value>`); added `collector-parser`,
  `collector-api-client`, `tokio-util` (CancellationToken); dev-dep `tokio` `rt` for `#[tokio::test]`
  (production tokio stays watcher-only: `process` + `macros`, no `rt`).

**Verified:** `cargo fmt --check -p collector-sync`; `cargo clippy -p collector-sync --all-targets -- -D
warnings` (clean); `cargo test -p collector-sync` = **38 passed** (6 new sync_cycle tests: advances on
Ok, does not advance on Err, retried-then-Ok advances, mixed batch advances only accepted units,
cycle-fatal aborts the rest, cancelled cycle fails the job); `cargo build` clean. Local code-review
(code-reviewer subagent, sonnet) reached **READY TO LAND** after two passes — initial CHANGES
REQUESTED on a P1 (a cancelled cycle dishonestly emitted `JobSucceeded`; fixed via the `aborted_early`
gate) plus two P2 comment/test-consistency items, confirmation pass clean. CodeRabbit not escalated
(no auth/secret/schema/redaction/proxy-streaming surface — pure local sync logic; rubric miss).

**Next / blockers:** 3b ✅ — the `collector-sync` crate is feature-complete for headless use. Next is
**3d** (headless end-to-end run): wire the real `CollectorApiClient` + a real filesystem watcher +
on-disk `CursorStore`, drive `run_sync_cycle` against the dev ingest worker, and confirm a transcript
round-trips to Tinybird. Once 3d lands, the Phase 3 boundary (3a✅, 3b✅, 3c✅, 3d✅) is reached →
open a PR to `main` (never self-merge). Not a boundary yet, so no PR.

## 2026-05-27 — 3b (`collector-sync`: import-window policy + envelope assembler, partial) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-sync/src/import.rs` and `src/envelope.rs` (+ `pub mod` and
re-exports; dev-dep `serde_json`). Fourth leaf of 3b — the two **pure** halves of the upload path.
Split from the POST loop deliberately: these are deterministic and unit-testable with no async,
client, or store; the drive loop that ties them together is the next (final) leaf.

- **`import.rs` — sync-window policy.** `ImportWindow` carries one epoch-ms mtime cutoff and answers
  `includes(mtime: f64)` as an inclusive lower bound. `first_incremental(collector_started_at)` =
  start − 24h, the ADR active-session grace window that catches in-progress sessions at install
  without making first run a historical import (ADR first-run setup). `history(preset, now)` =
  now − preset. `HistoryPreset` is exactly `Last7Days` / `Last30Days` / `LastYear` — **no "all
  history"** option (ADR: the 1-year preset is the fact-retention horizon). One `MS_PER_DAY` constant;
  `GRACE_WINDOW_MS` is derived from it so they can't drift (review fix).
- **`envelope.rs` — POST envelope assembler.** `BatchMeta` (source, desktop/parser version,
  raw_upload_requested) + `build_envelope(meta, collector_batch_id, facts)` wraps a session's
  `AgentIngestFacts` into the canonical `AgentIngestEnvelope`. The batch id is caller-supplied (the
  drive loop mints one per POST), not generated here. `raw_session_bundles` is always `None` (raw
  upload is opt-in/default-off and unbuilt). No contract field invented or omitted (checked field-by-
  field against `collector-contracts`).

**Verified:** `cargo fmt --check -p collector-sync`; `cargo clippy -p collector-sync --all-targets -D
warnings` (clean); `cargo test -p collector-sync` = **32 passed** (7 new: grace cutoff, in-progress
vs older, inclusive bound, three preset distances, year-vs-grace ordering, envelope field-stamping,
raw-bundle wire-omission). Files: import.rs 135, envelope.rs 82. Local `code-review`: initial
**CHANGES REQUESTED** (1 P2: two identical `GRACE_WINDOW_MS`/`DAY_MS` constants — drift risk; 2 P3) →
derived the grace window from a single `MS_PER_DAY`, reworded the `skip_serializing_if` comment,
declined a speculative `Hash` derive → confirmation review **READY TO LAND**. CodeRabbit not escalated
(pure value types, no auth/secret/schema/redaction/concurrency surface; rubric does not require it).

**Next / blockers:** 3b stays 🚧 — **last leaf**: the async drive loop. Per session: `session_facts(…)`
→ `build_envelope(…)` → `CollectorApiClient::ingest(envelope, cancel)` → on `Ok(IngestOk)` advance the
`CursorStore`, else leave the cursor and re-send next cycle; emit the orchestrator `JobSucceeded` /
`JobFailed` trigger. Scope which files are sent via `ImportWindow`. Unit-test with a mock client +
in-memory `CursorStore`; live FSEvents + real POST are 3d. After it lands, flip 3b ✅. No PR (not a
phase boundary until 3b + 3d both land).

---

## 2026-05-27 — 3b (`collector-sync`: SQLite cursor store, partial) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-sync/src/cursor.rs` (+ `pub mod cursor;` and re-exports; deps
`collector-contracts`, `rusqlite` bundled, `thiserror`, dev-dep `tempfile`). Third leaf of 3b: the
durable local **per-source file cursor** store.

- **`FileCursor`** = `{ file_path, mtime_ms: f64, byte_offset: u64, content_hash_head }` — the record
  shape adapted from otto-sync's `CompletedFileCursor` (engine.rs). **The SQLite persistence is new
  Trace Flow code, not vendored:** otto kept cursors server-side (POSTed and read back from the
  sync-start response); Trace Flow Desktop keeps durable resumable cursor state locally (ADR "Local
  state"). `CursorStore` is keyed by `(org_id, source, file_path)`; `source` is the canonical
  `AgentSource` enum (never redefined).
- **Advance-only-after-2xx:** `advance()` is the single write path and the post-success commit point;
  the POST loop (next leaf) calls it only on `Ok`. On failure nothing advances, the file is re-read
  next pass, and server-side dedupe absorbs the repeat — resumable state, not a durable upload queue
  (ADR). API: `open`/`open_in_memory`, `get`, `list(source)`, `advance`.
- **Org isolation:** a store binds one `org_id` and every row carries it, so cursors are never reused
  across Organizations (ADR "one active Organization in v1"); a second org on the same DB file sees
  none of the first's rows (tested on-disk).
- **u64 offset safety:** rusqlite's native `u64` mapping rejects `> i64::MAX` on write and a negative
  stored value on read (both surface as `CursorStoreError::Sqlite`) — no silent wrap in either
  direction. `WAL` + `synchronous=NORMAL` for crash-durable desktop writes (a lost last-advance is
  harmless: idempotent re-sync). `WITHOUT ROWID` (composite PK is the only access path).
- **mtime kept `f64` (not integer ms):** deliberate — OS `mtimeMs` is fractional, so truncating
  would make a re-stat always compare `>` the stored value and defeat the discovery mtime fast-path;
  ms epochs are exact in `f64` until ~2255 and no `==` is used. (Raised P1 in review; pushed back
  with rationale; confirmation review accepted it as sound.)

**Verified:** `cargo fmt --check -p collector-sync`; `cargo clippy -p collector-sync --all-targets -D
warnings` (clean); `cargo test -p collector-sync` = **25 passed** (9 cursor tests: round-trip,
overwrite, per-source `list`, large/overflow/negative offset, per-org isolation, reopen-persist);
`cargo build`. Local `code-review` skill: initial **CHANGES REQUESTED** (2 P1: read-side wrap, mtime
type) → fixed P1-A via native `u64`, pushed back on P1-B with rationale, took WAL/provenance/comment
nits → confirmation review **READY TO LAND**. CodeRabbit not escalated (no auth/secret/schema/
redaction/concurrency/proxy surface in a pure local store; rubric does not require it). File 313
lines (184 implementation; the remainder is the 9-test module, consistent with the lane convention).

**Next / blockers:** 3b stays 🚧. Next leaf: the POST loop wrapping `session_facts(...)` into an
`AgentIngestEnvelope` (batch metadata + git-remote resolve/freeze + `collector_started_at` + 24h
grace + history-import presets), reusing the 3c `CollectorApiClient` and driving the orchestrator's
actions, advancing this cursor store only on `Ok(IngestOk)`. FSEvents watcher + live POST exercised
at 3d. No PR (not a phase boundary).

---

## 2026-05-27 — 3b (`collector-sync`: orchestrator state machine, partial) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-sync/src/orchestrator.rs` (+ `pub mod orchestrator;` and
re-exports). Second leaf of 3b and its second named cargo-verify item ("orchestrator state
transitions"): the **one-job-at-a-time** orchestrator as a pure, embedder-agnostic transition core.

- **Adapted, not vendored, from `otto-sync/src/orchestrator.rs`.** otto's `Worker` is welded to its
  engine/watcher/tokio channels and uses different states (Idle/Backfilling/Stopped). This leaf keeps
  otto's command set + one-job + pause/resume shape but redesigns the states to the ADR's named set
  and extracts the transition logic into a synchronous core, so it is testable with plain asserts —
  no engine, runtime, or channels.
- **States:** `Watching` (armed, idle), `Syncing`, `ImportingHistory`, `Paused` (initial), `Error`.
  `Orchestrator::apply(Trigger) -> Vec<Action>` mutates state and returns the side effects
  (`StartWatching`/`StopWatching`/`StartSync`/`StartImport`/`CancelJob`) the embedder replays.
- **One job at a time:** while `Syncing`/`ImportingHistory`, any new job trigger (`SyncNow`,
  `ImportHistory`, watcher `BatchDetected`) is rejected — no state change, no action. No batch is
  lost: the watcher re-fires and the 5-min poll backstop re-discovers unprocessed files, so "dirty"
  re-sync coalescing is a later refinement, not a gap.
- **Watcher lifetime:** armed exactly in {Watching, Syncing, ImportingHistory}, stopped in {Paused,
  Error}, so `StartWatching` fires only on entering the active cluster from rest and `StopWatching`
  only on leaving it (`Watching -> Syncing` and `Syncing -> Watching` emit neither).

**Verified:** `cargo fmt --check`, `cargo clippy -p collector-sync --all-targets -D warnings`,
`cargo build`, `cargo test -p collector-sync` (16 tests: 4 git + 12 orchestrator, covering every
transition incl. the one-job rejection and watcher-lifetime invariants for both job kinds). Local
`code-review`: **CHANGES REQUESTED → fixes → READY TO LAND** — the reviewer walked the full 5x7
(state x trigger) grid and confirmed all 35 cells correct (the catch-all absorbs exactly the
no-op/rejection cells); blockers were test gaps for the `ImportingHistory` branch of the OR-arms plus
a provenance-wording fix, all addressed; confirmation pass clean. CodeRabbit not escalated — pure
in-crate logic, no escalation trigger.
**Next / blockers:** 3b remains 🚧. Remaining leaves: SQLite cursor store (read/write + advance-on-2xx),
`collector_started_at` + 24h grace, history-import presets (7d/30d/1y), and the POST loop that wraps
`session_facts(...)` in an `AgentIngestEnvelope` (reusing the 3c `CollectorApiClient`) and drives this
orchestrator's actions. FSEvents watcher + live POST are exercised at 3d.

## 2026-05-27 — 3b (`collector-sync`: scaffold + git-remote freeze cache, partial) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** New crate `packages/collector-sync/` (auto-joins the workspace via the `collector-*`
member glob): `Cargo.toml`, `src/lib.rs` (crate root + module wiring), `src/git.rs`. First leaf of
3b — the git-remote resolve + **freeze cache** (one of 3b's three named cargo-verify items).

- **`GitRemoteCache`** (original Trace Flow code; otto re-resolved per call): a process-lifetime
  `cwd -> Option<GitMetadata>` cache. First sight of a `cwd` resolves and **freezes** it
  (first-writer-wins via `entry().or_insert()`), so a mid-run `git remote set-url` cannot
  re-attribute a session. `Some(None)` freezes a non-repo `cwd` so it is probed at most once;
  `None` means never-probed. The `std::sync::Mutex` guard is dropped before the `.await`, leaving a
  benign, documented TOCTOU (two first-time callers may both shell out; freeze is idempotent).
- **`resolve_git_metadata`** vendored from `otto-sync/src/git.rs` (SPDX + provenance header per
  `otto-extraction-reference.md`): concurrent `--show-toplevel` / `--abbrev-ref HEAD` /
  `remote.origin.url` probes via `tokio::join!`. Every `git` failure mode collapses to `None` =
  "field absent" / "not a repo"; per-failure diagnostics are deferred to 3d. Dropped the redundant
  blocking `Path::exists()` guard otto carried (a sync `stat` in async).
- **Scope discipline:** otto-sync's `pricing` and `provider_usage` modules are NOT vendored —
  provider-usage cost tracking is a separate feature and pricing is server-side.

**Verified:** `cargo fmt --check`, `cargo clippy -p collector-sync --all-targets -D warnings`,
`cargo build`, `cargo test -p collector-sync` (4 freeze-cache unit tests: peek miss→hit,
first-writer-wins ignores a later remote change, non-repo freezes as `Some(None)`, distinct cwds are
independent). The git subprocess itself is left to the 3d end-to-end run (it shells out to real git).
Local `code-review`: **CHANGES REQUESTED → fixes → READY TO LAND** (P1 redundant blocking
`Path::exists`, P1 TOCTOU doc, P2 unused `rt` tokio feature, P3 failure-discard + provenance-header
notes — all addressed; confirmation pass clean). CodeRabbit not escalated — local code, no escalation
trigger (the credential/auth path lives in the already-landed 3c `collector-api-client`).
**Next / blockers:** 3b remains 🚧. Remaining leaves: SQLite cursor store (read/write + advance), the
one-job-at-a-time orchestrator state machine (`Watching/Syncing/Importing/Paused/Error`),
`collector_started_at` + 24h grace, history-import presets (7d/30d/1y), and the POST loop that wraps
`session_facts(...)` in an `AgentIngestEnvelope` and advances the cursor only on a 2xx (reusing the
3c `CollectorApiClient`). FSEvents watcher + live POST are exercised at 3d.

## 2026-05-27 — 3a (`collector-parser`: session assembler — slice complete) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Added `packages/collector-parser/src/assemble.rs` (+ `pub mod assemble;`). New public
entrypoint `session_facts(source: AgentSource, records: &[Value], ctx: &SessionContext) ->
AgentIngestFacts` — the crate's single fan-out: it dispatches on `source` and runs every emitter for
that source, collecting the 5-field bundle (`messages`, `tool_events`, `file_events`,
`capability_snapshots`, `pull_request_links`) the `collector-sync` uploader (3b) will wrap in an
`AgentIngestEnvelope`.

- **Pure router, no new logic.** Adds zero identity/redaction/token handling — each field is exactly
  the matching emitter's output, so all `*_pk`/`cost_usd`/redaction rules stay in the emitters.
- **Source coverage.** Claude → messages/tools/files/PR-links with `capability_snapshots` a hardcoded
  empty vec (caps are Codex `session_meta`-only, not a missing emitter); Codex → all five incl.
  `codex_capability_facts`; **Cursor → all-empty bundle** so the uploader treats sources uniformly
  until the `3a*` Cursor parser lands. Match is exhaustive over `AgentSource` (no `_` catch-all).
- **Dispatch keys on the `source` argument, never record-shape sniffing** — a test routes
  Claude-shaped records through the Codex arm and gets the Codex emitters' output.

**Verified:** `cargo fmt --check`, `cargo clippy --all-targets -D warnings`, `cargo build`,
`cargo test -p collector-parser` (173 tests incl. 4 new assembler fan-out-fidelity tests — each
asserts a bundle field equals the direct emitter call on the same input). Local `code-review` skill:
**READY TO LAND** (no P1/P2; P3s were a defensible one-call placeholder helper and an already-covered
fixture comment). CodeRabbit not escalated — pure intra-crate router, none of the escalation triggers
(auth/secrets/schema/redaction/concurrency/proxy-streaming/contract) apply.
**Next / blockers:** 3a is complete — board flipped ✅. Next unit is **3b (`collector-sync`)**: wrap
`session_facts(...)` output into the POST `AgentIngestEnvelope` (batch metadata + cursor advance on
2xx). Cursor parser remains fast-follow `3a*`.

## 2026-05-27 — 3a (`collector-parser`: PR-link emitter) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-parser/src/emit_pr_links.rs` (+ `pub mod emit_pr_links;`).
`claude_pr_link_facts` / `codex_pr_link_facts(records, &SessionContext) -> Vec<AgentPullRequestLinkFact>`
scan a session for **canonical GitHub PR links** (`github.com/{owner}/{repo}/pull/{number}`, ADR v1
GitHub-only) and emit one fact per distinct observed link.

- **Evidence taxonomy:** assistant message text → `AssistantText`; tool _output_ (Claude `tool_result`
  content, Codex `function_call_output`) → `ToolOutput`; user/other transcript text → `TranscriptRecord`.
  Tool/command _input_ is never scanned — `gh pr create`/`gh pr view`/`git push`/branch names/bare PR
  numbers are diagnostic-only in v1 (ADR "Repo and pull request attribution"), so they yield no link.
  Every canonical link is `confidence = High`; the Medium/Low rungs and non-GitHub hosts are deferred
  enrichment.
- **Identity / dedup mirrors the Worker pk** (`pullRequestLinkPk`, `ids.ts:77` =
  `[source, vendorSessionId, sourceEventId ?? turn:N, url]`): observations dedupe on
  `(source_event_id, url)` in document order; `stable_turn_index` is a per-session ordinal over the
  survivors (stable across re-parse). Claude carries a per-record `uuid` → `source_event_id` set, so the
  same link in two records is two genuine observations; Codex carries none → `source_event_id` `None`, so
  a link repeated across the session collapses to one row. That asymmetry is inherited from the pk
  formula, not invented.
- **URL hygiene:** owner/repo lowercased (GitHub is case-insensitive) so casing can't fragment
  attribution; `/pull/` singular + numeric id required (issue links, `/pulls`, bare numbers rejected);
  trailing path/query/fragment/punctuation stripped to the canonical `https://` form; PR numbers that
  overflow `i64` skipped. The `regex` crate has no look-behind, so host look-alikes (`evilgithub.com`,
  `my-github.com`) and subdomains (`api.github.com`) are rejected by a preceding-byte guard, not `\b`.
  `dropped_sensitive` is 0 — only the public canonical URL is stored, never the surrounding text.

**Verified:** `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings` (clean),
`cargo test -p collector-parser` (169 passed incl. 17 new PR-link tests), `cargo build --workspace`.
Local `code-review` skill: **READY TO LAND** (resolved P1 owner/repo casing, P2 host-boundary
tightening + Codex tool-input exclusion test, P3 repo-pattern + helper note; multi-byte UTF-8 boundary
of the byte guard confirmed safe). CodeRabbit not escalated — parser-only, additive, no
auth/secret/schema/contract/redaction-logic change (per the escalation rubric).
**Next / blockers:** No top-level per-session **assembler** yet ties the now-7 emitters
(msgs/tools/files/caps/PR-links, Claude+Codex) into the upload envelope's fact arrays. That parser
entrypoint (`packages/collector-parser/`, the 3a lane) is the remaining 3a unit before 3a flips ✅; 3b
(`collector-sync`) then wraps it into the POST envelope. Cursor `state.vscdb` parser stays fast-follow
(`3a*`).

## 2026-05-27 — 3a (`collector-parser`: Codex capability-snapshot emitter) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-parser/src/emit_codex_caps.rs` (+ `pub mod emit_codex_caps;`,

- `sha2 = "0.10"`). `codex_capability_facts(records, &SessionContext) -> Vec<AgentCapabilitySnapshotFact>`
  reads each Codex `session_meta` record's capability surface and emits one snapshot per distinct
  observation: `base_instructions` (the system prompt, `payload.base_instructions.text` — current build;
  bare string tolerated for older builds — one item) and `dynamic_tools` (the `payload.dynamic_tools`
  catalog, one item per tool). **Verified against 114 real local Codex transcripts** — this resolves the
  prior "deferred → needs-data" note: `base_instructions` is a non-empty `{text}` object (not empty) and
  `dynamic_tools` is a populated array in current captures. Each fact ships **counts, byte size, a coarse
  ~4-chars/token estimate, and a SHA-256 of the surface only** — the raw instruction text and tool schemas
  are hashed, never uploaded (ADR "Capability Snapshots"); `redacted_label` is a count label
  (`"base instructions"` / `"N dynamic tools"`), never a tool name; `dropped_sensitive` is 0 (nothing is
  included to drop). **Identity:** Codex `session_meta.payload.id` is just the session UUID (repeats
  verbatim on every resume), so `source_snapshot_id` is `None`. The ingest Worker's
  `capability_snapshot_pk` (`ids.ts:69`) keys on `turn:<stable_turn_index>` and **omits `capability_kind`**,
  so two kinds from one `session_meta` would collide — `stable_turn_index` is therefore a per-session
  ordinal over **distinct** observations (document order). Observations dedupe on
  `(capability_kind, content_hash)`: a resumed session re-states the same surface many times (24x observed)
  → one row per kind, while a genuine change (new prompt, a tool added) takes the next ordinal and lands as
  its own row. The tool hash is over an order-independent canonical form (each tool compact-serialized,
  then sorted), so a reordered-but-identical catalog still dedupes. `base_instructions` text is trimmed so
  incidental padding can't inflate size/tokens or fork a row. `mcp_servers` kind is intentionally not
  emitted: current Codex transcripts carry no MCP inventory in `session_meta` and the ADR forbids inferring
  one from local config.
  **Verified:** `cargo fmt -p collector-parser --check`; `cargo clippy -p collector-parser --all-targets
-- -D warnings` (clean); `cargo test -p collector-parser` (152 unit +2 canary, +14 new); `cargo build
--workspace` (sha2 compiles). Local `code-review` skill → **READY TO LAND** (privacy/pk-collision/
  idempotence all PASS; one P3 — untrimmed base-instructions surface — fixed). CodeRabbit CLI flagged one
  `major` (`repeat_n` MSRV floor, in tension with the clippy `manual_repeat_n` lint) → resolved with a
  toolchain-agnostic `(0..24).map(|_| one.clone())`; confirmation re-run rate-limited (12m), treated as a
  skip per the local-first review policy (the finding was already resolved and re-verified by clippy+tests).
  **Next / blockers:** 3a stays 🚧 — **caps was NOT the last 3a unit** (the prior breadcrumb was optimistic).
  Remaining 3a unit is the **PR-link emitter** (`AgentPullRequestLinkFact`): extract canonical GitHub
  `github.com/{owner}/{repo}/pull/{number}` links from assistant text / tool output / transcript records
  with `confidence`/`evidence` (ADR L150–152; GitHub-only in v1; `gh`/`git push`/bare-number strings are
  diagnostic evidence, not attribution). Open question for that leaf or 3b/3d: there is still **no
  top-level per-session assembler** tying the seven emitters into the envelope's five fact arrays — confirm
  whether that lives in `collector-sync` (3b) or as a small `collector-parser` entrypoint. Future cleanup:
  hoist duplicated `record_event_at` / block-cursor helpers across the Codex emitters into a shared module.

## 2026-05-27 — 3a (`collector-parser`: Codex file-event emitter) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-parser/src/emit_codex_files.rs` (+ `pub mod emit_codex_files;`).
`codex_file_facts(records, &SessionContext) -> Vec<AgentFileEventFact>` emits one fact per file an
`apply_patch` call touches, mapping the patch verb (`Add`/`Update`/`Delete File:`) to
`Create`/`Edit`/`Delete`. Touched paths come from the `*** <verb> File: <path>` markers in the patch
body (`arguments.input`, with bare-string and non-JSON-raw fallbacks); each is relativized via
`relativize_repo_path` (repo-relative or the `outside_repo` sentinel, never a home dir/username).
`vendor_message_id` is `None` (Codex emits no per-message ID), so `source_block_index` is a
session-global document-order counter — the only field keeping two same-path/same-op events distinct
under `file_event_pk`. `dropped_sensitive` is 0 (paths are normalized, not redacted). Raw
`exec_command` shell file writes stay deferred to the tool emitter.
**Verified:** `cargo fmt -p collector-parser --check`; `cargo clippy -p collector-parser --all-targets
-- -D warnings`; `cargo test -p collector-parser` (138 passed, +11 new); `cargo build --workspace`;
`coderabbit review --agent --type uncommitted --dir packages/collector-parser` → 0 findings.
**Next / blockers:** Last 3a unit is Capability Snapshots (Codex `base_instructions`/`dynamic_tools`
counts/hashes/sizes); keep 3a 🚧 until it lands. NOTE: review-process change in flight — a separate
worktree disables automatic CodeRabbit in favor of a local `code-review` skill; the driver's CodeRabbit
gate will be retargeted there.

## 2026-05-27 — 3a (`collector-parser`: Codex tool-event emitter) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-parser/src/emit_codex_tools.rs` (+ `pub mod emit_codex_tools;`).
`codex_tool_facts(records, &SessionContext) -> Vec<AgentToolEventFact>` emits one fact per Codex
`function_call` record, joined to its `function_call_output` by `call_id` (a `HashMap<call_id, &output>`
built in one pass, then the records walked for the use side — the same use/result shape as the Claude
emitter, but Codex's result is a separate top-level record, not a content block). Only `exec_command`
carries a shell command (parsed from the JSON-string `arguments.cmd`) to classify via
`command::classify_command`; MCP tools (`get_issue`, `save_issue`, …) and `write_stdin` carry none, so
their classification columns ship empty. `command_excerpt`/`error_excerpt` are redacted then capped
(1 KB / 4 KB, ADR L243), `dropped_sensitive` sums the redactor drops. `repo_relative_paths` ships empty
— Codex represents file edits as `apply_patch` _shell_ text inside `exec_command`, so file extraction is
the file emitter's unit, not this one. **Codex carries a real exit code** (unlike Claude's Bash sidecar):
`status`/`exit_code` come from the `Process exited with code N` line, and `duration_ms` is the call→output
wall-clock gap (clock-skew-bounded). **Real-data correction over the otto reference:** Codex writes that
status line in the output _preamble_ (before `Output:`), so the **first** match is authoritative — otto
took the last, which a command echoing the phrase in its own body would shadow. Exit `0` → success,
non-zero → failure, absent (dangling call or an MCP tool with no process code) → unknown. Enrichment
columns (`extracted_provider`/`extracted_repo`/`extracted_pr_number`/`extracted_subagent_*`) ship empty,
same rationale as the Claude tool emitter.
**Verified:** `cargo fmt -p collector-parser --check` (clean), `cargo clippy -p collector-parser
--all-targets -- -D warnings` (clean), `cargo test -p collector-parser` (127 passed; 14 new
emit_codex_tools tests: exec success classified + exit 0, non-zero → failure takes the output as the
error, git exit 128 → failure, preamble status line wins over a body echo, dangling call → unknown/no
duration, MCP tool with no process code → unknown/no command, write_stdin → no classification, command
secret drop counted, error home-path masked, command/error excerpts capped at 1 KB/4 KB, duration is the
call→output gap, block index tracks call position skipping non-calls, empty session → no facts),
`cargo build --workspace` (clean). CodeRabbit `--type uncommitted --dir packages/collector-parser`:
0 findings (after one recoverable rate-limit wait).
**Next / blockers:** Remaining 3a — Codex **file** emitter (parse `apply_patch` `*** Add|Update|Delete
File:` paths out of `exec_command` shell text, relativize like the Claude file emitter) and capability
snapshots (Codex `base_instructions`/`dynamic_tools` — counts/hashes/sizes). Future cleanup: the Claude
tool emitter and this Codex tool emitter now both hold private `cap_bytes`/`excerpt` copies on top of the
three Claude emitters' `record_event_at`/block-cursor triplication; hoist all to one shared module in a
dedicated refactor commit. Cursor parser stays fast-follow (`3a*`).

## 2026-05-27 — 3a (`collector-parser`: Claude tool-event emitter) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-parser/src/emit_claude_tools.rs` (+ `pub mod emit_claude_tools;`).
`claude_tool_facts(records, &SessionContext) -> Vec<AgentToolEventFact>` emits one fact per `tool_use`
block. The result side (outcome, duration, error text) comes from `tool_fold::fold_tool_events` looked up
by `tool_use_id` (the cross-record use/result join already lived there — no fold change); the use side
(message id, event time, command, touched path, block position) is read from the assistant record the
walk visits, reusing the file emitter's per-message logical block-index scheme. `command` is classified
via `command::classify_command` into `command_family`/`command_program`/`command_subcommand`; `status`
maps from the folded `ToolOutcome`. `command_excerpt`/`error_excerpt` are redacted with
`redaction::redact_field` **then** capped (1 KB / 4 KB per ADR L243, so the 5 KB per-event total holds
without a separate check), summing the redactor's drop count into `dropped_sensitive`.
`repo_relative_paths` carries the relativized `input.file_path` for file-bearing tools, else empty
(shell-command path parsing is deferred). Resolved sub-decisions, no ADR conflict: **`exit_code` is
always `None`** — Claude's Bash sidecar carries only `interrupted`/`stderr`/`stdout`, never a process
exit code (verified across 40 real transcripts; the only `code` field is WebFetch's HTTP status);
**enrichment columns ship empty** — `extracted_provider`/`extracted_repo`/`extracted_pr_number` have no
ADR algorithm (PR links are a separate fact table) and `extracted_subagent_*` would double-count a
spawned sub-agent whose tokens already live in its own separate transcript's facts.
**Verified:** `cargo fmt -p collector-parser --check` (clean), `cargo clippy -p collector-parser
--all-targets -- -D warnings` (clean), `cargo test -p collector-parser` (113 passed; 11 new
emit_claude_tools tests: Bash success classification + no exit code, enrichment columns empty, failed
call takes redacted stderr without leaking a username, Read records the relativized path + no command,
outside-repo path → sentinel, command-excerpt secret drop counted, command/error excerpts capped at
1 KB/4 KB, dangling tool_use → Unknown, block index tracks message position, non-tool blocks emit
nothing), `cargo build --workspace` (clean). CodeRabbit `--type uncommitted --dir packages/collector-parser`: clean (after a recoverable rate-limit wait).
**Next / blockers:** Remaining 3a — Codex tool + file emitters (Codex represents edits via `apply_patch`
shell calls, a different shape from Claude's structured `Edit`/`Write`, so its file extraction is its own
unit) and capability snapshots (Codex `base_instructions`/`dynamic_tools` — needs real Codex transcript
data to fix the shape). Future cleanup: the three Claude emitters now each hold a private copy of
`assistant_message_id`/`content_blocks`/`record_event_at` + the per-message block cursor; hoist them to
one shared `claude_records` module in a dedicated refactor commit. Cursor parser stays fast-follow (`3a*`).

## 2026-05-27 — 3a (`collector-parser`: Claude file-event emitter) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-parser/src/emit_claude_files.rs` (+ `pub mod emit_claude_files;`).
`claude_file_facts(records, &SessionContext) -> Vec<AgentFileEventFact>` emits one fact per
file-touching `tool_use` block — `Read`→`Read`, `Write`→`Write`, `Edit`/`MultiEdit`→`Edit`; every
other tool and every non-`tool_use` block is skipped. Each path runs through
`paths::relativize_repo_path` against the new `SessionContext.repo_root` anchor, so a stored path is
repo-relative or the `outside_repo` sentinel and never a home dir, username, or absolute path. Added
`pub repo_root: String` to `SessionContext` (`session_context.rs`): the sole field never emitted onto a
fact — the sync-resolved absolute git root used only as that relativization anchor; empty `repo_root`
means "root unknown" and collapses every absolute path to `outside_repo` (safe default). `source_block_index`
is the block's position in its message's **full block stream** in document order, not the within-record
index: Claude writes one content block per JSONL record (verified against a real transcript — `n:1` per
assistant record), all sharing the turn's `message.id`, so a within-record index is always `0` and could
not separate two same-path same-operation edits in one turn, which the `file_event_pk` hash needs it to do.
`record_event_at` is triplicated from `emit_claude`/`emit_codex` deliberately (hoisting it to a shared
module would edit those committed files, outside this task's lane) — noted as future cleanup.
**Verified:** `cargo fmt -p collector-parser --check` (clean), `cargo clippy -p collector-parser
--all-targets -- -D warnings` (clean), `cargo test -p collector-parser` (102 passed; 11 new
emit_claude_files tests: operation mapping for Read/Write/Edit/MultiEdit, non-file tools + thinking/text
blocks + user tool-result records emit nothing, missing `file_path` skipped, two edits of the same path in
one message stay distinct rows, block index resets across messages, non-file blocks still advance the
cursor, outside-repo path collapses without leaking the username, empty `repo_root` collapses every
absolute path, `event_at` from the record timestamp, timestamp fallback to session start), `cargo build
--workspace` (clean). CodeRabbit `--type uncommitted --dir packages/collector-parser`: **0 findings**
(after a recoverable rate-limit wait).
**Next / blockers:** Tool-event emitter (Claude + Codex) is next in 3a — it needs a `fold_tool_events`
extension (`FoldedToolEvent` carries no `vendor_message_id`, exit code, tool input paths, or subagent
usage) and inherits the deferred `extracted_provider`/`extracted_repo`/`extracted_pr_number` enrichment
(ADR names them but gives no algorithm; PR links are a separate GitHub-only fact table — leave
empty/`None` on tool events). Then Codex file/tool paths and capability snapshots (capability snapshots
need real Codex data). Cursor parser stays fast-follow (`3a*`).

## 2026-05-27 — 3a (`collector-parser`: Claude message-fact emitter) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-parser/src/emit_claude.rs` (+ `pub mod emit_claude;`).
`claude_message_facts(records, &SessionContext) -> Vec<AgentMessageFact>` emits one fact per assistant
`message.id` (usage collapsed by `claude_usage::session_message_usages`, so a turn Claude writes across N
content-block records counts once) and one per text-bearing user record (string content or an array
holding a `text` block; tool-result-only user records are skipped and burn no turn index). `model` comes
from `message.model` (empty for user turns, which carry `Missing` coverage). `vendor_message_id` is the
`message.id` for assistant turns and the record `uuid` for user turns so the Worker's `message_pk` stays
stable across re-parse. `is_subagent_spawn` is set when a turn's content holds a `Task`/`Agent`
`tool_use` — matched by exact name (scanned across all records sharing the id, since the spawning block
can land in a later content-block record), so the unrelated `TaskCreate`/`TaskUpdate`/`TaskList` todo
tools never false-trigger. `is_sidechain` rides from each record; `agent_depth` from `SessionContext`.
**Verified:** `cargo fmt -p collector-parser --check` (clean), `cargo clippy -p collector-parser
--all-targets -- -D warnings` (clean), `cargo test -p collector-parser` (91 passed + 2 canary; 13 new
emit_claude tests cover id collapse, collapsed-token Full coverage, usage-less assistant → Missing,
user uuid keying, tool-result-only skip, array-with-text user emit, Task/Agent spawn flag vs the Task\*
todo family, spawn block in a later same-id record, sidechain + agent_depth carry, positional turn_index
across skips, session-context carry, timestamp fallback, empty session), `cargo build --workspace`.
CodeRabbit `--type uncommitted`: 1 "critical" finding (SessionContext missing `agent_depth`) — **verified
false positive**: the field exists in the already-committed `session_context.rs:32` (`4437439`), outside
the uncommitted review scope, and the crate compiles + all tests pass, which is impossible if it were
missing. Skipped per the "fix only still-valid issues" rule; re-review would reproduce it identically.
**Next / blockers:** 3a stays 🚧. Next leaf is the Claude tool-event emitter (`AgentToolEventFact`).
**Heads-up — ADR gap:** the tool-event fact names `extracted_provider`/`extracted_repo`/
`extracted_pr_number` (ADR L243) but gives no extraction algorithm, and otto's `tools.rs` does not
populate them (PR links are a separate GitHub-only fact table, ADR L152). Resolve before that leaf.

## 2026-05-27 — 3a (`collector-parser`: Codex message-fact emitter) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-parser/src/emit_codex.rs` and `src/session_context.rs`
(+ `pub mod` for both; `Cargo.toml`/`Cargo.lock` gain a path dep on `collector-contracts` — no new
external crates). `codex_message_facts(records, &SessionContext) -> Vec<AgentMessageFact>` emits one
fact per segmented Codex turn (from `codex_turns::session_turns`): assistant turns carry their tokens
with `Full` coverage, user turns carry none with `Missing`, and the assistant turns' tokens sum to the
session total by construction (dedup lives in `codex_turns`). Each turn is tagged with the model active
when it ran — resolved by walking `turn_context.payload.model` and correlating to turns via pointer
identity against the same `records` slice (`session_meta.model` is null in Codex). `vendor_message_id`
is `None` (Worker's `message_pk` falls back to positional `turn_index`); `agent_depth`/`is_sidechain`/
`is_subagent_spawn` are constant (Codex has no sub-agent transcript nesting). `SessionContext` is new,
original Trace Flow code (no otto equivalent): the per-session git/identity metadata every emitter
shares, including `agent_depth` (0 top-level, >0 for Claude sub-agent files; Codex stays 0).
**Verified:** `cargo fmt -p collector-parser --check` (clean), `cargo clippy -p collector-parser
--all-targets -- -D warnings` (clean), `cargo test -p collector-parser` (78 passed + 2 canary; 7 new
emit_codex tests cover one-fact-per-turn role+index, assistant tokens with input-minus-cached split,
user Missing coverage, mid-session model switch gpt-5.5→gpt-5.5-codex, session-context carry, token
totals summing to 60_899, and the empty session), `cargo build --workspace` (Cargo.lock unchanged
except the intra-workspace contracts edge). CodeRabbit `--type uncommitted`: 1 trivial (document the
`ptr::eq` coupling) → added the warning comment → **0 findings** on re-review.
**Next / blockers:** 3a stays 🚧. Next leaf is the Claude `AgentMessageFact` emitter (one fact per
`message.id` with collapsed usage; sub-agent depth + sidechain + Task/Agent spawn detection).

## 2026-05-27 — 3a (`collector-parser`: RFC3339 timestamp parser) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-parser/src/timestamp.rs` (+ `pub mod timestamp;`).
`rfc3339_to_epoch_ms(&str) -> Option<i64>` turns a transcript record's `timestamp` string into the
epoch-millisecond `event_at` every `Agent*Fact` carries — the last shared prerequisite before the fact
emitters. **Dependency-free:** otto leaned on `chrono::DateTime::parse_from_rfc3339`, but `chrono` is not
in the workspace lock and the parser crate keeps a deliberately tiny pinned dependency surface (it is the
redaction trust boundary), so this is an original reimplementation, not vendored code. It parses the
fixed `YYYY-MM-DDTHH:MM:SS.sssZ` shape both Claude Code and Codex CLI emit, and also tolerates numeric
`±HH:MM` offsets, any fractional-second width (truncating to ms, never rounding), and a leap second.
Days come from Howard Hinnant's `days_from_civil`; calendar-invalid dates (Feb 30, Apr 31, a non-leap
Feb 29) are rejected before conversion so a malformed timestamp fails loudly instead of silently rolling
forward.
**Verified:** `cargo fmt --check`, `cargo clippy -p collector-parser --all-targets -- -D warnings`
(clean), `cargo test -p collector-parser` (71 passed + 2 canary; new timestamp suite covers the epoch,
real Claude/Codex stamps vs `date -j -u` ground truth, leap day/year boundaries, offset normalization,
fractional truncation, and a malformed-input table), `cargo build --workspace` (Cargo.lock unchanged —
no new dependency). CodeRabbit `--type uncommitted`: 1 major + 1 minor (both: `1..=31` accepted
calendar-invalid days) → added month-aware `is_valid_calendar_date` + invalid-date tests → **0 findings**
on re-review.
**Next / blockers:** 3a stays 🚧. Next is the fact emitters (see the entry below) — now unblocked on
timestamp parsing.

## 2026-05-27 — 3a (`collector-parser`: per-turn Codex segmentation) — t3code/ab83918d

**Status:** 🚧 in progress
**Decision landed:** the Codex Agent Message grain is **per-turn**, not per message record (user choice;
CONTEXT "the grain at which token counts are recorded"). A Codex turn — not a raw `response_item`
`message` record — is the token-bearing unit, so a reasoning- or tool-only turn (real Codex sessions emit
these: reasoning + function_call + `token_count`, no message record) carries tokens but has no message.
Indexing per message record (the prior `codex_turns` leaf) left those tokens with nowhere to land.
**Changed:** Reworked `codex_turns.rs` into a single `session_turns(records)` segmenter: walks the record
stream in file order and emits one `CodexTurn { turn_index, role: CodexTurnRole, usage:
Option<CodexTurnUsage>, record: &Value }` per user message and per `token_count`-bounded assistant turn,
0-based, purely from structural file position (re-parse never renumbers — the `message_pk` stability the
ADR flags). Assistant turns carry their usage; a tool-only turn now becomes a turn and keeps its tokens.
`codex_usage.rs` drops to the usage **reader** leaf: `last_token_usage` + `cumulative_total` are now
`pub(crate)` and `CodexTurnUsage` stays public; `session_turn_usages` is **removed** — its segmentation
and the cumulative-advance dedup moved into `codex_turns`, which shares the one dedup rule so the kept
assistant turns sum to the session's final `total_token_usage` by construction (the ~331x trap guard
survives as a `codex_turns` test). No external consumers of the old API existed (grep-verified).
**Verified:** `cargo fmt --check`, `cargo clippy -p collector-parser --all-targets -- -D warnings`
(clean), `cargo test -p collector-parser` (64 passed + 2 canary), `cargo build --workspace`. CodeRabbit
`--type uncommitted`: **0 findings** (clean first pass). Commit `2654705`.
**Next / blockers:** This was a grain correction on freshly-shipped code, not new surface. 3a stays 🚧.
**Remaining 3a work is the fact emitters** onto `collector-contracts` — assemble `session_turns`
(+usage) + `session_message_usages` (Claude) + `classify_command` + `fold_tool_events` +
`relativize_repo_path` + `redact_field` into `Agent*Fact`, emit `command_family = command_program`, and
build per-turn content/model from the records a Codex turn spans (turn_context model, message text). That
is the per-source normalizer/emitter — a cohesive non-leaf that adds the `collector-contracts` dep and is
the natural unit for a fresh session/budget. Capability snapshots stay deferred (needs-data).

## 2026-05-26 — 3a (`collector-parser`, partial: Codex positional turn index) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-parser/src/codex_turns.rs` (+ `pub mod codex_turns;`).
`session_message_turns(records)` numbers each Codex `response_item` `message` record with a stable
0-based `turn_index` in file order — the positional surrogate that stands in for the vendor message ID
Codex never emits and that `message_pk` hashes (ADR identity rule: Codex `message_pk` falls back to
`(vendor session ID, positional turn index)`). **Divergence from otto:** otto bumps its turn counter
inside the event-emission state machine, only on flush and _after_ scaffold/role filtering, so a re-parse
whose scaffold heuristic changes renumbers the turns — exactly the fragility the ADR flags as Codex's
weakest dedupe key. Trace Flow assigns the index purely from structural file position over `message`
records, **before** any role/scaffold filtering, so the emitter can drop developer/scaffold messages
without renumbering the survivors and a re-parse is bit-stable. The `event_msg` render duplicates
(`agent_message`/`user_message`, which mirror the canonical `response_item` content) are not counted —
counting them would double-count, another renumbering source. Grain follows CONTEXT ("an Agent Message is
a single assistant or user record"); token-to-message attribution for reasoning/tool-only token turns
that carry no `message` record stays an **emitter** decision, not invented here. Returns
`CodexMessageTurn { turn_index, role: CodexMessageRole, record: &Value }` so the emitter reads
content/usage off the borrowed record. 8 tests (file-order numbering, non-message records skipped,
event_msg duplicates excluded, re-parse identical, leading-message-drop does-not-renumber, index follows
file order not timestamps, unknown role → Other, empty session).
**Verified:** `cargo fmt --check`, `cargo clippy -p collector-parser --all-targets -- -D warnings`
(clean), `cargo test -p collector-parser` (65 passed + 2 canary), `cargo build --workspace`. CodeRabbit
`--type uncommitted`: **0 findings** (clean first pass). Commit `8e64edb`.
**Next / blockers:** This was the last cleanly-separable pure leaf. 3a stays 🚧. **Remaining 3a work is
the fact emitters** onto `collector-contracts` (assemble `session_message_usages` +
`session_turn_usages` + `session_message_turns` + `classify_command` + `fold_tool_events` +
`relativize_repo_path` + `redact_field` into `Agent*Fact`, emit `command_family = command_program`). That
unit is **not a pure leaf** — it is the per-source normalization that reconciles Codex's `token_count`
turn boundaries with `message` records (incl. reasoning/tool-only turns that have tokens but no message)
and Claude's per-message fold, and it adds the `collector-contracts` dependency. Capability snapshots stay
deferred (real Codex `session_meta` has empty `base_instructions`, no dynamic-tools catalog → needs-data).

## 2026-05-26 — 3a (`collector-parser`, partial: tool-use/tool-result fold) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-parser/src/tool_fold.rs` (+ `pub mod tool_fold;`).
`fold_tool_events(records)` pairs each Claude Code `tool_use` block with its matching `tool_result`
(by `tool_use_id`) and that result record's co-located `toolUseResult` sidecar into one
`FoldedToolEvent` per call — the pre-emitter shape of an `AgentToolEventFact`. **Divergence from otto:**
otto emits the call and its result as two separate facts; the ADR requires a call and its outcome to be
a single row, so this resolves all results first, then walks `tool_use` blocks in document order
(`source_block_index` = position in the message `content[]`). Outcome mapping is honest about the
unobserved case: no matching result (session ended mid-call) or `interrupted` → `Unknown`; `is_error` →
`Failure`; else `Success`. `duration_ms` and `stderr` come from the sidecar; `error_text` falls back to
the result body (string or `{type:text}` array) only when the call errored; `command` is `Some` only for
shell tools carrying `input.command`. Text fields stay raw — the downstream emitter redacts, truncates,
classifies, and stamps the epoch. 9 tests (success fold, is_error→Failure+stderr, interrupted→Unknown,
dangling→Unknown, sidecar duration, error-body fallback, text-array join, document-order+block-index,
empty session).
**Verified:** `cargo fmt --check`, `cargo clippy -p collector-parser --all-targets -- -D warnings`
(clean), `cargo test -p collector-parser` (57 passed + 2 canary), `cargo build --workspace`.
CodeRabbit `--type uncommitted`: 1 trivial finding (double-allocation in `result_content_text` via
`Value::String` rewrap) fixed with its verbatim suggestion (`trim_non_empty(&str)` helper, both call
sites converted), re-confirmed **0 findings**. Commit `03ebc21`.
**Next / blockers:** 3a stays 🚧. Remaining leaves: Codex turn-index determinism; then the fact emitters
onto `collector-contracts` (assemble `session_message_usages` + `session_turn_usages` + `classify_command`

- `fold_tool_events` + `relativize_repo_path` + `redact_field` into `Agent*Fact`, emit `command_family =
command_program`). Capability snapshots deferred — real Codex `session_meta` has empty `base_instructions`
  and no clear dynamic-tools catalog, so the source mapping is a non-ADR decision (needs-data). CodeRabbit
  windows still fluctuating (6m–16m) on credit depletion; cleared via background wait+retry.

## 2026-05-26 — 3a (`collector-parser`, partial: command classification) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-parser/src/command.rs`. `classify_command(raw)` splits a shell
command into the `command_program` / `command_subcommand` / `command_family` triple on
`AgentToolEventFact`. **Deliberate divergence from otto:** otto's `derive_facts.rs` emits a _two-part_
family ("git push", "npm install") from a hardcoded program allowlist — exactly the invented
`command_family` taxonomy the ADR never defines and the prior CHANGELOG flagged as a non-ADR decision.
Trace Flow instead sets `family == program` (the documented program-as-family resolution): `program` is
the basename of argv[0], `subcommand` is argv[1] only when it reads as a verb (no leading `-`, no path
separator), and `family` mirrors `program`, so the failure leaderboard groups by program with no curated
list to drift. Output pinned to the contract sample (`collector-contracts/src/sample.rs`):
`git push origin HEAD` => `git` / `push` / `git`. Mechanical argv parsing only — shell wrappers and
leading `KEY=value` env prefixes are **not** unwrapped (a documented scope boundary / future
enrichment), kept out so this stays parsing rather than command-shape heuristics. SPDX/provenance
header; `pub mod command;` in `lib.rs`.
**Verified:** `cargo test -p collector-parser` 50 pass (48 unit + 2 canary). Command tests assert: the
contract-sample triple; `family == program` across a set; path-basename stripping; a flag second token
and a path second token both yield no subcommand; single-token and empty/whitespace commands; whitespace
collapse; and the documented env-prefix non-unwrapping. `cargo clippy -p collector-parser --all-targets
-- -D warnings`, `cargo fmt --check`, `cargo build --workspace` all clean. **CodeRabbit CLI: 1 trivial
finding** (a self-contradicting test comment — claimed `script.js` was "an argument, not a subcommand"
while asserting it _is_ the subcommand); fixed verbatim per CodeRabbit's instruction to document the
mechanical-parsing limitation. The confirming pass was rate-limited (org out of credits; the window grew
to 15m), so this lands on the resolved-trivial-finding + green-local-gates basis — same precedent as the
codex_usage slice — rather than burning the depleted pool on a comment-only re-confirm.
**Next / blockers:** 3a stays 🚧. Remaining: tool-use+tool-result fold (same `tool_use_id` → one Tool
Event; pairs the assistant `tool_use` block with the user `tool_result` block + the Claude-Code
record-level `toolUseResult` sidecar carrying `durationMs`/`interrupted`/`stderr`; status maps
`is_error`→failure, `interrupted`→unknown, else success), capability snapshots (counts/hashes/sizes
only), Codex turn-index determinism, and the fact emitters onto `collector-contracts` (calling
`relativize_repo_path` + `redact_field` + `session_turn_usages` + `session_message_usages` +
`classify_command`). Then 3b / 3d. **CodeRabbit credit pool is depleting** (windows this session:
13m → 4m → 11m → 9.5m → 15m); further slices may stall on review.

## 2026-05-26 — 3a (`collector-parser`, partial: Claude per-message token collapse) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-parser/src/claude_usage.rs`, the Claude-side companion to
`codex_usage.rs`. `session_message_usages` collapses a session's JSONL records to one
`ClaudeMessageUsage` per `message.id` — the input to the `AgentMessageFact` token fields. **Real-data
finding (diligence against a captured `~/.claude/projects` transcript):** Claude Code writes one record
per content block of an assistant turn (text + each `tool_use` + each `tool_result`), and **every**
record repeats that turn's full `message.usage`. One turn's usage appeared 8× verbatim; grouping the
session showed each `message.id` maps to exactly one usage tuple (no per-record variation). So summing
usage per record multiplies a turn's tokens by its block count — the explicit 3a "collapse repeated
`message.usage` by `message.id`" trap. First record carrying usage for an id wins; later repeats drop;
first-appearance order preserved. Token mapping: `cache_creation_tokens` = authoritative
`usage.cache_creation_input_tokens`; the 5m/1h split reads `usage.cache_creation.ephemeral_{5m,1h}_input_tokens`
**only when present** — pre-breakdown transcripts leave the split `0/0` with a non-zero total rather
than fabricating a tier; `reasoning_tokens` always 0 (Claude folds thinking into `output_tokens`, emits
no reasoning field); `total_tokens` reconstructed from components (Claude usage has no session total).
Adapted from otto `claude_code/mod.rs`, which fingerprints **per record** (key includes timestamp +
content hash) and so emits one fact per record with no id-collapse — the multi-count this rework fixes.
SPDX/provenance header; `pub mod claude_usage;` in `lib.rs`.
**Verified:** `cargo test -p collector-parser` 41 pass (39 unit + 2 canary). Claude canary asserts:
8 repeated records collapse to one contribution; naive per-record sum = 8× the true output vs collapsed
counts once; 5m/1h split when the breakdown is present (and sums to the total); split stays `0/0` when
absent (total still authoritative); `total_tokens` reconstruction; `reasoning == 0`; first-appearance
order across interleaved repeats; skips records without `message.id`/`usage`; a usage-bearing record
wins over an earlier id-only one; multi-turn session sums each turn once. `cargo clippy -p
collector-parser --all-targets -- -D warnings`, `cargo fmt --check`, `cargo build --workspace` all clean.
**CodeRabbit CLI: 0 findings, clean first pass** (`--type uncommitted --dir packages/collector-parser`;
the credit window that hit 13m+ last session recovered to a ~4m cooldown, then the run completed clean).
**Next / blockers:** 3a stays 🚧. Remaining: tool-use+tool-result fold (same `tool_use_id` → one Tool
Event), capability snapshots (counts/hashes/sizes only), Codex turn-index determinism, and the fact
emitters onto `collector-contracts` (calling `relativize_repo_path` + `redact_field` +
`session_turn_usages` + `session_message_usages`; emit program-as-family for `command_family` per the
prior note). Then 3b / 3d.

## 2026-05-26 — 3a (`collector-parser`, partial: Codex token aggregation) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-parser/src/codex_usage.rs`. `session_turn_usages` folds a Codex
session's `token_count` events into one `CodexTurnUsage` per real turn (the input to the
`AgentMessageFact` token fields). **Real-data finding that changes the spec wording:** the 3a "Do" says
"sum `last_token_usage` deltas," but a captured session shows Codex emits some `token_count` events
**twice** (the duplicate repeats the prior `last_token_usage` while its cumulative `total_token_usage`
does not advance). Naively summing every `last_token_usage` therefore overcounts (420443 vs the true
299113). So an event is kept only when its cumulative `total_token_usage.total_tokens` strictly
advances past the last kept turn; the kept turns' `total_tokens` then sum to the session's final
cumulative **by construction** — which is exactly the verify invariant. `total_token_usage` is read
**only** as a dedup key, never summed (summing it is the ~331x trap: 1306755 here). Per-turn split:
`input_tokens` is the non-cached remainder (`input_tokens - cached_input_tokens`, clamped ≥ 0),
`cache_read_tokens` the cached part, `reasoning_tokens` a subset of output; Codex has no
cache-creation split so those fact fields stay 0. `serde_json` moved dev → runtime dep (the parser
consumes `Value`); no `Cargo.lock` churn. Adapted from otto `codex_cli/usage.rs` (which reads one
event in isolation and lacks the dedup). SPDX/provenance header; `pub mod codex_usage;` in `lib.rs`.
**Verified:** `cargo test -p collector-parser` 30 pass (28 unit + 2 canary). Codex canary asserts:
6 real turns after dropping 1 null + 2 duplicates; `sum(turn.total_tokens) == 299113` (final
cumulative); naive sum `== 420443 != 299113` (proves dedup is required); cumulative-sum trap
`== 1306755 > 3×` the real total; cached/reasoning split + reconstruction-when-`total_tokens`-missing +
`cached > input` clamp. `cargo clippy -p collector-parser --all-targets -- -D warnings`, `cargo fmt
--check`, `cargo build --workspace` all clean. CodeRabbit CLI: pass 1 → 4 findings; fixed the **major**
(fallback total was computed from raw, not clamped, input → inconsistent on the `cached > input` edge)
and the trivial test-coverage finding; **declined** two trivial Cargo.toml pin nits — `serde_json = "1"`
matches the workspace convention (`collector-contracts`, `collector-api-client`), and `regex = "1.11"`
is the intentional minor floor with the exact patch pinned by `Cargo.lock`. Pass-2 re-confirm was
rate-limited (credits; wait grew to 13m), but the only major finding is resolved and the remainder are
deliberate declines.
**Next / blockers:** 3a stays 🚧. Remaining: Claude parser (collapse `message.usage` by `message.id`),
tool-use+tool-result fold (same `tool_use_id` → one Tool Event), capability snapshots, Codex
turn-index determinism, and the fact emitters onto `collector-contracts`. **Note for the fact
emitters:** `command_family` has no ADR-defined taxonomy and the contract sample shows
`command_family == command_program` (`git`); emit program-as-family until a future enrichment, rather
than inventing a taxonomy. Then 3b / 3d.

## 2026-05-26 — 3a (`collector-parser`, partial: path relativization) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** Added `packages/collector-parser/src/paths.rs`, the second trust-boundary leaf utility
after `redaction.rs`. `relativize_repo_path(repo_root, candidate)` is the single gate every touched
path passes before it becomes an `agent_file_events` / Tool Event `repo_relative_paths` field. An
absolute candidate is lexically (no filesystem access — the file may be gone by parse time) stripped
against the session's repo root and returned forward-slash repo-relative; anything not provably inside
the root collapses to the `outside_repo` sentinel. Adapted from otto `normalize.rs`
`normalize_agent_file_path` but **reworked** because otto's `~/`-prefixed fallback and hardcoded
`/apps//packages/` segment list leak structure and are otto-monorepo-specific — Trace Flow's rule is
repo-relative-or-`outside_repo`, never absolute/home/username (ADR "File facts store repo-relative
paths only"). A final `is_safe_relative` guard rejects any leftover absolute prefix, `~`/`$HOME`
marker, Windows drive letter, or `..`/root component, so a relativization bug can't leak a local path
at rest. SPDX(MIT)/provenance header. `pub mod paths;` added to `lib.rs`.
**Verified:** `cargo test -p collector-parser` 22 pass (13 paths + 7 redaction unit + 2 canary
integration). Path tests cover: file inside repo → relative, nested, in-repo `..` resolved (not
escaped), repo root → `.`, sibling/unrelated absolute → `outside_repo` (asserting no `janedoe` /
`/Users/` leak), already-relative kept, escaping `..` → `outside_repo`, `~`/`$HOME` → `outside_repo`,
empty/whitespace → `outside_repo`, Windows drive path → `outside_repo`, absolute candidate vs a
relative root → `outside_repo`, and a corpus invariant that no result ever contains a username, home
prefix, or absolute path. `cargo clippy -p collector-parser --all-targets -- -D warnings` clean;
`cargo fmt --check` clean; `cargo build --workspace` clean. CodeRabbit CLI: pass 1 returned 1
`trivial` finding (rename `clean_relative` params for clarity) — applied; the re-confirm pass 2 was
**rate-limited (out of usage credits, wait grew 5m→13m)**, but the only finding was a logic-free
rename with no open findings remaining.
**Next / blockers:** 3a stays 🚧. **Blocker for further autonomous work this run: CodeRabbit credits
exhausted** (recoverable; retry when credits reset). Remaining 3a sub-work: Claude parser (collapse
`message.usage` by `message.id`), Codex parser (sum `last_token_usage` deltas, NEVER
`total_token_usage`), tool-use+tool-result fold, capability snapshots, Codex turn-index determinism,
and the fact emitters onto `collector-contracts` (which will call `relativize_repo_path`). Then 3b /
3d.

## 2026-05-26 — 3a (`collector-parser`, partial: redaction) — t3code/ab83918d

**Status:** 🚧 in progress
**Changed:** New `packages/collector-parser` crate scaffolded into the Cargo workspace
(`members = ["packages/collector-*"]`), redaction trust-boundary module landed first. `redaction.rs`
ports the field-level secret/PII policy kept in lockstep with the merged server backstop
`apps/agent-ingest/src/redaction.ts` (2b): structure-preserving masks (Bearer header, `/Users/`
`/home/` username), then a credential **drop** pass (AWS access/secret keys, GitHub classic +
fine-grained PATs, `sk-` API keys, Slack `xox*`, URL userinfo, JWT, PEM private-key header, `$HOME`
paths), then a residual-PII **mask** (Luhn-gated cards, email, SSN, IPv4, US phone, sensitive-JSON
values). `redact_field` returns `{ value, dropped }`; a credential match withholds the whole field,
masks keep structure. The `regex` crate has no lookaround, so the TS phone lookbehind is re-expressed
as a captured leading-boundary char. Provenance/SPDX(MIT) headers on every file. No pricing, no
`cost_usd`, no `*_pk` — this crate ships tokens+model only.
**Verified:** `cargo test -p collector-parser` 9 pass (7 unit + 2 integration); the integration test
loads the **shared** `fixtures/redaction-canary.json` and asserts all 12 planted secrets are
dropped/masked with `dropped >= 1` — the same corpus the 2b TS re-redact asserts against, so the two
layers cannot drift. `cargo clippy -p collector-parser --all-targets -- -D warnings` clean;
`cargo fmt --check` clean; `cargo build --workspace` clean. CodeRabbit CLI: 2 passes; fixed the
`regex` version-floor pin (`"1" → "1.11"`). Declined pattern-expansion findings (IPv6, unformatted
9-digit SSN, Stripe keys): the pattern set is intentionally lockstep with the 2b backstop + the shared
canary; expanding it belongs in a cross-layer change that updates `fixtures/redaction-canary.json`
**and** both redactors together (outside 3a's single-crate lane).
**Next / blockers:** 3a stays 🚧. Remaining sub-work (next invocations): Claude parser (collapse
repeated `message.usage` by `message.id`), Codex parser (sum `last_token_usage` deltas, NEVER
`total_token_usage`), tool-use+tool-result fold (same `tool_use_id` → one Tool Event), repo-relative
path relativization for `agent_file_events` (no `/Users/`/`$HOME`/username; outside-repo →
`outside_repo`), capability snapshots (counts/hashes/sizes only), Codex turn-index determinism, and
the fact emitters onto `collector-contracts`. Then 3b (`collector-sync`) and 3d (headless e2e). A
future cross-layer change should add Stripe/IPv6 to the shared canary + both redactors.

## 2026-05-26 — 3c (`collector-api-client` + `collector-common`) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Two new Rust crates, both vendored from Otto with SPDX/provenance headers.
`collector-api-client` posts an `AgentIngestEnvelope` to `POST /v1/ingest`: gzips the request body
(manual `flate2`, since reqwest's `.gzip(true)` only decompresses responses), classifies every
`agent-ingest` status code into `IngestError`/`IngestOk`, and retries **only** `503 policy_unavailable`
with capped exponential backoff (cancellation-aware). `collector-common` resolves the
Claude/Codex/Cursor on-disk paths, including the macOS Cursor `workspaceStorage` root.
**Auth-header reconciliation:** the ADR shorthand said "`Bearer` Collector Credential (not Otto
Basic)," but the landed 2b worker reads the raw secret from `X-Trace-Flow-Collector-Secret`
(`apps/agent-ingest/src/auth.ts` hashes it and looks it up in `COLLECTOR_CREDS` KV). The client now
sends that header verbatim — "Bearer, not Basic" was shorthand for "a credential, not Basic," not a
literal `Authorization: Bearer`. ROADMAP 3c wording corrected to match the as-built worker.
**Verified:** `cargo test` 13 pass (7 api-client incl. auth-header shape, gzip round-trip, retry-only-
on-`policy_unavailable`, terminal-on-`enqueue_failed`/`upgrade_required`/`rate_limited`, and an
in-flight cancellation test; 6 collector-common path tests); `cargo clippy --all-targets -D warnings`
clean; `cargo fmt --check` clean. CodeRabbit CLI run to the 4-pass cap; every valid finding fixed
(cast simplification, unreachable retry-loop tail → `unreachable!()`, dropped unsafe `HOME` mutation
in tests for env-free assertions, doc comments). One "major" — swap `dirs` for `dirs-next` — was
**rejected**: `dirs` is maintained (v6 published) while `dirs-next` is frozen at 2.0.0 (2021); the
swap would regress to an abandoned crate.
**Next / blockers:** 3a (`collector-parser`) and 3b (`collector-sync`) still `☐`; 3d end-to-end needs
2e + 3a + 3b + 3c. PR #270 (Phase 2 → main) auto-updates with this push.

## 2026-05-26 — 2g (PR CI for new TS packages) — t3code/ab83918d

**Status:** ✅ done
**Changed:** `.github/workflows/ci.yml` now gates the three packages the slice-B build added.
`changes` gains `pricing`, `agent-ingest`, `agent-consumer` paths-filter outputs (each globs its own
dir plus its in-repo deps — `pricing`: `packages/types`; `agent-ingest`: `packages/types`/`utils`/`logging`;
`agent-consumer`: `packages/types`/`logging`/`pricing`/`tinybird-client`); `packages/pricing/**` is also
added to the **existing** `proxy-consumer` filter since proxy-consumer now imports the extracted package.
Three new jobs run on a matching change: `pricing` (Format check/Lint/Type check/Test, no build — it has
no build script) and `agent-ingest` + `agent-consumer` (those four plus Build), each mirroring the
existing per-package jobs. All three are added to `status.needs`, so a failure in any propagates through
`contains(needs.*.result, 'failure')`. Before 2g a PR touching only these packages matched no filter, ran
no typed job, and `status` went green regardless — the first compile happened post-merge in `deploy.yml`'s
`ci` job, where a type error blocks all production deploys. That false green is closed.
**Verified:** `actionlint .github/workflows/ci.yml` clean; `bunx turbo run lint type-check test build`
across all three filters → 11/11 tasks pass. Negative check: appending a type error to
`packages/pricing/src/index.ts` made `@trace-flow/pricing#type-check` exit 2 (`run failed: command exited
(2)`), proving the job fails (not a false green) and that `status` would red-X; reverted clean.
CodeRabbit CLI `--type uncommitted` at repo root → **0 findings** (an initial `--dir .github/workflows`-scoped
run flagged the agent apps as "non-existent", a sandbox-scope artifact — the apps exist under `apps/`).
**Next / blockers:** Phase 2 complete on this branch except 2f's live-alert provisioning (🚧, dashboard-only).
Open a PR to `main` for the Phase 2 boundary (no self-merge). Then Phase 3 (`3a` collector-parser).

## 2026-05-26 — 2f (Observability + ops runbook) — t3code/ab83918d

**Status:** 🚧 in progress — in-repo code + runbook landed and verified; live-alert provisioning is the
one outstanding item (needs dashboard access, not reachable headlessly).
**Changed:** `apps/agent-consumer/src/consumer.ts` now calls `Sentry.captureException` on the two
swallowed error paths (insert failure — tagged `operation:insert` + `datasource`; per-message
accumulate throw — tagged `operation:accumulate`) and `Sentry.captureMessage` on the structural-guard
contract-drift path (`agent_consumer.message_malformed`, the DLQ-bound signal). The batch loop catches
these to retry rather than rethrow, so without manual capture they would never reach Sentry; the
`withSentry` queue wrapper initializes the client per invocation so the manual calls report (documented
in `index.ts`). `apps/agent-ingest/src/policy.ts` adds the missing `agent_ingest.policy_unavailable`
error log on the cold-miss fail-closed return (no silent error). New
`docs/guides/agent-conversation-analytics/runbook.md`: DLQ inspect (`wrangler queues info`) /
re-drive (temporary HTTP pull consumer, idempotent under `ReplacingMergeTree FINAL`) / purge; the three
alert definitions as a contract (DLQ-non-empty via Cloudflare; consumer-error-rate via Sentry tags;
priced-coverage% via a Tinybird `countIf(cost_usd IS NOT NULL)/count(*)` drop-vs-baseline query); the
`tb`/`wrangler` teardown including what `git revert` does **not** undo; and the manual 1d Tinybird
schema-deploy (`tb --cloud deploy`, not in CI). `provisioned-resources.md` deploy-gate section corrected
to past tense (2e lifted it) and its teardown stub pointed at the runbook.
**Verified:** `turbo run lint type-check test build` on both workers — 8/8 pass; agent-consumer 41
tests (insert-failure asserts `captureException` with the `operation:insert` tag, malformed asserts
`captureMessage`), agent-ingest 65 tests (+1 asserting the `policy_unavailable` log fires before the
fail-closed return). `coderabbit review --agent --type uncommitted`: 0 findings. prettier clean on the
docs. **NOT verified (blocked, needs the user):** the three alerts firing live — there is no
alert-as-code path in this repo, so DLQ-non-empty (Cloudflare), consumer-error-rate (Sentry), and
priced-coverage% (Tinybird) must be provisioned in their dashboards from the runbook's definitions and
fire-tested there. Forced-error→Sentry and coverage-drop→alert can only be exercised against the
deployed dev workers + live Tinybird, not headlessly.
**Next / blockers:** provision + fire-test the three dashboard alerts (human ops), then flip 2f to ✅.
Continuing to 2g (independent of 2f). Phase 2 PR to `main` at the boundary — no self-merge.

## 2026-05-26 — 2e (Wrangler / dev wiring) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Bound the 0d-provisioned dev resources and lifted the deploy-gate on both agent workers.
`apps/agent-ingest/wrangler.jsonc` now binds the real `COLLECTOR_CREDS` KV namespace
(`f945ee3d71954ffabd364e3db385d3ab`) instead of the all-zero placeholder. Added both workers to
`dev:all` in the root `package.json` under the shared `--persist-to .wrangler/state` so the
producer/consumer share the `agent-ingest-dev` queue locally. Made `deploy:preview` valid: agent-ingest
flipped from `wrangler deploy --env preview` (no such env) to plain `wrangler deploy`, and agent-consumer
gained `deploy`/`deploy:dev`/`deploy:preview` (all flat `wrangler deploy`). Added `deploy-agent-ingest`
and `deploy-agent-consumer` jobs to `.github/workflows/deploy.yml` (mirror the proxy-consumer job but
`command: deploy` — no `--env production`, since the config is flat dev) and listed both in
`deploy-status.needs`. `preview.yml` needs no edit: its `turbo run deploy:preview --filter=./apps/*`
auto-discovers the now-valid scripts. Refreshed both wrangler.jsonc header comments to say they are wired
into CI. Deploys are flat (dev-named workers, dev resources) because slice B has no production agent
pipeline yet — both `deploy.yml` (on main) and `preview.yml` (on PR) target the same `*-dev` workers.
**Verified:** `wrangler deploy --dry-run` builds clean for both workers with correct bindings (ingest
shows the real `COLLECTOR_CREDS` id + `AGENT_QUEUE`→`agent-ingest-dev`; consumer shows `MODEL_PRICING`).
`bun run dev:all` boots all five workers under one `--persist-to`; both agent workers register and the
producer's `AGENT_QUEUE` and the consumer share the `agent-ingest-dev` queue name (enqueue→deliver wired
locally). `turbo run lint type-check test build` on both workers: 8/8 tasks pass (agent-ingest 64 tests).
`coderabbit review --agent --type uncommitted`: 0 findings. Did **not** drive a live authed envelope
through to a Tinybird insert — that needs a seeded local Collector Credential + the dev Tinybird token
and is covered by the 2b/2c handler suites plus the structural queue-name match.
**Next / blockers:** 2f (observability + ops runbook). Phase 2 boundary after 2g → open PR to `main`
(no self-merge).

## 2026-05-26 — 2d (models.dev pricing import) — t3code/ab83918d

**Status:** ✅ done
**Changed:** `packages/convex/billing/modelPricing.ts` gains `importFromModelsDevInternal` (daily-cron
`internalAction`) plus an admin-gated public `importFromModelsDev` wrapper, mirroring `importFromOpenRouter`.
It fetches `models.dev/api.json`, imports **first-party `anthropic`/`openai` only**, converts dollars/M →
microdollars/M via the exported pure `convertModelsDevModel`, maps the `context`-type tier (e.g. `gpt-5.5`
over 272k tokens) into a new optional `contextTier` shape, and `upsertInternal`s each model keyed verbatim
by its models.dev key (dated + undated both published, so `getPricing`'s exact-then-date-stripped lookup
resolves either), then schedules per-model `syncToKV`. Cost-less entries (the 4 OpenAI image models) skip
and resolve null; `codex-auto-review`/Cursor house models are intentionally NOT aliased (resolve null per
ADR). `schema.ts` + pricing types (`pricing.ts`) gain `contextTier` + the `'models.dev'` source literal;
`pricingSync.ts` carries `contextTier` into the KV payload; `crons.ts` registers the daily 06:30 UTC import.
**Verified:** `bunx convex dev --once` push (regenerated `_generated`); `bunx convex run
billing/modelPricing:importFromModelsDevInternal` → `{imported: 71, skipped: 4}`; `getInternal` resolves
`anthropic/claude-opus-4-7` ($5/$25/$0.5/$6.25 per M → microdollars) and `openai/gpt-5.5` (base rates +
`contextTier` threshold 272000 with $10/$45/$1) non-null, unknown model → null. `turbo run lint type-check
test` green (convex 479 + pricing); 5 new `convertModelsDevModel` unit tests. CodeRabbit `--type
uncommitted`: 0 findings.
**Next / blockers:** Phase 2 continues — 2e (Wrangler/dev wiring, incl. the missing agent-ingest/agent-consumer
deploy + preview jobs), 2f, 2g. Open a PR to `main` at the Phase 2 boundary (no self-merge).

---

## 2026-05-26 — 2c (`apps/agent-consumer` worker) — t3code/ab83918d

**Status:** ✅ done
**Changed:** New `apps/agent-consumer` CF Worker that drains `AGENT_QUEUE`, prices each Agent Message,
and writes one batched insert per base `agent_*` datasource. Stateless (no batching Durable Object,
unlike `proxy-consumer`) — redelivery is idempotent under `ReplacingMergeTree(IngestedAt)` FINAL, so a
re-POST collapses. `consumer.ts`: per-message try/catch — a malformed body (structural `isQueueMessage`
guard fails) logs `agent_consumer.message_malformed` and `retry()`s (exhausts to the DLQ, never
acked-and-dropped); a thrown mapper logs `message_process_failed` + retry; an all-malformed batch logs
`batch_all_malformed`. `flush()` issues one `insertRows` per non-empty datasource via `Promise.allSettled`;
**any** insert failure retries **every** contributing message (no ack, no silent drop — safe because
re-POST dedupes). `pricing.ts`: `PriceCache` reads the `MODEL_PRICING` catalog **once per distinct
`(provider, model)` per batch** (caches `null` too), so a backfill is O(distinct models), not O(messages);
`priceMessage` returns `null` (the only Nullable column) iff `token_coverage === 'missing'` or the model
has no rate — `claude→anthropic`, `codex→openai`, `cursor` unresolved until 2d. `rows.ts`: maps wire facts
to the exact datasource columns (CamelCase tenancy/timestamps, snake_case rest), `DateTime64(3)` literals
`"YYYY-MM-DD HH:MM:SS.mmm"`, bool→UInt8, wire `null`→non-null sentinels (`''`/`0`/epoch). The queue handler
takes `MessageBatch<unknown>` (untrusted bytes; the consumer validates). Transport core extracted to the
shared **`@trace-flow/tinybird-client`** (`insertRows` + `shouldRetryTinybirdInsert` + `TinybirdInsertError`);
`proxy-consumer/src/tinybird.ts` rewritten to call it (its local fetch/retry/error removed), `proxy-consumer`
gains the workspace dep. **No deploy/preview scripts** on `agent-consumer` (0d gate; 2e adds the deploy +
preview jobs and must also reconcile `agent-ingest`'s existing deploy scripts). Files: `apps/agent-consumer/`
(`index.ts`, `context.ts`, `consumer.ts`, `pricing.ts`, `rows.ts`, configs, `src/__tests__/`),
`packages/tinybird-client/` (`insertRows.ts` + test, `errors.ts`, `index.ts`), `apps/proxy-consumer/`
(`tinybird.ts`, `package.json`), `bun.lock`.
**Verified:** `bunx turbo run lint type-check test build --filter=@trace-flow/agent-consumer
--filter=@trace-flow/proxy-consumer --filter=@trace-flow/tinybird-client` → all green. **agent-consumer 41
tests** (priced+ack happy path, constant-cost fixture sums to the exact per-message total, unpriced→null,
missing-coverage→null, 50-msg backfill → 1 KV read, 2 models → 2 reads, malformed→retry/no-insert, sibling
isolation, insert-fail→retry-all/no-ack, one insert per non-empty datasource, empty-facts→ack; rows emit
exactly each schema's columns + sentinels; pricing context-tier boundary + null caching). **proxy-consumer
112 tests** green (transport-extraction regression). **tinybird-client 18 tests** (NDJSON POST,
URL-encoded datasource, `TinybirdInsertError` fields, retry classifier). CodeRabbit CLI: pass 1 → 4 trivial
findings (applied `vi.stubGlobal` + all-malformed log; skipped per-datasource retry granularity — retry-all
is correct under FINAL idempotency — and `toClickhouseDateTime64` range-guard — `toISOString()` already
throws → retry/DLQ, and the suggested `<0` bound rejects valid pre-epoch). Pass 2 → **0 findings**.
**Next / blockers:** Live `agent_messages FINAL` confirmation (priced rows, exact constant-cost sum,
re-post unchanged) is **not** headless-reachable; it runs in **2e** (`dev:all` + deployed `agent-ingest`/
`agent-consumer`) against the **1d** schema. Phase 2 still open: **2d** (models.dev pricing import, resolves
Cursor null cost), **2e** (Wrangler/dev wiring — add `agent-ingest`+`agent-consumer` deploy+preview jobs to
`deploy.yml`/`preview.yml` + `deploy-status.needs`, wire `AGENT_QUEUE`/DLQ/`COLLECTOR_CREDS`, add both to
`dev:all` `-c` with shared `--persist-to`, lift the 0d gate, **before** any Phase-2 merge; reconcile
`agent-ingest`'s deploy scripts), **2f** (observability+runbook), **2g** (PR CI: add `pricing`/`agent-ingest`/
`agent-consumer`/`tinybird-client` to `ci.yml` + add `packages/pricing`/`packages/tinybird-client` to the
`proxy-consumer` filter). **No PR / no merge** — Phase 2 incomplete.

## 2026-05-26 — 2b (`apps/agent-ingest` worker) — t3code/ab83918d

**Status:** ✅ done
**Changed:** New `apps/agent-ingest` CF Worker (mirrors `apps/proxy` layout, Sentry-wrapped Hono `app`).
`POST /v1/ingest` gate order (cheap → control-plane → work): auth (`X-Trace-Flow-Collector-Secret` vs
`COLLECTOR_CREDS` KV) → Content-Length pre-check + 10MB body cap (413) → JSON parse + structural envelope
guard (400) → compatibility policy (503 `policy_unavailable` cold-miss fail-closed, stale-while-degraded
otherwise) → version check (426 `upgrade_required`) → `AGENT_INGEST_LIMITER` ns **2006** (429) → empty-facts
202 no-op → re-redact backstop → assemble `*_pk`s → Convex first-writer claim (503 `session_claim_unavailable`
when unreachable, drop only conflicted sessions) → chunk to sub-128KB queue messages → `AGENT_QUEUE.send`
(`Promise.allSettled`, any failure → 503 `enqueue_failed`, never a false 202). Bindings required (no defensive
optionals); every failure logs before returning; logger flushed in `finally`. Files: `index.ts`, `context.ts`,
`auth.ts`, `policy.ts`, `ids.ts`, `ownership.ts`, `chunker.ts`, `redaction.ts`, `handler.ts`, `wrangler.jsonc`,
`package.json`, `tsconfig.json`, `vitest.config.ts`, plus `src/__tests__/` (factories + per-module specs).
`redaction.ts` is the server re-redact backstop: pass order mask → drop → residual-PII (load-bearing, see
file JSDoc), validated against the shared `fixtures/redaction-canary.json` (0a). Trust-boundary hardening:
runtime guards on the cred KV value, the fetched policy, and each Convex claim item — all fail closed.
Denylist check normalizes the same `v`-prefix as the min-version gate (closes a bypass). `bun.lock` gains the
`@trace-flow/agent-ingest` workspace entry (vitest pinned `^3.2.4` to match the other pool-workers siblings;
`api`'s vitest 4.x tree intact).
**Verified:** `bunx turbo run lint type-check test build --filter=@trace-flow/agent-ingest` → all green, **64
tests pass** (failure paths 401/413/400/426/429/503×N/202, re-redact wiring, canary corpus, chunker packing +
CATEGORIES drift guard, id determinism/fallbacks, policy semver/denylist/degrade). CodeRabbit CLI: 4 passes
(cap); applied all valid findings (allSettled enqueue, ownership/policy/cred/envelope runtime validation,
denylist normalization, redaction count accuracy, capExcerpt surrogate-safety, control-plane fetch timeouts);
skipped sibling-consistency / out-of-lane items (per-pkg `--persist-to` → 2e, `deploy:dev` matches siblings,
Stripe matcher not in the canary contract, ids parallelization). `api` gates re-run green to confirm the lock
hoist shift was benign.
**Next / blockers:** Worker is built + unit-verified but **not yet wired** — no queue/KV binding IDs, not in
`dev:all`, not in CI deploy (correct: 0d gate holds until 2e). Next claimable: **2c** (`apps/agent-consumer`,
deps 0c/1a/2b ✅) or **2d** (models.dev import, deps 0c/2a ✅). **2e MUST** add agent-ingest/agent-consumer
deploy+preview jobs (+ `deploy-status.needs`), wire `AGENT_QUEUE`/DLQ/`COLLECTOR_CREDS`/`AGENT_INGEST_SHARED_SECRET`,
and add both to `dev:all -c` with shared `--persist-to` before any Phase-2 merge. Phase 2 incomplete → **no PR/merge**.

## 2026-05-26 — 2a (Convex control plane) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Added the Convex control plane for collector ingestion. `schema.ts`: three new tables —
`collectorCredentials` (hidden hashed-secret creds, never user-facing API keys; indexes
`by_org_id`/`by_user_id`/`by_hashed_secret`), `agentSessionOwners` (OCC first-writer `OrgId+session_pk`
claim, `by_org_session`), `collectorCompatibilityPolicy` (Convex-owned min-versions + denylist,
`by_updated_at`). New files beyond the named lane (one component per file): `collectorCredentials.ts`
(generate `tfc_`-prefixed secret + SHA-256 hash, `mint`/`revoke`/`list` returning the secret hash never
to the client, KV sync on write), `agentSessionOwners.ts` (`claimSession` + pure `decideClaim`),
`collectorCompatibilityPolicy.ts` (active = latest by `updatedAt`, fail-closed). `integrations/cloudflare.ts`:
collector creds sync to a **separate** KV namespace (`CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID`, fails
loudly if unset), `syncAll` syncs only `active` creds, both collector sync actions use the same
retry/backoff as the existing sync\* actions. `integrations/tinybird.ts`: single `withRowSecurityParams`
helper stamps `api_keys`+`retention_days`+`org_id` (sentinels when absent) so **both** `generateToken`
and `generateTokenInternal` emit `org_id` — neither path can issue an agent JWT unscoped on org. `http.ts`:
shared-secret-guarded `/agent-ingest/claim-sessions` (validates org + user-in-org, capped batch, sequential
OCC claims) and `/agent-ingest/compatibility-policy` (404 `policy_unavailable` on empty = fail-closed).
`rateLimits.ts`: `mintCollectorCredential` (10/hr). New `__tests__/collectorControlPlane.test.ts`.
**Verified:** `bunx convex codegen` (run from repo root where `convex.json` lives — the functions dir is
`packages/convex` with static codegen) regenerated `_generated` and ran `tsc` clean.
`bunx turbo run lint type-check test --filter=@trace-flow/convex --force` → lint 0 errors, type-check
clean, **474 tests pass**. Collector creds absent from `apiKeys.list` (separate tables, verified by
inspection). Both token paths route through `withRowSecurityParams` (unit-tested for `org_id` emission +
sentinels). First-writer logic unit-tested (`decideClaim`); "no torn state" is the Convex OCC platform
guarantee. CodeRabbit `--agent --type uncommitted`: 9 → 3 → 2 findings across three passes, all addressed
(dropped duplicate `createdAt` for `_creationTime`; retry/backoff on collector KV sync; validate `userId`

- org membership; `.omit('hashedSecret')` public validator; `Infer`-derived `ActivePolicy`; bounded claim
  batch). Skipped with reason: KV-sync `orgId`/`userId` as `v.string()` (matches sibling sync\* actions);
  export status validator (YAGNI); `decideClaim` param `string` (keeps it a pure testable helper). The 4th
  confirmation pass was blocked by a CodeRabbit credit/rate limit; the GitHub bot review on the phase PR is
  the backstop.
  **Next / blockers:** Live `mint`/`list` runtime checks are Convex-auth-gated and not headlessly drivable
  (no `convex-test` harness here); covered by unit tests + structural inspection. Mint schedules a KV sync
  needing `CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID` (provisioned in 0d) and `AGENT_INGEST_SHARED_SECRET` for
  the claim route — wire these in 2e. Next: 2b (`apps/agent-ingest`).

## 2026-05-26 — 1d (Deploy `agent_*` schema to Tinybird) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Deployed the full agent data layer (9 `datasources/agent_*` + the 1b launch pipes, the 1c
canonical view, and the four COPY pipes) to the **cloud dev** workspace `trace_flow_dev`. Tinybird is
not in CI, so this is the manual/scripted path 2c (consumer) and 2e (end-to-end) depend on. Added
`scripts/deploy-agent-tinybird.sh`: it refuses to run unless the current cloud workspace is
`trace_flow_dev` (prod stays gated until 2e), validates offline (`tb build`) and via
`tb --cloud deploy --check`, then `tb --cloud deploy`. No new pipe/datasource files (this task only
deploys 1a/1b/1c). Prod was not touched.
**Verified:** pre-deploy, `tb --cloud sql "SELECT count() FROM agent_messages"` → `Forbidden: Resource
'agent_messages' not found`. `tb build` clean; `tb --cloud deploy --check` → all `agent_*` resources
`status: new`, no destructive ops, "Deployment is valid". Ran the wrapper → deployment #67 promoted and
live. Post-deploy, `agent_messages`, `agent_priced_usage`, and `agent_sessions` all resolve (count 0,
empty as expected — no rows inserted into shared dev); `tb --cloud datasource ls` shows all 9
`agent_*` datasources. CodeRabbit clean (pass 2; pass 1 added the offline `tb build` step to the
wrapper).
**Next / blockers:** **Phase 1 complete** (1a–1d all ✅) → phase-boundary self-merge PR to `main`.
Merging is inert for prod: Tinybird isn't in CI and `deploy.yml` has no jobs touching the agent layer
yet (added in 2e). Next claimable work is Phase 2 — 2a (Convex control plane, dep 0a ✅) is the entry
point.

## 2026-05-26 — 1c (COPY rollup pipes) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Added the canonical priced-usage view + four COPY rollups so session cost, the usage
rollups, and PR authoring cost agree by construction. `pipes/agent_priced_usage.pipe` is a generic
pipe (no `TYPE` — Forward's include-file replacement, referenced by name) that lives the subagent
dedup rule once: every direct Agent Message (top-level, nested, sidechain) counts; source-reported
subagent usage (`agent_tool_events.extracted_subagent_*`) counts only when no matching
nested/sidechain message exists for `(source, session_pk, agent_id)`, and the fallback row carries
tokens with `cost_usd` NULL + `subagent_cost_coverage = 'fallback'` (lowers priced coverage instead of
mis-counting). `pipes/agent_sessions_copy.pipe` (5 nodes) rebuilds one row per session over the view,
joining tool/file/PR base tables; `COPY_MODE replace` + unpartitioned target means a session spanning
multiple `EventAt` days collapses to one row; PR url is set only when exactly one distinct link
exists. `pipes/agent_usage_1h_copy.pipe` / `_1d_copy.pipe` roll up `usage_kind = 'direct'` rows
(MessageCount stays a true message count); `pipes/agent_tool_usage_1h_copy.pipe` reads base
`agent_tool_events FINAL` (tool mix is not a cost surface) and keeps success/failure/unknown separate.
Schedules staggered (1h `0 * * * *`, 1d `15 * * * *`, tool `30 * * * *`, sessions `45 * * * *`),
matching the `llm_usage_*_copy` hourly-refresh-of-daily-bucket convention. Added
`scripts/gen_1c_fixtures.py` and additive `org_1c` fixture rows (the 1b `org_test` endpoint tests are
untouched — every launch pipe filters by org).
**Verified:** `tb build` clean; `tb --local deploy` materialized schema; appended fixtures with zero
quarantine rows; `tb copy run` populated all four targets and a second run left counts identical
(idempotent `replace`). Asserted via `tb --local sql`: `agent_priced_usage` org*1c = 10 rows, exactly
1 `subagent_fallback` (sub1 both-forms counts the overlap once with no fallback row; sub2 fallback-only
adds one row, output 70, NULL cost, coverage `fallback`); `agent_sessions` cc1 constant-cost = 4 msgs
× 0.25 → cost 1.0 (input 400, tools 2, failure 1, files 2, PR pull/1); span1 = ONE row across
2026-05-20→05-21 (duration 86400000 ms, cost 1.0, ambiguous PR url ''); sub1 cost 0.8, sub2 cost 0.4 /
output 90. `agent_usage_1h` 10:00 bucket = 7 msgs / 3 sessions / 2.2 cost; `agent_usage_1d` 05-20 = 8
msgs / 4 sessions / 2.7; `agent_tool_usage_1h` git 3/3 success, npm 1/1 failure. `tb test run` 3/3
(1b endpoint tests green with org_1c added). CodeRabbit: pass 1 fixed 3 script nits; pass 2's 6
findings all verified false-positive (1d cron matches `llm_usage_1d_copy`; branch label correct;
ruff/ANN401 not configured; `CacheCoverage = 'full' | 'missing'` has no 'partial'; duration
non-negative by min/max; sentinel = over-engineering).
**Next / blockers:** 1c done → Phase 1 has only 1d (Deploy `agent*\*`schema to Tinybird) left. Claim
1d next; completing it closes Phase 1 and triggers the phase-boundary self-merge PR to`main`.

## 2026-05-25 — 1b (Launch-query pipes) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Added the three query-time-first launch pipes, each reading base `… FINAL` (not the 1c
rollups). `pipes/agent_failure_leaderboard.pipe` ranks `(tool_name, command_family)` by `failure_rate`
over a window, with a `min_events` display floor; `failure_rate = failure / (success + failure)` —
`unknown` is counted in `event_count` but excluded from the denominator (ADR §357), and is null when
the denominator is 0. `pipes/agent_tool_period_delta.pipe` compares the requested window against the
immediately-preceding equal-length window, ranking by `abs(count_delta)`. `pipes/agent_session_outliers.pipe`
(three nodes) aggregates per session from `agent_messages FINAL` (cost via `sum(cost_usd)`, which skips
the lone nullable column) LEFT JOIN `agent_file_events FINAL` (event + unique-path counts), ranked by
estimated cost. All three enforce `org_id` (JWT `fixed_params`), accept optional `source` /
`repo_fingerprint` filters, and clamp to `retention_days`. **Bootstrapped the repo's first `tb` test
harness:** `tests/{agent_failure_leaderboard,agent_tool_period_delta,agent_session_outliers}.yaml` plus
full-column fixtures `fixtures/agent_{tool_events,messages,file_events}.ndjson`.
**Verified:** `tb build` clean; `tb test run` 3/3 pipes (4 cases) green against committed NDJSON
fixtures with hand-computed expected aggregates — exact rows/values, not "returns rows": leaderboard
`failure_rate` excludes `unknown` (git 1/4 = 0.25 with the unknown still in `event_count` = 5), the
`min_events` floor hides the single-failure Read at 5 and surfaces it (rate 1.0) at 1; period movers
ranked by `abs(count_delta)`; null per-message cost skipped by `sum`. CodeRabbit `--type uncommitted`:
no findings (clean first pass). Four gotchas resolved: (1) String params + `parseDateTime64BestEffort`
fail `tb build` because the builder substitutes the `__no_value__` sentinel over declared defaults —
switched to `Int64` epoch-ms params + `fromUnixTimestamp64Milli` with a `now()`-relative default; (2)
`start_dt - (end_dt - start_dt)` errors (`subtractSeconds` needs a number) — compute `span_ms` in
integer ms first; (3) strict JSONPath ingestion quarantines any row missing a non-Nullable column, so
fixtures carry every column; (4) `now() - toIntervalDay(36500)` underflows DateTime's 1970 floor and
wraps to 2062 — tests pass `retention_days=20000` to neutralize the tier floor for fixed-date fixtures
(production passes 7..365).
**Next / blockers:** 1c (COPY rollup pipes) is the next claimable task (deps 1a ✅). The pipes are not
yet deployed to the cloud dev workspace — that is 1d, gated until 2e.

## 2026-05-25 — 1a (9 `agent_*` datasources) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Added the 9 `agent_*` Tinybird datasources. Five base fact tables
(`agent_messages`, `agent_tool_events`, `agent_file_events`, `agent_capability_snapshots`,
`agent_pull_request_links`) are `ReplacingMergeTree(IngestedAt)` keyed `OrgId, session_pk, <row>_pk`,
partitioned `toYYYYMMDD(EventAt)`, TTL `toDateTime(EventAt) + 1y`. `agent_sessions` is
`ReplacingMergeTree(IngestedAt)` keyed `OrgId, session_pk` with no partition key, TTL on `LastEventAt`.
Three rollups (`agent_usage_1h`, `agent_usage_1d`, `agent_tool_usage_1h`) are `AggregatingMergeTree`
keyed low-to-high cardinality with `BucketStart` leading (mirroring `llm_usage_1h`). `cost_usd
Nullable(Float64)` is the only nullable column. The 5 base fact tables carry `json:$.<col>` JSONPaths
(keys == column names) because the consumer POSTs to them via `/v0/events`; `agent_sessions` + rollups
omit JSONPaths since they are rebuilt from base `FINAL` by Copy Pipes (1c), like `llm_requests`.
**Verified:** `tb build` clean across the full project (datasources + all existing pipes). Live insert
against a local `tb` instance via `POST /v0/events?name=agent_messages` (2 rows, 0 quarantined):
same `message_pk` twice with newer `IngestedAt` → `SELECT … FINAL` count = 1 keeping the newer row
(output_tokens 999, cost_usd 0.99); a distinct `message_pk` → `FINAL` count = 2; `cost_usd: null`
ingests as `None`. Root-caused a pre-existing `tb build` failure on `otel_traces` to a stale local CLI
(4.2.1 → 4.5.8) — out of lane, fixed by updating the CLI, not the datasource. CodeRabbit: 2 trivial
findings (move `OrgId` before `BucketStart` in the two rollup sorting keys) declined as false positives
— the ADR (§Table physics, line 373) and ROADMAP (1a) explicitly specify low-to-high cardinality with
`BucketStart` leading, matching the `llm_usage_1h` template; the high-cardinality-first rule applies to
the base fact tables, which already lead with `OrgId`.
**Next / blockers:** 1b (launch-query pipes) and 1c (COPY rollup pipes) now unblocked. Schema is not
deployed to the cloud dev workspace yet — that is 1d (gated until 2e per the deploy-gate).

---

## 2026-05-25 — 0d (CF resource provisioning + deploy-gate) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Provisioned the three Cloudflare **dev** resources the agent-ingest path needs (they are
not code, so they must exist before 2b/2c/2e can bind them): queues `agent-ingest-dev`
(`0ff3e1668a604c30be4b4f80c0dde54c`) and `agent-ingest-dlq-dev`
(`1c94dd85ae294c6abdecf8d0bc82b108`), mirroring the proxy `trace-flow-requests*` pair, plus KV
namespace `COLLECTOR_CREDS` (`f945ee3d71954ffabd364e3db385d3ab`), separate from the `API_KEYS`
store. `AGENT_INGEST_LIMITER` (rate-limit namespace 2006) is config-only — no provisioning call.
Recorded all IDs + the account ID in new
`docs/guides/agent-conversation-analytics/provisioned-resources.md`, which 2e reads for wiring and 2f
extends into the teardown runbook. **Deploy-gate** confirmed by absence: `deploy.yml` / `preview.yml`
use explicit per-worker jobs (no matrix), and neither references the agent workers, so a mid-phase
self-merge to `main` leaves the agent path inert and deploy-safe until 2e adds the jobs.
**Verified:** `wrangler queues list` shows both queues; `wrangler kv namespace list` shows
`COLLECTOR_CREDS`; `grep -nE 'agent-ingest|agent-consumer' .github/workflows/{deploy,preview}.yml` →
no matches (gate holds); `prettier --check` clean on the new doc; `coderabbit review --agent` → 0
findings (one minor lifecycle-wording finding fixed first).
**Next / blockers:** none. Phase 0 (0a–0d) is complete — next is the phase-boundary self-merge of
`t3code/ab83918d` → `main`. Blast radius stayed `*-dev`.

---

## 2026-05-25 — 0c (@trace-flow/pricing package) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Extracted the per-message server-side cost chain out of
`apps/proxy-consumer/src/pricing.ts` into a new shared `@trace-flow/pricing` package
(`getPricing` / `calculateCost` / `microdollarsToDollars` / `formatCostAsString`, plus the
`ModelPricing` / `ContextTierPricing` / `CostBreakdown` types). Added **`gpt-5.5` context-tier
awareness**: `ModelPricing.contextTier` carries a `thresholdTokens` + tier rates, and `calculateCost`
swaps to the tier rates once a message's input context reaches the threshold (gpt-5.5 prices ~2x above
a 200k-token context and Codex runs near a 258k window, so a flat rate undercounts). The package prices
**one message and nothing else** — it does **not** own subagent dedup (that stays in SQL as
`agent_priced_usage.pipe`, task 1c). Canonical extraction, not a barrel: deleted the old
`pricing.ts` + its test, pointed proxy-consumer's three importers (`index.ts`, `spans.ts`,
`openrouter-pricing.ts`) and one test at `@trace-flow/pricing`, added the workspace dep. Moved the full
test suite into the package and added 4 context-tier tests (below-threshold base rate, inclusive
boundary at 200k, 258k Codex-style window, no-tier flat passthrough) plus the explicit unpriced-model →
null path. Matched the repo convention of inheriting `@cloudflare/workers-types` (the `KVNamespace`
global) from the **root** devDependency rather than re-declaring it (keeps knip clean, mirrors
`@trace-flow/utils`).
**Verified:** `bun run --filter @trace-flow/pricing test` 33/33; `bunx turbo run lint type-check test
--filter=@trace-flow/pricing --filter=@trace-flow/proxy-consumer` green (pricing 33, proxy-consumer 112
— the workerd "invalidating Durable Object" lines are info-level hot-reload noise, all 7 files pass);
`bun run knip` clean; `coderabbit review --agent --type uncommitted` → 0 findings.
**Next / blockers:** None. 0c done. **0d** (CF provisioning + deploy-gate) is the last open first-wave
task; its verify needs live `wrangler` access to a dev account (`wrangler queues list` / `kv namespace
list`) — may be a stop point if the CLI is not authed. 1a/2a/3a/3c unblocked by 0a; 2c/2d depend on 0c
(now ✅).

---

## 2026-05-25 — 0b (Rust workspace scaffold) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Added the repo-root virtual `Cargo.toml` (`resolver = "2"`, `members =
["packages/collector-*"]`) so the `collector-contracts` crate from 0a — and the future
`collector-parser`/`-sync`/`-api-client`/`-common` crates plus `apps/desktop/src-tauri` (Phase 5) —
resolve as one workspace. Glob member pattern means later collector crates join with no root edit. A
header comment records the deliberate split: Turborepo does **not** manage Cargo (a dedicated CI job,
6a, runs `cargo` directly). Added `/target/` to the root `.gitignore` and **committed the root
`Cargo.lock`** (reproducible builds for the 6a CI job and the eventual signed desktop binary; the
crate-level `.gitignore` Cargo.lock entry is now dead but harmless since the workspace lock lives at
root).
**Verified:** `cargo metadata --no-deps` resolves the workspace with `collector-contracts` as the
member; `cargo fmt --check` clean; `cargo clippy --workspace --all-targets -- -D warnings` clean;
`cargo test --workspace` green (round_trip 3/3); `coderabbit review --agent --type uncommitted` → 0
findings.
**Next / blockers:** None. 0b done. **0c** (`@trace-flow/pricing`) and **0d** (CF provisioning)
remain open in the first wave. 6a will add the cargo CI job that runs against this workspace.

---

## 2026-05-25 — 0a (wire contract + Rust mirror) — t3code/ab83918d

**Status:** ✅ done
**Changed:** First feature code for slice B. Defined the full TS wire contract in
`packages/types/src/agent-ingest.ts` (exported from `src/index.ts`): `AgentIngestEnvelope`
(`batch{source, collector_batch_id, desktop_version, parser_version, raw_upload_requested}` +
`facts{messages[], tool_events[], file_events[], capability_snapshots[], pull_request_links[]}`), every
`Agent*Fact` shape (session-grain attribution — normalized git remote, branch, head sha,
vendor*started_at — rides on `AgentMessageFact`; tool use+result folded into one `AgentToolEventFact`
with `extracted_subagent*_`), the deferred `RawSessionBundle`slot, and`AgentIngestQueueMessage`(worker→consumer, adds tenancy + assembled`_\_pk`via explicit`extends`-based queue-fact types, no
`Partial<>`). Mirrored it in a new Rust crate `packages/collector-contracts/`(serde`rename_all="snake_case"`, `enums.rs`/`facts.rs`/`envelope.rs`/`sample.rs`/`lib.rs`, a `dump_sample`example,`.gitignore`for`/target`+`Cargo.lock`). Committed two shared fixtures:
`fixtures/agent-envelope.sample.json`(generated from the Rust`sample_envelope()`, the contract
fixture both languages round-trip) and `fixtures/redaction-canary.json`(12 language-neutral cases —
AWS/GitHub/Bearer/OpenAI/Slack keys, dotenv, JWT, RSA key, absolute home paths — each tagged
drop|mask, consumed by 2b and 3a). Added a vitest setup to`@trace-flow/types` (`vitest.config.ts`,
test scripts, `@types/node`+`vitest`devDeps,`tsconfig` `types:["node"]`) with
`src/**tests**/agent-ingest.test.ts`deserializing the shared fixture into the typed envelope.
**Verified:**`cargo test -p collector-contracts`3/3 green (fixture field-equal to`sample_envelope()`,
deserialize+round-trip with no field loss, redaction-canary well-formed); `cargo fmt --check`+`cargo clippy --all-targets -- -D warnings`clean;`bunx turbo run lint type-check test
--filter=@trace-flow/types`all green (4 tests pass);`coderabbit review --agent --type uncommitted`
→ 0 findings. A serde or TS rename on either side now fails its own assertion, so the contract cannot
silently drift.
**Next / blockers:** None. 0a done. First wave continues — **0b** (Rust workspace root Cargo.toml),
**0c** (`@trace-flow/pricing`), **0d** (CF provisioning) remain open with no dependencies; **1a, 2a,
3a, 3c** unblock now that 0a is `✅`.

---

## 2026-05-25 — review hardening II (autonomous-safety rails) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Second eng-review pass over the guide, focused on the rails an autonomous self-merging
driver needs. Docs only, no feature code. **ROADMAP:** added task **1d** (explicit `tb deploy` of the
`agent_*` schema to the dev workspace; Tinybird is not in CI, so without it 2c/2e would POST to
datasources that do not exist) and task **2g** (PR CI for the new TS packages: `ci.yml`'s `changes`
filter and `status.needs` enumerate only the existing packages, so a PR touching
`pricing`/`agent-ingest`/`agent-consumer` runs no typed job and goes false-green; 2g adds their filters,
per-package jobs, and `status` needs, plus `packages/pricing/**` to the existing `proxy-consumer`
filter). Reworked the **2c** insert path from "reuse `insertIntoTinybird`" to a clean split: extract the
generic transport core (NDJSON + POST + `TinybirdInsertError`) into `packages/tinybird-client` as
`insertRows`, leave the OTel reshape in `proxy-consumer` as a thin caller; noted that non-idempotent
requeue is safe here only because `ReplacingMergeTree(IngestedAt)` keyed on `*_pk` collapses dupes under
`FINAL`. Declared **2d depends-on 2a** so the two tasks that both edit Convex `schema.ts` serialize (2a
lands the tables first). Made the **redaction canary corpus shared**: one `fixtures/redaction-canary.json`
authored in 0a, asserted against by both the Rust parser (3a) and the TS server re-redact (2b). Added
two trust-boundary tests: **2a** concurrent first-writer claim (two simultaneous claims for one
`OrgId+session_pk`, exactly one wins via Convex OCC) and **2b** policy cold-miss fail-closed (a cold
cache plus a failed policy fetch returns 503 `policy_unavailable`, never a fail-open 202). Hardened
**2e/2f** deploy completeness (new workers added to `deploy-status.needs`, not just the deploy jobs;
1d schema must be live on dev first; the 1d deploy command recorded in the 2f runbook). Pinned **1c**
`COPY_SCHEDULE` to hourly and added an `agent_sessions` whole-table-rebuild Watch-item (its `replace`
cost scales with total session count, not the recent window). Carried 1d and 2g into the slice-B task
list and "v1 slice complete when". **README:** dependency graph now shows `1d` (after 1a+1b+1c), `2g`
(after 2b+2c), and `2d` after `0c + 2a`; added a scope note that the new workers use `wrangler.jsonc`
(matching `apps/web`), not the `.toml` of the older workers, and that normalizing either way is out of
scope. An **Outside Voice** (independent sonnet review) then surfaced three more autonomous-safety
gaps, all applied: a **shared envelope contract fixture** in 0a (`fixtures/agent-envelope.sample.json`,
loaded by both the Rust round-trip and a TS deserialize test, replacing the single-sided check so a
serde or TS rename cannot silently drift); the **`agent_sessions` rebuild assertion relocated from 2c
to 1c** (2c does not depend on 1c, so it now asserts base-fact inserts only and the rollup check lives
with the pipe that owns it); and a **file_events path-privacy assertion in 3a** (every path
repo-relative, no `/Users/` or `$HOME`, outside-repo maps to `outside_repo`), so a relativization bug
fails at 3a, not only at 3d. Its proposed scope cut (drop `agent_capability_snapshots`) was
**rejected**: the ADR retains that data deliberately for deferred Context Bloat analysis, and
re-ingesting aged-out local transcripts is unreliable. The accepted **ADR was left unedited**.
**Verified:** Docs only, no build run. ROADMAP board carries 1d and 2g with resolvable `depends-on`;
the README dependency graph, Milestones legend, and slice-B task list all match the board; the new
tasks reference real anchors (`ci.yml` paths-filter and `status.needs`;
`apps/proxy-consumer/src/tinybird.ts` transport core; `apps/web/wrangler.jsonc`).
**Next / blockers:** None. Slice B is still the build target; first wave (0a 0b 0c 0d) is open. 1d is
claimable after 1a+1b+1c; 2g after 2b+2c.

---

## 2026-05-25 — review hardening (slice B + 13 edits) — t3code/ab83918d

**Status:** ✅ done
**Changed:** Applied the CEO-review hardening pass to the guide docs — no feature code. **ROADMAP:**
added tasks **0d** (provision CF queue + DLQ + `COLLECTOR_CREDS` KV; both new workers stay out of CI
deploy until 2e lifts the gate) and **2f** (observability + ops runbook); added a "Milestones" legend;
split the Done bar into "v1 slice complete when (slice B)" vs "Feature complete when (full feature)";
rewrote 0c so `@trace-flow/pricing` does per-message pricing only and `agent_priced_usage` (1c) is the
sole subagent-dedup runtime (`buildPricedUsageView` demoted to a test-spec); hardened the verification
lines on 1b/1c/2b/2c/2d/3a/4a (committed fixtures with expected aggregates; named failure paths →
503 / 5xx / DLQ / `cost_usd` null; redaction canary corpus; per-`(provider,model)` price cache +
backfill load test; Codex turn-index determinism canary; named first-party non-null pricing assertion;
dashboard LOADING/EMPTY/ERROR/PARTIAL states with no desktop CTA + a smoke assertion not "renders");
documented `DateTime64(3)` as a deliberate new convention (1a); fixed the wrong "mirror
`llm_usage_summary`" reference (1b reads base `FINAL`); added `org_id` to both `generateToken` entry
points (2a); marked the Cursor parser (in 3a), 4c, and Phases 5–6 as fast-follow. **README:** slice-B
scope decisions (Claude+Codex first; deploy-gated provisioning; observability-as-task) + dependency
graph updated with 0d/2f and fast-follow markers. **`otto-extraction-reference.md`:** new "Provenance
and licensing" section (SPDX + attribution header for vendored Otto code). The accepted **ADR was left
unedited** — its findings (DateTime64, `cost_usd` Nullable, canonical priced-usage, query-time over
base FINAL) are already documented there.
**Verified:** Docs only, no build run. ROADMAP board now carries 0d + 2f with resolvable `depends-on`;
the README dependency graph and Milestones legend match the board; cross-doc references resolve
(ROADMAP ↔ README "Scope decisions"/"Milestones"; ROADMAP 3a/3b/3c/5a ↔ `otto-extraction-reference.md`
"Provenance and licensing"; ROADMAP "v1 slice complete when" ↔ the slice-B task list).
**Next / blockers:** None. **Slice B** is the build target. First wave is open — **0a, 0b, 0c, 0d**
have no dependencies and can be claimed immediately.

---

## 2026-05-25 — guide bootstrap — docs/agent-analytics-guide

**Status:** ✅ done
**Changed:** Created `docs/guides/agent-conversation-analytics/` with `README.md` (goal +
coordination protocol + dependency graph), `ROADMAP.md` (Phase 0–6 as 24 claimable tasks), and this
`CHANGELOG.md`. No feature code.
**Verified:** Markdown renders; every ROADMAP `depends-on` ID resolves; links to the ADR and
`CONTEXT.md` resolve.
**Next / blockers:** None. First wave is open — tasks **0a**, **0b**, **0c** have no dependencies and
can be claimed immediately.
