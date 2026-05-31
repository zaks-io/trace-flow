# Trace Flow Desktop

The menu-bar Collector (TRA-115). A macOS Tauri v2 app that runs the same production ingest path as
the `trace-flow` CLI: sign in via the browser device flow, store a Collector Credential in the OS
keychain, and sync local Claude/Codex transcripts to production ingest — visible in `/app/agents`.

It links the shared **`collector-embedder`** crate (login, keychain, connection state, source
detection, the sync drive loop, prod endpoint defaults), so the CLI and the desktop are one code path.

## Architecture

- **Tray menu** — status, per-source file counts, Sync now / Pause, autostart, open dashboard/logs.
- **First-run window** (`ui/`, static HTML + the global Tauri bridge) — source detection, the
  raw-upload opt-in (**off by default**), and the explicit **Start syncing** egress gate.
- **`src-tauri/src/engine.rs`** — the background sync loop. `collector-sync` is deliberately
  single-task and **not `Send`** (its cursor connection + upload concurrency live on one task), so each
  cycle runs on a dedicated blocking thread with a current-thread runtime — exactly like the CLI's
  `block_on`. Only the `Send` outcome crosses back to the command loop.
- **First-egress gate** — the engine starts **paused**. Nothing is read for upload or POSTed until the
  user clicks _Start syncing_. Source detection (file counts) is read-only and runs without resuming.
- **Credential storage** — the OS keychain (via `collector-embedder::keychain`, service
  `trace-flow-collector`). Never argv, config, or logs.

## Develop

```sh
cd apps/desktop
bun install
bun run desktop:dev      # launch the menu-bar app
```

Endpoints default to production; override per environment:

- `TRACE_FLOW_CONVEX_SITE_URL` — Convex site origin for the login device flow.
- `TRACE_FLOW_INGEST_URL` — ingest Worker base URL.
- `TRACE_FLOW_WEB_URL` — dashboard URL the tray "Open dashboard" item opens.

Rust gates (run by the workspace `rust` CI job): `bun run rust:fmt`, `rust:check`, `rust:clippy`,
`rust:test`.

## Follow-up work (not in this MVP)

These remaining TRA-115 acceptance criteria are tracked as separate PRs:

- **Connected Desktops web surface** — `/app/collectors` listing devices (name, platform, last seen,
  status) with revoke, over the existing `api.collectorCredentials.list` / `revoke`. Revoke does not
  change Agent Session identity (ownership is pinned to `userId` in `agentSessionOwners`,
  independent of `collectorId`).
- **Signed macOS arm64 release** — a `desktop-release.yml` workflow (a standard `tauri-action` matrix
  build with Apple code-signing + a Tauri updater manifest). Needs Apple signing + Tauri updater
  secrets provisioned in the repo. Also set a real CSP in `tauri.conf.json` (currently `null` for the
  local static UI) as part of release hardening.
- **Windows/Linux targets** and **Cursor source** (TRA-108) are out of scope for the macOS MVP.
