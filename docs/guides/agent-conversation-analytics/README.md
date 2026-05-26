# Agent Conversation Analytics — Implementation Guide

This is the execution companion to the accepted ADR
[`agent-conversation-analytics.md`](../../adr/agent-conversation-analytics.md). The ADR is the design
source of truth; this guide tracks **who builds what, in what order, and how we know it works**, so
several agents can chip away at the feature in parallel without colliding.

## Goal

Make Trace Flow the analytics system of record for local AI-agent activity (Claude Code, Codex,
Cursor) alongside proxied LLM Requests:

1. **Facts in ClickHouse** — every agent fact lands in typed, deduped, server-priced `agent_*`
   Tinybird datasources that mirror the `llm_requests` pattern.
2. **Dashboards** — those facts are queryable in the web app (failure leaderboard, period delta,
   session outliers, repo views, coverage %).
3. **Desktop collector** — a macOS app (Trace Flow Desktop) parses local transcripts and syncs
   continuously with no manual steps.

## Authoritative sources (read before claiming a task)

| Source                                                                             | What it gives you                                                                                         |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`adr/agent-conversation-analytics.md`](../../adr/agent-conversation-analytics.md) | The design: data model, identity/dedupe, table physics, cost, launch queries. **Column lists live here.** |
| [`CONTEXT.md`](../../../CONTEXT.md)                                                | Vocabulary. Use the exact terms (Agent Session, Tool Event, Collector Credential, EventAt, …).            |
| [`adr/trace-flow-desktop-collector.md`](../../adr/trace-flow-desktop-collector.md) | Desktop product shape (Phase 5).                                                                          |
| [`adr/otto-extraction-reference.md`](../../adr/otto-extraction-reference.md)       | File map for vendoring Otto's parser/sync code (Phase 3). `~/src/otto` is read-only reference.            |
| [`adr/r2-storage-caps.md`](../../adr/r2-storage-caps.md)                           | Raw-replay storage budget (deferred).                                                                     |
| [`adr/provider-usage-tracking.md`](../../adr/provider-usage-tracking.md)           | Separate feature — **not** in this scope.                                                                 |

This guide never restates the design. If you need a column list or an engine choice, the ADR wins.

## How to use this guide (coordination protocol)

Work is split into claimable **tasks** in [`ROADMAP.md`](./ROADMAP.md). Multiple agents run at once,
so a few rules keep lanes from colliding:

1. **Pick** a task whose status is `☐ todo` and whose every dependency is `✅ done`.
2. **Claim** it: in `ROADMAP.md`, set its status to `🚧 <branch-name>` and open that branch off `main`.
3. **Stay in lane** — only touch the files/dirs listed for your task. Needing another task's files is
   a signal to coordinate (or the split is wrong; note it in the CHANGELOG).
4. **Verify** using the task's verification line before calling it done.
5. **Land** it: set status to `✅ done`, then **prepend** an entry to
   [`CHANGELOG.md`](./CHANGELOG.md) (newest-first, so parallel PRs merge cleanly).
6. **Blocked?** Add a `⛔ blocked` CHANGELOG entry describing the blocker even if the task isn't done,
   and leave the ROADMAP status as `🚧` with a short note.

One PR per task (or per tightly-coupled task group). The ROADMAP status and CHANGELOG are the only
shared state between agents — keep them honest.

## Dependency graph

Claim only tasks whose dependencies are all `✅`. Tasks on the same line can run concurrently.

```text
First wave (no deps):   0a   0b   0c   0d
After 0a:               1a       2a       3a   3c
After 0c:               2d
After 1a:               1b   1c   (+ unblocks 2c's insert target)
After 2a:               2b   4b   4c•
After 2b:               2c (also needs 0c, 1a)
After 2b + 2c:          2e   2f
After 2e + 3a/3b/3c:    3d        (3b needs 3a)
After 1b + 2a:          4a        (meaningful once 3d lands real data)
After 3d:               5a• -> 5b• -> 6b•
After 5a:               5c•
After 0b:               6a•

• = fast-follow, not slice B. The Cursor parser inside 3a is also deferred (3a ships Claude + Codex
for slice B). Everything unmarked is the v1 autonomous milestone — see the ROADMAP "Milestones" legend.
```

## Scope decisions baked in

- **Claude + Codex first (slice B); Cursor and the desktop app are fast-follow.** The first
  autonomously-built milestone ships the economic-truth path for the two sources that carry full
  token+model economics: headless collector → deduped, server-priced facts → the three launch
  dashboards. The Cursor `state.vscdb` parser (largest net-new, most schema-fragile, ~0.9% token
  coverage) and Phases 5–6 (Tauri desktop, signed release) land as a fast-follow. The pipeline is
  **source-agnostic** (`source` is a dimension, not a branch), so Cursor returns as a parser-only
  change. See the ROADMAP "Milestones" legend and "v1 slice complete when".
- **Provisioning is deploy-gated (0d → 2e).** A Phase-0 task provisions the CF queue + DLQ and
  `COLLECTOR_CREDS` KV and keeps both new workers **out of the CI deploy workflow until 2e** completes
  the end-to-end path, so a mid-phase self-merge to `main` leaves an inert, deploy-safe state. The
  `AGENT_INGEST_LIMITER` (2006) is config-only in `wrangler.jsonc`.
- **Observability is a task, not an afterthought (2f).** Structured logs, Sentry, and DLQ /
  error-rate / priced-coverage% alerts ship in Phase 2, so no ingest failure is silent once real data
  flows. The driver self-merges Phases 0–4 to `main`, so every failure path is named, tested, logged.
- **Raw transcript replay is deferred.** The `raw_upload_requested` flag and `RawSessionBundle` slot
  stay plumbed through the contract so it's additive later, not a rewrite (`r2-storage-caps.md`).
- **macOS arm64 first.** The release workflow scaffolds the Windows x64 matrix entry (commented) so
  it activates without a rewrite.
- **Rate-limit namespace:** `AGENT_INGEST_LIMITER` = **2006**. The ADR said `2005`, but that's
  already `TOKEN_REFRESH_LIMITER` in `apps/web/wrangler.jsonc`.
- **Provider usage / codexbar is out of scope** — separate feature, separate ingest path.

## Status at a glance

See [`ROADMAP.md`](./ROADMAP.md) for the live board and [`CHANGELOG.md`](./CHANGELOG.md) for history.
