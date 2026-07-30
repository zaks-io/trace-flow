# Trace Flow Desktop Collector

Status: accepted

Captured: 2026-05-24

Production-readiness amendment: 2026-05-28

Trace Flow Desktop is still the intended product surface, but it is no longer allowed to block the
first production proof of ingestion. A minimal `trace-flow` CLI may ship first to prove the real
Collector Credential -> cloud ingest -> queue -> consumer -> Tinybird -> dashboard path. The CLI is a
production bridge, not a dev harness: it must mint/use Collector Credentials through Trace Flow,
store secrets outside argv/config/logs, and never require Tinybird, Wrangler, Convex dev, or local KV
access. Desktop work follows once that path is production-verifiable.

Trace Flow Desktop is the v1 product surface for the local **Collector**. The Collector vendors and refactors Otto's working code (parser, source discovery, sync, and remote resolution) behind Trace Flow-owned contracts rather than rebuilding it; what it does not inherit is Otto's product identity or runtime state. Trace Flow Desktop gets new branding, app identity, local state, release channels, consent flow, and packaging. The goal is a legacy-free desktop app that users install, connect once, explicitly start, and then leave running in the menu bar/tray. See [Otto Extraction Reference](./0017-otto-extraction-reference.md) for the implementation reference map.

## Decision

Trace Flow Desktop lives at `apps/desktop` with package name `@trace-flow/desktop` and Tauri product name `Trace Flow Desktop`. Shared Rust packages live under `packages/collector-*` (`collector-sync`, `collector-parser`, `collector-api-client`, `collector-common`, `collector-contracts`). A `trace-flow` CLI may be scaffolded under `apps/cli`, but it is not the primary v1 interface and does not drive desktop behavior.

The desktop app embeds shared Collector libraries directly rather than shelling out to the CLI. It owns connect, continuous watching, autostart, pause/resume, status, source settings, history import, and background sync.

## Product Boundary

The product name is **Trace Flow Desktop**. **Collector** remains the architecture term for the local parsing and sync component. External artifacts carry the Trace Flow Desktop brand, including `traceflow-desktop-latest.json`, `traceflow-desktop-v{version}` tags, and platform artifact names such as `traceflow-desktop-macos-arm64` and `traceflow-desktop-windows-x64`.

Otto is not a state lineage. Trace Flow Desktop gets a new Tauri identifier, app data directory, config path, Stronghold vault, autostart entry, log directory, machine id, release channel, and updater URL. It does not automatically import Otto config, API keys, last-sync state, path caches, local databases, or any other Otto-branded state.

## Setup And Consent

Login alone does not start syncing. First-run setup configures parsed fact sync only: it shows detected Sources and autostart, but no raw-transcript upload choice. Detected Claude, Codex, and Cursor Sources are enabled by default, visible before data egress, and can be disabled before the user clicks **Start syncing**. Sync begins only after the user clicks **Start syncing**.

Sources differ in what they yield, which sets implementation expectations. Claude and Codex carry full token, model, and cache economics. Cursor's real store is `state.vscdb` (a VS Code-style SQLite key-value DB, table `cursorDiskKV`, in globalStorage and per-workspace storage), not the `~/.cursor/projects` JSONL or `~/.cursor/acp-sessions` protobuf stores; it carries session-grain model (`composerData:` rows, Cursor-specific labels needing normalization) and sparse message-grain token counts (`bubbleId:` rows, nonzero on ~1% of bubbles), with cache coverage marked missing. So the full cost, token, and cache product is Claude plus Codex; Cursor adds model attribution and partial tokens. The Collector snapshots Cursor's DB before reading and uses `GLOB` prefix scans, never `LIKE`. See [Agent Conversation Analytics](./0012-agent-conversation-analytics.md) Data quality verification.

Default Source paths are platform-specific. On macOS, defaults are `~/.claude/projects`, `~/.codex/sessions`, and `~/Library/Application Support/Cursor/User/{globalStorage,workspaceStorage}`. On Windows, defaults are `%USERPROFILE%\.claude\projects`, `%USERPROFILE%\.codex\sessions`, and `%APPDATA%\Cursor\User\{globalStorage,workspaceStorage}`. Linux defaults are deferred with Linux packaging. Users can add custom Source paths when defaults are wrong; absolute Source paths stay local-only.

Parsed fact sync is the normal analytics path for every Organization. Lossless transcript upload has no separate toggle or 90-day mode: it occurs only after Pro Archive Activation and per-Collector Enrollment.

First-run parsed fact sync is incremental by default. It records `collector_started_at` when the user clicks **Start syncing** and includes files modified within the preceding 24 hours to catch active sessions. Parsed fact history import is a separate explicit action with v1 presets: 7 days, 30 days, or 1 year. Conversation Archive enrollment has its own all-currently-available-history choice because the archive is not bounded by the one-year fact horizon.

Autostart is visible and enabled by default before **Start syncing**. Users can turn it off during setup or later in settings.

## Runtime Behavior

Trace Flow Desktop is a menu-bar/tray app with a small settings window. The tray shows compact operational status for detected enabled Sources, last sync, pause/resume, run sync/import controls, recent errors, logs, and quit. Settings owns connect/login, Archive enrollment, Source enablement, custom Source paths, autostart, diagnostics export, owner-only Archive Export, and dashboard links.

For the primary case, a Pro owner selects **Enable Conversation Archive** in Settings. One guided flow performs interactive owner authentication, activates the Organization archive, enrolls that Desktop, asks whether to import all currently available history, and starts ongoing archive sync. After activation, another Organization member sees **Contribute this computer** instead; that flow creates only the User and Collector-specific enrollment and history-import choice. Activation and enrollment remain distinct server records even when the owner's flow creates both.

Pause is a full local-work pause: no watcher processing, transcript parsing, git fallback reads, or uploads. Quit cancels loops and exits the app, but does not disable autostart. Disconnect stops work, revokes the Collector Credential, removes Stronghold secrets and unlock material, and leaves non-secret SQLite state unless the user explicitly deletes local data.

Disconnect, Delete Local Data, and Reset App are separate controls. Disconnect revokes the credential and removes secrets while keeping non-secret SQLite state by default. Delete Local Data removes SQLite state, logs, and caches and is only available while disconnected or after stopping sync. Reset App is the explicit combined destructive path that disconnects, revokes, and deletes local data.

Trace Flow Desktop runs one sync job at a time. History import pauses watcher dispatch, runs the scoped import, then resumes watching.

The app is quiet by default. Desktop notifications are reserved for action-required failures such as expired auth, sustained inaccessible Source paths, Conversation Archive capacity or spool exhaustion for an enrolled Collector, repeated sync failure, or update-required states.

Source settings are cursor-scoped. Disabling a Source stops watching and syncing it but keeps its local cursor/cache. Re-enabling the same Source path resumes from the existing cursor. Changing a Source path creates a new local cursor namespace for that path and follows the normal incremental/default import rules; it does not reuse the old path's cursor. If a path change broadens scan scope, the settings UI asks for confirmation before applying it.

## Local State And Secrets

Trace Flow Desktop uses local SQLite, managed through Tauri's SQL plugin with SQLite support, for non-secret durable Collector state: sync cursors, processed file metadata, Source settings, path/worktree-to-remote cache, machine id, parser-version observations, last sync timestamps, and job/status metadata.

SQLite is not a durable upload queue for parsed facts. If fact upload fails, the Collector re-reads from Source files later; server-side stable IDs and Tinybird dedupe are authoritative.

Conversation Archive enrollment adds a fixed 2 GB encrypted Archive Spool for Archive JSONL only. The Collector removes spooled records only after durable Archive API acknowledgement; network or archive-cap failures stay pending, and a full spool stops new archive collection loudly without blocking parsed analytics or evicting pending records. The ordinary SQLite cursor database remains unencrypted because it still contains only non-secret resumable metadata. Archive Spool encryption uses locally generated secret material protected by the OS credential store and is separate from the cursor database.

When the Organization reaches its Archive Storage Budget, archive status is blocked and spooled records remain pending until capacity returns. The Collector never treats `storage_cap_exceeded` as archive success, drops pending records, or evicts the oldest conversations automatically.

When Pro entitlement ends, the Collector stops new archive scans and keeps pending encrypted spool data during the 90-day frozen grace. Restoring Pro resumes upload. After Archive API reports terminal grace expiry, the Collector revokes local enrollment state and purges the spool.

Desktop connect mints a hidden Collector Credential scoped to the selected Organization, current User, stable Collector identity, local machine identity, and Collector ingest capabilities. Trace Flow Desktop stores that secret with Tauri Stronghold. Stronghold is unlocked with locally generated secret material protected by the OS credential store/keychain where available, not a hardcoded vault password and not the user's Trace Flow account password. If unlock fails, the user reconnects and gets a replacement Collector Credential.

Collector Credentials are not user-facing API Keys. They are managed by a separate desktop credential control plane, accepted only by Collector ingest routes, and hidden from the normal API Keys page, API-key filters, cost alerts, MCP `list_api_keys`, and Tinybird API-key JWT scopes. The product may expose a separate Connected Desktops/security surface for the current user and org admins, showing device label, platform, last seen, status, and a revoke action, but it never shows the secret and never treats the credential as a reusable API key. The corresponding server record carries Organization, User, Collector, machine, capabilities, revocation state, and internal audit metadata. Reconnect, rotation, revocation, admin revocation, or Stronghold recovery can replace or revoke the secret without changing Agent Session identity or dedupe behavior.

Trace Flow Desktop supports one active Organization in v1. Switching Organizations requires disconnect/reconnect and mints a new Collector Credential.

## Privacy And Redaction

The Collector redacts early while preserving operational context. Facts keep structured fields for tool names, command families, command program/subcommand, status, exit code, duration, model/token fields, repo-relative paths, target paths, and redacted error detail. Full prompt/response transcript text leaves the machine only through an explicitly enrolled Pro Conversation Archive.

Tool Event facts are structured first, excerpt second. `command_excerpt` is capped at 1 KB, `error_excerpt` at 4 KB, and total excerpt text per Tool Event at 5 KB. Excerpts are redacted supporting detail, not aggregation keys. If redaction detects likely sensitive content but cannot confidently sanitize a field, the Collector drops the field and records redaction metadata instead of uploading it.

Local logs and diagnostics exports are safe to share by default. They exclude raw transcripts, raw command/output blobs, secrets, dropped redaction content, command/error excerpts, and absolute paths unless an explicit local-path option is chosen.

The default diagnostics export includes app version, OS/arch, sync status, recent error classes, Source detection summary, processed file/event counts, last sync timestamps, redaction counters, and configuration toggles.

Archive Export is a separate owner-only operation with the opposite purpose from diagnostics export: it reconstructs the lossless Archive JSONL and Archive Session Manifests into a chosen local directory. Starting or resuming an export requires interactive owner sign-in and a short-lived, single-export Archive Export Grant; the long-lived Collector Credential remains upload-only. The export downloads in bounded chunks, verifies checksums, records local progress, and resumes after interruption without creating a monolithic browser download or a second server-side archive object.

Desktop reports its current archive spool bytes, last archive acknowledgement, and archive error state through the normal authenticated status heartbeat. `/app/agents` displays the latest observation with its timestamp rather than presenting stale local state as live. Desktop remains the control surface; the Web card is the persistent server-side status surface.

File facts store repo-relative paths only. Files outside the primary Repo are dropped or represented by a coarse category such as `outside_repo`, never by an absolute local path.

## Source, Git, And Pull Request Evidence

The Collector is transcript-led, not repo-monitoring-led. It watches Source transcript stores and reads git state only on demand when transcripts lack enough repository evidence. Source discovery comes from local Source transcript stores. Allowed git enrichment includes repo root, normalized remote, branch, HEAD, and a durable path/worktree-to-remote cache. Branch and HEAD are optional hints, not identity.

Repo identity for worktrees resolves from the observed worktree's own git metadata and normalized remote, not from the main checkout path. Absolute worktree paths are local-only state and are not uploaded.

Pull Request Attribution in v1 trusts exactly one GitHub Pull Request Link for the same Repo, such as `github.com/{owner}/{repo}/pull/{number}`. Git/GitHub command strings, branch names, and bare PR numbers may be extracted as diagnostic evidence but do not assign Pull Request Attribution. The desktop app does not run `gh`, call provider APIs, rely on local GitHub auth, or query remote PR state; richer PR metadata belongs server-side after links are ingested.

## Provider Usage

Provider usage and subscription-cost tracking (the `codexbar` idea) is a separate feature with its own ADR ([Provider Usage Tracking](./0016-provider-usage-tracking.md)). It is not part of Collector v1: it is absent from first-run setup, is not a default-on capability, and is not wired into the watcher, sync loop, SQLite state, diagnostics, or ingest. Trace Flow Desktop may host it later as an independent capability, but it observes personal provider subscription/quota state rather than agent transcripts, so it stays out of scope here.

## Release And Updates

Otto's desktop release workflow is reference material for Trace Flow's release workflow, not code to port wholesale. The Trace Flow release workflow remains manual `workflow_dispatch`, builds signed macOS arm64 (`aarch64-apple-darwin`) and Windows x64 (`x86_64-pc-windows-msvc`) artifacts, writes the Tauri updater release config, publishes GitHub Release assets, and uploads the updater manifest. Linux and macOS Intel are deferred until there is real demand.

Trace Flow Desktop versions independently from the repo root, Web app, and Worker deploy cadence. The desktop app uses its own SemVer, release tags like `traceflow-desktop-v{version}`, and the `traceflow-desktop-latest.json` updater manifest.

Updates are signed and prompted. The app may check on startup and periodically, but it does not silently install or restart. Updates install only after user confirmation and not during an active sync or history import unless the user explicitly interrupts.

Every Collector payload includes Trace Flow Desktop version and parser version. The ingest Worker enforces Convex-owned supported version ranges plus an emergency denylist, cached at the edge using the existing short-lived cache pattern. If policy refresh fails but a recent cached policy exists, the Worker uses that stale policy briefly and logs degraded. If no cached policy exists, it fails closed with retryable `policy_unavailable`; Trace Flow Desktop treats that as temporary service unavailability, does not advance cursors, retries with backoff or the next scheduled sync, and only notifies if it persists. Too-old or denied clients receive `upgrade_required` and stop syncing until updated.

## Consequences

This design favors a privacy-centric desktop product over a generic CLI-first collector. It keeps background behavior easy to reason about, avoids local GitHub/provider auth, makes data egress explicit, and gives the server control over unsafe desktop/parser versions. The trade-off is more desktop-specific product surface and release infrastructure up front, including Stronghold, SQLite migrations, signed updater workflows, and setup UX.

## Done

- Ordinary first-run setup starts only parsed fact sync and contains no raw-transcript upload choice.
- A Pro owner can complete **Enable Conversation Archive** through interactive authentication; the flow creates Archive Activation, enrolls that Desktop, asks whether to import all currently available history, and starts ongoing archive sync.
- After Archive Activation, an ordinary member can choose **Contribute this computer** for their own Desktop without receiving Organization-wide archive authority.
- Each enrolled Desktop keeps at most 2 GB in its encrypted Archive Spool, advances archive progress only after durable Archive API acknowledgement, and never evicts pending records.
- Archive network failure, capacity blocking, and spool exhaustion do not stop parsed fact sync. The Desktop shows the pending bytes and actionable reason.
- Restoring Pro during the 90-day frozen grace resumes pending uploads. Terminal grace expiry removes local enrollment state and purges the Archive Spool when the Collector reconnects.
- An owner can start or resume a lossless Archive Export only after interactive sign-in produces a short-lived, single-export Archive Export Grant. Export resumes at Archive Chunk boundaries, verifies checksums, writes to a chosen directory, and creates no server-side export object.
- Desktop reports timestamped spool bytes, last acknowledgement, and archive error state so `/app/agents` can distinguish current server state from the last Collector observation.
