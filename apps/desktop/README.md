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
- **First-run window** (`ui/`, static HTML + the global Tauri bridge) - source detection and the
  explicit **Start syncing** egress gate.
- **`src-tauri/src/engine.rs`** - the background sync loop. `collector-sync` is deliberately
  single-task and **not `Send`** (its cursor connection + upload concurrency live on one task), so each
  cycle runs on a dedicated blocking thread with a current-thread runtime, exactly like the CLI's
  `block_on`. Only the `Send` outcome crosses back to the command loop.
- **First-egress gate** - on a fresh install the engine starts **paused**. Nothing is read for upload
  or POSTed until the user clicks _Start syncing_. Source detection (file counts) is read-only and runs
  without resuming. The choice is persisted in the app config dir (`settings.json`), so a relaunch
  (login autostart, an update) comes back syncing and runs a catch-up cycle immediately.
- **Catch-up after downtime** - the incremental window is measured back from the last complete sync
  recorded in the cursor DB, not from now, so files edited while the app was closed are still picked
  up (up to the 1-year retention horizon).
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

Desktop releases run automatically when desktop or shared Collector code lands on `main`. CI builds,
signs, and notarizes both platforms, then publishes the updater artifacts to the public R2 download
channel. The manifest is written last, so a partial upload never becomes the current release.

The version is generated as `{configured major}.{configured minor}.{GitHub run number}`. This keeps
every published build newer than the previous one without a version-bump commit. CI rejects a release
whose generated version is not newer than the published manifest.

Use a manual run for a rebuild or a platform-only test:

```sh
gh workflow run desktop-release.yml --ref main -f platform=both -f release_notes='Release notes'
```

Only a `both` run from `main` publishes. Single-platform runs build signed CI artifacts without
changing the public update channel.

Published paths:

- updater manifest: `https://downloads.zaks.sh/trace-flow/desktop/latest.json`
- current macOS installer: `https://downloads.zaks.sh/trace-flow/desktop/latest/trace-flow-desktop.dmg`
- current Windows installer: `https://downloads.zaks.sh/trace-flow/desktop/latest/trace-flow-desktop-setup.exe`
- immutable updater artifacts: `https://downloads.zaks.sh/trace-flow/desktop/{version}/...`

Builds installed before the updater plugin shipped need one manual install from the current installer
link. After that, **Update to latest** in the window or tray installs signed updates and restarts the
app.

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

The `Production` GitHub environment must also provide `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`. The token needs write access to the existing `static` R2 bucket.

## Follow-up work (not in this MVP)

These remaining TRA-115 acceptance criteria are tracked as separate PRs:

- **Connected Desktops web surface** — `/app/collectors` listing devices (name, platform, last seen,
  status) with revoke, over the existing `api.collectorCredentials.list` / `revoke`. Revoke does not
  change Agent Session identity (ownership is pinned to `userId` in `agentSessionOwners`,
  independent of `collectorId`).
- **Linux desktop target** and **Cursor source** (TRA-108) are out of scope for the macOS/Windows MVP.
