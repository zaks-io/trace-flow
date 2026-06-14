# Trace Flow Desktop

The menu-bar Collector (TRA-115). A macOS Tauri v2 app that runs the same production ingest path as
the `trace-flow` CLI: sign in via the browser device flow, store a Collector Credential in the OS
keychain, and sync local Claude/Codex transcripts to production ingest, visible in `/app/agents`.

The endpoint path exists, but Agent Conversation Analytics is still launch-gated by
`docs/guides/agent-conversation-analytics/ROADMAP.md`. Treat desktop sync as under verification until
the production smoke, dashboard truth states, signed release path, and observability gates are green.

It links the shared **`collector-embedder`** crate (login, keychain, connection state, source
detection, the sync drive loop, prod endpoint defaults), so the CLI and the desktop are one code path.

## Architecture

- **Tray menu** - status, per-source file counts, Sync now / Pause, autostart, open dashboard/logs.
- **First-run window** (`ui/`, static HTML + the global Tauri bridge) - source detection, the
  raw-upload opt-in (**off by default**), and the explicit **Start syncing** egress gate.
- **`src-tauri/src/engine.rs`** - the background sync loop. `collector-sync` is deliberately
  single-task and **not `Send`** (its cursor connection + upload concurrency live on one task), so each
  cycle runs on a dedicated blocking thread with a current-thread runtime, exactly like the CLI's
  `block_on`. Only the `Send` outcome crosses back to the command loop.
- **First-egress gate** - the engine starts **paused**. Nothing is read for upload or POSTed until the
  user clicks _Start syncing_. Source detection (file counts) is read-only and runs without resuming.
- **Credential storage** - the OS keychain (via `collector-embedder::keychain`, service
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

## Release

Desktop releases are manual GitHub Actions runs. For a real release, create and push the version tag
first, then dispatch from that tag:

```sh
git tag traceflow-desktop-v0.1.1
git push origin traceflow-desktop-v0.1.1
gh workflow run desktop-release.yml --ref traceflow-desktop-v0.1.1 -f platform=both -f tag=traceflow-desktop-v0.1.1
```

Defaults:

- tag: `traceflow-desktop-v{version}` from `src-tauri/tauri.conf.json`
- GitHub Latest: desktop releases own the repository Latest channel
- updater manifest: `traceflow-desktop-latest.json` from the repository Latest release
- macOS artifact names: `traceflow-desktop-macos-arm64.*`
- Windows artifact names: `traceflow-desktop-windows-x64.*`

Required repository secrets:

| Secret                               | Purpose                                     |
| ------------------------------------ | ------------------------------------------- |
| `APPLE_CERTIFICATE`                  | Base64 Developer ID `.p12`                  |
| `APPLE_CERTIFICATE_PASSWORD`         | Password for the `.p12`                     |
| `APPLE_SIGNING_IDENTITY`             | Developer ID Application identity           |
| `KEYCHAIN_PASSWORD`                  | Temporary CI keychain password              |
| `APPLE_API_ISSUER`                   | App Store Connect issuer ID                 |
| `APPLE_API_KEY`                      | App Store Connect key ID                    |
| `APPLE_API_KEY_BASE64`               | Base64 App Store Connect private key `.p8`  |
| `TAURI_UPDATER_PUBLIC_KEY`           | Public key embedded in release Tauri config |
| `TAURI_SIGNING_PRIVATE_KEY`          | Private key for Tauri updater artifacts     |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the Tauri updater private key  |

## Follow-up work (not in this MVP)

These remaining TRA-115 acceptance criteria are tracked as separate PRs:

- **Connected Desktops web surface** — `/app/collectors` listing devices (name, platform, last seen,
  status) with revoke, over the existing `api.collectorCredentials.list` / `revoke`. Revoke does not
  change Agent Session identity (ownership is pinned to `userId` in `agentSessionOwners`,
  independent of `collectorId`).
- **Linux desktop target** and **Cursor source** (TRA-108) are out of scope for the macOS/Windows MVP.
