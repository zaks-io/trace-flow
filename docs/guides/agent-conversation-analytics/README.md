# Agent Conversation Analytics

This guide is the production-readiness source of truth for Agent Conversation Analytics.

## Current Status

Not production-ready.

What exists today:

- encrypted R2 agent deliveries, versioned canonical facts, and Workers that coordinate snapshots
- dev and production-configured queue/consumer wiring
- Tinybird `agent_*` datasources and read pipes
- Rust parser/sync libraries for Claude Code, Codex CLI, and macOS Cursor
- user-facing `trace-flow` CLI code path for login, source listing, sync, status, and disconnect
- macOS/Windows Tauri desktop Collector code path using the shared collector embedder
- published macOS arm64 and Windows x64 installers with signed updater artifacts and a manifest-last
  channel
- required Rust workspace CI and a release-gated CLI build
- Convex Collector Credential mint/revoke/KV sync and Agent Session ownership claims
- `/app/agents` dashboard surfaces

What does not exist today:

- a green production smoke proving the normal-user collector path end to end
- a published CLI installer artifact; the tagged `/install.sh` target currently resolves to no release
- Connected Desktops web surface for list/revoke/status
- live production observability gates
- normal-user production verification for macOS Cursor ingestion
- launch-level dashboard truth states for empty/setup/data flows
- final release evidence that a normal user can sync local transcripts without operator setup

## Native session identity and explicit lineage

The Collector stores native `vendor_session_id` with each Agent Message fact. Its `session_pk` is a hash of `(source, vendor_session_id)`; every read still filters by Organization. Claude subagent messages share the parent session key and retain a separate `agent_id`. Codex subagent threads have their own session key. When a Codex transcript names a direct `parent_thread_id`, the Collector sends that exact `parent_vendor_session_id`, and Agent Ingest derives `parent_session_pk` from `(codex, parent_vendor_session_id)`. Missing parent metadata stays unknown. Forks and inferred nesting are not parent edges.

`agent_session_identity` reads live `agent_message_fact_versions` after tombstones. It accepts one bounded lookup: `session_pk`, paired `native_source` and `native_session_id`, or paired `native_source` and `parent_session_pk`. The endpoint is available only to the Web read token with a fixed `org_id`; it returns native identity, unique Claude agent IDs, depth, and event bounds without money or token totals. A session with competing nonempty parent pairs reports `parent_identity_status = conflicting` and leaves the scalar parent fields empty. Older Codex facts are not backfilled; new syncs can add the edge. Proxy execution metadata is queried separately through `traces_list`; it does not join or deduplicate Agent facts.

The versioned message datasource retains parent columns. Historical rows read as empty parents, while new rows retain the supplied values. TRA-405 removes the completed migration overlay and pre-versioning tables.

## Production Definition

The feature is production-ready only when a normal Trace Flow user can:

1. Install or run a collector.
2. Authenticate through Trace Flow.
3. Mint a hidden Collector Credential.
4. Sync a supported Claude Code, Codex CLI, or macOS Cursor source through the cloud ingest Worker.
5. Have the queue and consumer process durable delivery references and publish those facts server-side.
6. See the data in `/app/agents`.
7. Revoke the collector.

The user must never need a Tinybird token, Wrangler access, Convex dev deployment, local KV seed, or
ignored Rust test.

## Coordination

Use [`ROADMAP.md`](./ROADMAP.md) for the production board. It supersedes the earlier slice-B board.

Rules:

- A task is `✅ done` only when its "Done" section is verifiably true.
- Dev-only harnesses can support implementation, but cannot satisfy production acceptance.
- Keep Linear tickets and docs aligned before assigning agent work.
- Keep Cursor copy scoped to macOS and private-alpha verification until its normal-user production
  walkthrough passes.

## Authoritative Design Docs

| Source                                                                                                               | Role                                                                       |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`0012-agent-conversation-analytics.md`](../../adr/0012-agent-conversation-analytics.md)                             | Data model, tenancy, identity, pricing, and storage decisions.             |
| [`0015-trace-flow-desktop-collector.md`](../../adr/0015-trace-flow-desktop-collector.md)                             | Desktop product design. Amended: CLI ships first as the production bridge. |
| [`0017-otto-extraction-reference.md`](../../adr/0017-otto-extraction-reference.md)                                   | Reference map for vendored parser/sync code.                               |
| [`0019-agent-analytics-derived-signal-read-models.md`](../../adr/0019-agent-analytics-derived-signal-read-models.md) | Derived signal read models for dashboard and MCP guidance.                 |
| [`0024-bounded-agent-ingestion.md`](../../adr/0024-bounded-agent-ingestion.md)                                       | Current delivery, canonical fact replacement, and snapshot design.         |
| [`runbook.md`](./runbook.md)                                                                                         | Production operations contract and current dev-only limitations.           |
| [`signal-catalog.md`](./signal-catalog.md)                                                                           | Evidence-based signal confidence, non-signals, and parser gaps.            |

## Done

The docs are correct when a reader can answer:

- What can users do today?
- What is still dev-only?
- What work remains before production launch?
- Which Linear ticket owns each production gate?
- Which agent analytics signals are trustworthy, directional, or too weak to productize?
- Why dashboard and MCP guidance must read bounded derived signal models instead of raw facts?
