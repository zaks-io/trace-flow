# Otto Extraction Reference

Status: reference

Captured: 2026-05-25

This note records the Otto files to consult when implementing the Collector work described in [Agent Conversation Analytics](./agent-conversation-analytics.md) and [Trace Flow Desktop Collector](./trace-flow-desktop-collector.md). Otto is proof-of-concept source material, not a contract to preserve. Trace Flow vendors and refactors the working parser, source discovery, git/remote resolution, sync loop, and desktop shell patterns behind Trace Flow-owned types, tests, privacy rules, ingest contracts, IDs, pricing, and storage.

The Otto checkout used for this survey was `~/src/otto`.

## Provenance and licensing

Otto is the user's own code, so vendoring it into Trace Flow carries no third-party license obligation today. But the Collector parser is a stated **possible future OSS release**, and `~/src/otto` ships no license file, so record provenance at vendor time rather than reconstruct it from git history later. The ROADMAP tasks that create the `collector-*` packages (3a, 3b, 3c) and adapt the desktop shell (5a) point here for this rule:

- **Every vendored or adapted file** carries a short header naming the Otto source it derives from plus an SPDX identifier, e.g.:

  ```rust
  // SPDX-License-Identifier: <chosen license>
  // Vendored and refactored from otto-parser/src/parser/claude_code/mod.rs (~/src/otto, 2026-05-25).
  // Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.
  ```

- Pick the SPDX license once — the repo's existing license unless the OSS plan dictates otherwise — and apply it uniformly. Do not leave vendored files unlicensed.
- Low stakes (the user owns both sides) and cheap, but it keeps the maybe-OSS path open without an archaeology pass.

## Primary Rust References

These files are the main implementation references for code extraction:

- `crates/otto-parser/src/parser/mod.rs` - source dispatch. Claude and legacy Cursor share the Claude parser; Codex uses its own parser.
- `crates/otto-parser/src/parser/claude_code/mod.rs` - Claude Code JSONL parser, legacy Cursor path-derived cwd inference, usage extraction, subagent metadata, message and tool block parsing.
- `crates/otto-parser/src/parser/claude_code/tools.rs` - Claude tool extractors for `Read`, `Edit`, `MultiEdit`, `Write`, `Bash`, `Task` / `Agent`, `Grep`, `Glob`, and no-op web tools.
- `crates/otto-parser/src/parser/codex_cli/mod.rs` - Codex transcript parser for `session_meta`, `turn_context`, response items, pending assistant/tool-result handling, model, token, and cwd extraction.
- `crates/otto-parser/src/parser/codex_cli/blocks.rs` - Codex tool use/result extraction, exit-code parsing, patch-file extraction, and output/error preview handling.
- `crates/otto-parser/src/parser/codex_cli/context.rs` - Codex execution context, sandbox/approval policy, dynamic tool names, and task events; useful input for capability snapshots.
- `crates/otto-parser/src/parser/codex_cli/usage.rs` - Codex token-count parsing and cache-hit ratio.
- `crates/otto-parser/src/parser/derive_facts.rs` - derived operational facts: rate-limit pressure, approval/sandbox policy, web/search/task fields, and bash command-family classification.
- `crates/otto-parser/src/parser/normalize.rs` - timestamp parsing, content flattening, and path normalization. Reuse carefully because Trace Flow stores repo-relative file facts only.
- `crates/otto-parser/src/parser/redaction.rs` - existing secret and home-path redaction patterns.
- `crates/otto-parser/tests/snapshots.rs` plus `crates/otto-parser/tests/fixtures/real/` - best regression baseline for parser behavior.

## Sync, Discovery, Watch, And Git

Use these for Collector runtime shape:

- `crates/otto-sync/src/engine.rs` - end-to-end sync loop: discover files, cursor skip, parse, git enrichment, normalize, upload chunks, cursor update, aggregate refresh.
- `crates/otto-sync/src/files.rs` - source file walking and source file-name matching.
- `crates/otto-sync/src/git.rs` - git root, branch, and remote resolution.
- `crates/otto-sync/src/watcher.rs` - debounced recursive file watcher grouped by source.
- `crates/otto-sync/src/orchestrator.rs` - pause/resume/stop/watch/backfill orchestration.
- `crates/otto-sync/src/types.rs` - sync modes, progress events, discovered-file metadata, and ingest path/tuning config.
- `apps/desktop/src-tauri/src/source_discovery.rs` - desktop source-count loop.
- `apps/desktop/src-tauri/src/state.rs` - tray app state model. Useful as a shape reference, but Trace Flow's state model is different.

## Contracts To Compare, Not Copy

These files document Otto's current wire and backend shape. They are useful for understanding field provenance and limits, but Trace Flow must replace the contract around the extracted code.

- `crates/otto-coding-contracts/src/lib.rs` - Rust wire structs and truncation/normalization limits.
- `packages/coding-contracts/src/agentImport.ts` - Zod mirror of Otto's ingest contract.
- `packages/backend/convex/agentImport/validators.ts` - Convex validators for normalized events.
- `packages/backend/convex/schema.ts` around `agentSources`, `agentImportBatches`, `agentConversations`, `agentMessages`, `agentToolEvents`, `agentToolFileUsageStats`, and `agentHourlyAnalyticsStats` - prior art for source, batch, conversation, message, tool, file, and rollup semantics.

Trace Flow does not inherit Otto's API-key auth, Convex ingest shape, local-pricing fields, row IDs, storage schema, or product state.

## Backend Semantics Worth Mining

These files are useful for understanding how Otto currently dedupes and summarizes events:

- `packages/backend/convex/http/coding/agentImport.ts` - HTTP ingest handler, chunking, progress updates, and sync response shape.
- `packages/backend/convex/agentImport/processChunk.ts` - dedupe, conversation aggregation, tool event inserts, repo linking, inline analytics, and file usage aggregation.
- `packages/backend/convex/agentImport/repoIdentity.ts` - conservative cwd fallback logic.
- `packages/backend/convex/agentAnalytics/queries.ts` - analytics query semantics.
- `packages/backend/convex/agentAnalytics/fileUsageReport.ts` - file usage and repeat-attention analysis.
- `packages/backend/convex/agentOps/queries.ts` - operational and PR-oriented query semantics.
- `packages/backend/convex/agentConversations/queries.ts` - report-facing conversation, model, repo, tool, and recent-session queries.

Mine the semantics and edge cases, not the persistence model. Trace Flow writes bespoke Tinybird fact tables and rollups through the Collector ingest Worker and queue.

## Explicit Gaps And Replacements

- Cursor: Otto parses legacy `~/.cursor/projects` JSONL. Trace Flow must target current Cursor `state.vscdb` stores (`cursorDiskKV`, `composerData:` sessions, `bubbleId:` messages) using read-only SQLite and indexed `GLOB` prefix scans.
- Pricing: Otto prices locally through parser/sync price maps. Trace Flow prices server-side in the consumer from model and token facts.
- Tool reconciliation: Otto emits tool-use and tool-result blocks separately. Trace Flow folds each pair into one Tool Event fact before sync.
- Capability snapshots: Otto has useful Codex hints (`base_instructions`, `dynamic_tools`) but no normalized Capability Snapshot contract. Trace Flow defines this contract.
- Identity: Otto parser-local IDs and Convex row identity are not Trace Flow dedupe keys. Trace Flow assembles canonical IDs in the ingest Worker.
- Desktop state: Otto desktop identity, config paths, secrets, app data, autostart entries, updater URLs, and local state are not migrated. Trace Flow Desktop starts with Trace Flow-branded state.

## Related Otto ADRs

These Otto docs explain why the useful code is concentrated in Rust crates:

- `docs/adr/0001-pivot-to-coding-agent-observability.md`
- `docs/adr/0003-single-source-rust-parser.md`
- `docs/adr/0004-flat-cli-command-surface.md`
- `docs/adr/0006-clean-break-cli-config-compat.md`
