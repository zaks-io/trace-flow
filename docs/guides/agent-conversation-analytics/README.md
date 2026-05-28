# Agent Conversation Analytics

This guide is the production-readiness source of truth for Agent Conversation Analytics.

## Current Status

Not production-ready.

What exists today:

- agent ingestion contracts and Cloudflare Worker code
- dev queue and dev consumer wiring
- Tinybird `agent_*` datasources and read pipes
- Rust parser/sync libraries for Claude and Codex
- `/app/agents` dashboard surfaces

What does not exist today:

- a production collector CLI
- a desktop app
- production agent queue/KV/DLQ/resource wiring
- production Tinybird schema deploy gate
- required Rust collector CI
- live production observability gates
- Cursor ingestion
- any normal-user path that syncs local transcripts without admin-only setup

## Production Definition

The feature is production-ready only when a normal Trace Flow user can:

1. Install or run a collector.
2. Authenticate through Trace Flow.
3. Mint a hidden Collector Credential.
4. Sync Claude and Codex transcripts through the cloud ingest Worker.
5. Have the queue and consumer process those facts server-side.
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
- Do not advertise Cursor or desktop support before those paths ship.

## Authoritative Design Docs

| Source                                                                         | Role                                                                       |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [`agent-conversation-analytics.md`](../../adr/agent-conversation-analytics.md) | Data model, tenancy, identity, pricing, and storage decisions.             |
| [`trace-flow-desktop-collector.md`](../../adr/trace-flow-desktop-collector.md) | Desktop product design. Amended: CLI ships first as the production bridge. |
| [`otto-extraction-reference.md`](../../adr/otto-extraction-reference.md)       | Reference map for vendored parser/sync code.                               |
| [`runbook.md`](./runbook.md)                                                   | Production operations contract and current dev-only limitations.           |

## Done

The docs are correct when a reader can answer:

- What can users do today?
- What is still dev-only?
- What work remains before production launch?
- Which Linear ticket owns each production gate?
