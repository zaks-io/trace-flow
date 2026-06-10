# Agent Conversation Analytics Production Roadmap

This board replaces the earlier "slice B" roadmap. The previous board treated a dev-only
Cloudflare pipeline plus ignored Rust E2E tests as a delivered ingestion product. That was wrong.

The feature is not production-ready until a normal Trace Flow user can authenticate a collector,
sync local agent transcripts through the cloud queue/consumer path, and see the data in `/app/agents`
without touching Tinybird, Wrangler, Convex dev, admin tokens, or ignored tests.

Status legend: `☐ todo` · `🚧 in progress` · `✅ done` · `⛔ blocked`

## Current Truth

| Area                     | Current state                                                                                                                                                    | Production gap                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types / parser libraries | Claude and Codex parser/sync crates exist. Cursor returns no facts.                                                                                              | No user-facing collector binary or desktop app invokes them.                                                                                                  |
| Cloud ingest             | Prod env blocks bind prod queue/DLQ/KV; `deploy.yml` deploys `--env production` behind a dev-resource guard; Tinybird prod gate + smoke harness exist (TRA-110). | Pending: deploy from `main`, Worker secrets, prod Convex env (`CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID`), prod Tinybird schema deploy, and a green smoke run. |
| Credentials              | Convex can mint hidden Collector Credentials and sync them to KV.                                                                                                | No CLI or desktop flow lets a user mint/store/use one.                                                                                                        |
| Queue / consumer         | Dev queue and consumer can process E2E harness data.                                                                                                             | No production queue/DLQ/consumer verification from a real collector.                                                                                          |
| Tinybird                 | Agent datasources and pipes exist; deploy is manual.                                                                                                             | Schema deploy is not a production release gate.                                                                                                               |
| Dashboard                | `/app/agents` exists and has chart/table surfaces.                                                                                                               | It is only useful for orgs with preloaded rows; live authenticated walkthrough is not a merge gate.                                                           |
| Observability            | Logging/Sentry hooks and a runbook exist.                                                                                                                        | Live alerts are not provisioned as a verified production gate.                                                                                                |
| CI                       | TS packages have CI coverage.                                                                                                                                    | Rust collector workspace has no required CI job.                                                                                                              |
| Product distribution     | CLI (`trace-flow`, TRA-112) and a macOS menu-bar desktop app (`apps/desktop`, TRA-115) ship the production collector path.                                       | No signed desktop release and no Connected Desktops web UX yet (P6 follow-ups).                                                                               |

## Non-Negotiable Rules

- No admin token, Tinybird token, Wrangler command, Convex dev seed, local KV seed, or ignored test
  may be used as evidence that user ingestion works.
- The client path must only hold a Collector Credential. Tinybird tokens stay server-side in the
  consumer Worker.
- `main` deploys must not deploy dev-named resources under a production environment.
- "Done" means production-verifiable, not locally demonstrable.
- Cursor support is not implied until Cursor rows land through the same production path.

## Production Board

| ID  | Task                                        | Status         | Depends on | Done                                                                                                            |
| --- | ------------------------------------------- | -------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| P0  | Rebaseline docs, Linear, and project status | 🚧 in progress | none       | Roadmap, runbook, ADR amendments, and Linear tickets stop claiming production readiness.                        |
| P1  | Production cloud ingest path                | 🚧 in progress | P0         | Prod ingest Worker, queue, DLQ, KV, rate limit, consumer, Tinybird schema, secrets, and smoke test are live.    |
| P2  | Production collector CLI                    | ☐ todo         | P1         | A user runs `trace-flow login` then `trace-flow sync --since 7d` and data appears in `/app/agents`.             |
| P3  | Dashboard truth and live walkthrough        | ☐ todo         | P1, P2     | `/app/agents` accurately shows empty/setup/data states and is verified with authenticated production-like data. |
| P4  | CI and release guardrails                   | ☐ todo         | P0         | Rust workspace, CLI build, Worker deploy, Tinybird deploy check, and live smoke block PR/merge failures.        |
| P5  | Production observability                    | ☐ todo         | P1         | DLQ, consumer errors, ingest auth failures, and priced-coverage regressions alert with tested runbook paths.    |
| P6  | Desktop MVP                                 | 🚧 in progress | P2, P4     | Installable macOS app connects, stores credential securely, gates first egress, syncs, pauses, and disconnects. |
| P7  | Cursor source support                       | ☐ todo         | P2, P4     | Cursor `state.vscdb` facts land through the same collector/cloud path and are filterable by source.             |

## Linear Tracking

| Roadmap ID | Linear  | Notes                                                      |
| ---------- | ------- | ---------------------------------------------------------- |
| Parent     | TRA-109 | Production readiness rebaseline.                           |
| P1         | TRA-110 | Production cloud ingest path.                              |
| P2         | TRA-112 | Production collector CLI.                                  |
| P3         | TRA-113 | Dashboard truth states and authenticated live walkthrough. |
| P4         | TRA-111 | CI and release guardrails.                                 |
| P5         | TRA-114 | Production observability.                                  |
| P6         | TRA-115 | Desktop MVP.                                               |
| P7         | TRA-108 | Cursor source support, now explicitly blocked on P2/P4.    |

## P1 - Production Cloud Ingest Path

### What to build

Create a real production ingest path instead of deploying dev workers from the Production workflow.
The path is:

`Collector Credential -> agent-ingest production Worker -> production queue -> agent-consumer production Worker -> production Tinybird agent_* tables -> /app/agents`

### Required work

- Add production environment blocks for `apps/agent-ingest` and `apps/agent-consumer`.
- Provision production Cloudflare resources:
  - production ingest queue
  - production DLQ
  - production `COLLECTOR_CREDS` KV namespace
  - production rate limiter namespace
  - production pricing KV binding if shared pricing cannot be safely reused
- Create scoped Worker secrets:
  - ingest: `CONVEX_SITE_URL`, `AGENT_INGEST_SHARED_SECRET`, `SENTRY_DSN`
  - consumer: Tinybird append-only token, `SENTRY_DSN`
- Deploy agent Tinybird datasources and pipes to the production workspace through a scripted release
  gate, not a manual admin-token step.
- Update `deploy.yml` so production deploys use production resource names and fail if agent Workers
  are still bound to dev resources.
- Add a post-deploy smoke test that:
  - mints or uses a test Collector Credential through the real control plane
  - submits a minimal envelope to production ingest
  - verifies the queue drains
  - verifies rows appear in Tinybird through the read API
  - verifies the dashboard query can read those rows under `org_id` JWT scoping

### Done

- No production job deploys `trace-flow-agent-*-dev`.
- No client or smoke test receives a Tinybird token.
- A valid Collector Credential submission returns `202`.
- A malformed envelope reaches DLQ or a named error path.
- Queue depth returns to zero after the consumer runs.
- The smoke org has visible `agent_message_facts` rows through `/app/agents`.

## P2 - Production Collector CLI

### What to build

Ship a minimal user-facing collector before the desktop app. The CLI is not the final UX, but it is
the fastest production path that proves users can ingest without admin-only tools.

### Required commands

- `trace-flow login`
  - opens browser or uses device flow
  - lets the user pick one Organization
  - mints a hidden Collector Credential through Convex
  - stores the secret in OS keychain/keyring
- `trace-flow sources list`
  - shows detected Claude and Codex paths
  - marks Cursor as unsupported until P7
- `trace-flow sync --since 24h|7d|30d|1y`
  - reads local transcripts
  - redacts and assembles facts
  - posts gzip envelopes to production ingest
  - advances cursors only after 2xx
- `trace-flow status`
  - shows source counts, last sync, last error class, and server reachability
- `trace-flow disconnect`
  - revokes the Collector Credential
  - removes local secret material

### Done

- A normal user can sync Claude/Codex without receiving any admin token.
- CLI logs never print secrets, absolute home paths, transcript text, command excerpts, or Tinybird
  credentials.
- Failed uploads do not advance cursors.
- Re-running sync is idempotent before Tinybird through local fact checksums and the server-side fact
  ledger.
- The CLI can be installed from a release artifact or documented package command.

## P3 - Dashboard Truth And Live Walkthrough

### What to build

Make `/app/agents` reflect the real ingestion state and make authenticated browser verification a
merge gate.

### Required work

- Empty state must say no collector has synced yet and point to the production CLI once P2 ships.
- Show source coverage: Claude, Codex, Cursor unsupported/not connected/synced.
- Show last ingested time and last successful sync per collector/source when available.
- Keep cost labeled as estimated and show priced-token coverage.
- Remove or gate any Cursor marketing until P7 lands.
- Add an authenticated browser walkthrough against a real org with agent data.

### Done

- A new org with no data gets an honest setup state.
- An org with CLI-ingested Claude/Codex data sees charts and tables.
- Cursor appears only as unsupported or absent until real Cursor rows exist.
- Browser verification covers metric switcher, source/model/repo filters, session table pagination,
  and tool reliability.

## P4 - CI And Release Guardrails

### What to build

Prevent this class of failure from merging again.

### Required work

- Add required Rust CI:
  - `cargo fmt --check`
  - `cargo clippy --workspace --all-targets -- -D warnings`
  - `cargo test --workspace`
- Add CLI build/test job once `apps/cli` exists.
- Add Tinybird deploy check to release workflows.
- Add config assertions that production deploys cannot bind dev queues/KV/worker names.
- Add live smoke as a required post-deploy job for production agent pipeline changes.
- Add docs status lint that fails if a task says production-ready while its gate is still absent.

### Done

- A Rust parser/sync regression blocks PR status.
- A dev resource accidentally wired into production blocks deploy.
- A Tinybird schema mismatch blocks release before the consumer writes bad rows.
- Documentation cannot mark the feature production-ready unless P1-P5 gates are green.

## P5 - Production Observability

### What to build

Make failures visible in production without relying on manual dashboard checks.

### Required alerts

- Ingest auth rejection spike
- Compatibility policy unavailable
- Queue backlog age/depth
- DLQ non-empty
- Consumer insert failure
- Tinybird quarantine rows
- Priced-token coverage regression
- Collector client repeated sync failures

### Done

- Each alert has an owner, threshold, and runbook section.
- A forced DLQ message triggers the DLQ alert.
- A forced Tinybird insert failure triggers consumer alerting and does not ack the message.
- A pricing-catalog regression trips coverage health.

## P6 - Desktop MVP

### What to build

Build the production desktop app after the CLI proves the ingestion path.

### Required work

- ✅ Tauri macOS app under `apps/desktop` (menu-bar tray + a small first-run window).
- ✅ OS-keychain-backed Collector Credential storage (via the shared `collector-embedder` crate; the
  CLI and desktop link one code path).
- ✅ First-run source detection, raw-upload opt-in (default off), and an explicit `Start syncing`
  first-egress gate (the engine starts paused; nothing leaves the machine before the click).
- ✅ Pause/resume, run sync, disconnect.
- ☐ Connected Desktops web surface for list/revoke/status (follow-up PR; backend
  `api.collectorCredentials.list`/`revoke` already exists).
- ☐ Signed macOS arm64 release workflow (follow-up PR; needs Apple signing + Tauri updater secrets).

### Done

- A user installs the app, connects, starts sync, sees data in `/app/agents`, quits/relaunches, and
  sync continues if autostart is enabled.
- Revoking a desktop stops future ingest without changing existing Agent Session identity.

> The app, keychain storage, egress gate, and sync engine landed in the TRA-115 desktop PR. The
> Connected Desktops web surface and the signed release workflow are tracked as the remaining P6
> follow-ups; this row stays `in progress` (not production-ready) until they land.

## P7 - Cursor Source Support

### What to build

Add Cursor only after the shared collector/cloud path is production-ready.

### Required work

- Snapshot `state.vscdb` read-only.
- Use `GLOB` prefix scans, not `LIKE`.
- Parse `composerData:` sessions and `bubbleId:` messages.
- Classify sparse token coverage honestly.
- Normalize Cursor model labels where possible.
- Add canary fixtures for schema drift and snapshot inconsistency.

### Done

- Cursor rows land through the same production collector path.
- Cursor is filterable by `source='cursor'`.
- Dashboard coverage makes Cursor's partial economics explicit.
