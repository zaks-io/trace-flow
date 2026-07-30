# Agent Conversation Analytics

Status: accepted

Captured: 2026-05-23

Production-readiness amendment: 2026-05-28

The original implementation roadmap used a "slice B" milestone that treated Rust collector libraries
plus a dev-only E2E harness as enough to prove value before a user-facing collector existed. That is
not a production acceptance bar. Agent Conversation Analytics is production-ready only when a normal
Trace Flow user can authenticate a collector, sync local transcripts through the Cloudflare
ingest/queue/consumer path, and read the result in `/app/agents` without Tinybird tokens, Wrangler,
Convex dev, local KV seeding, or ignored tests. A minimal CLI may ship before the desktop app to prove
the production ingestion path. Trace Flow Desktop remains the intended long-term product surface.

Trace Flow becomes the analytics system of record for local AI-agent activity (Claude Code, Codex, Cursor), alongside proxied LLM Requests. A local Collector parses transcripts into typed facts and syncs them to a Collector Credential-authenticated ingest Worker. The Worker rate-limits, assembles canonical IDs, and enqueues. A stateless consumer prices the facts server-side and writes them into bespoke Tinybird datasources that mirror the `llm_request_facts` pattern without reusing API-key identity. Otto is the proof of concept this is extracted from: Trace Flow vendors and refactors Otto's working parser, source discovery, remote resolution, and desktop shell, and replaces the contracts around that code (wire format, local pricing, app/state model, IDs). Trace Flow owns the ingest contract, the storage design, and the Trace Flow types and tests the vendored code is refactored behind, but it does not rebuild what already works.

## Context

Otto proved the data is valuable and exposed the hard parts: identity is unstable across worktrees, dedupe is easy to get wrong, raw conversation rows are expensive, and wide aggregate documents rot. Trace Flow already has the architecture this needs: edge ingestion, a durable queue, Tinybird with rebuildable read aggregates, retention-aware reads, and a working server-side pricing chain.

Otto is an incomplete prototype, but a lot of it works and is worth extracting rather than rebuilding. Its parser, source discovery, and git/sync layers encode hard-won transcript knowledge; they are vendored into Trace Flow and refactored, not rewritten. What changes is the contracts around that code: Otto prices locally, its Cursor support targets the legacy `~/.cursor/projects` JSONL layout (not the current `state.vscdb` store), it folds nothing at the tool-pair level, and it has no Capability Snapshot contract. Trace Flow keeps the working parsing and discovery code, refactors it behind Trace Flow-owned types, tests, privacy boundaries, and IDs, and adds the Worker ingest path, Tinybird tables, and replay behavior Otto lacks. The research note's open questions (Codex-first vs Claude-first, weak Codex repo attribution, a bespoke `session_fingerprint` hash) are dissolved by the decisions below, not by the prototype.

### Local survey

| Store                    | Shape                         |         Size / count | Notes                                                                                                                               |
| ------------------------ | ----------------------------- | -------------------: | ----------------------------------------------------------------------------------------------------------------------------------- |
| `~/.claude/projects`     | JSONL conversations           |  6,680 files, 1.8 GB | Rich model/token/cache/tool data; many worktree variants.                                                                           |
| `~/.codex/sessions`      | JSONL sessions                |     98 files, 139 MB | Rich tool execution, exit codes, command families, base instructions, dynamic tool metadata.                                        |
| Cursor `state.vscdb`     | SQLite KV (`cursorDiskKV`)    | 3.5 GB globalStorage | The real Cursor store. `composerData:` sessions carry model, `bubbleId:` messages carry token counts. Read-only, GLOB prefix scans. |
| `~/.cursor/projects`     | JSONL conversations + caches  |              ~174 MB | Legacy layout the Otto prototype parses; UUID session id in path. Superseded by `state.vscdb`.                                      |
| `~/.cursor/acp-sessions` | Agent Client Protocol + cache |   ~893 MB, 117k dirs | Un-schema'd protobuf blob stores, only 38 of 118k dirs populated (`t3code_desktop` origin). Not the target.                         |

Those totals are mostly raw conversation text. (The `~/.cursor` directory is ~37 GB on disk, but ~35 GB of that is git worktrees, actual checkouts, not transcripts; the two `~/.cursor` rows are the legacy conversation corpus, while `state.vscdb` is the current store and lives separately under `~/Library/Application Support/Cursor/`.) The Collector always ships parsed facts. Only an explicitly enrolled Pro Conversation Archive also ships losslessly compressed Archive JSONL, a fraction of the on-disk size at roughly 10x compression, with the fact rows smaller still. All sources reduce to similar fact-row volumes for storage sizing, but not to similar economic value: Claude and Codex populate full token, model, and cache columns, while Cursor (via `state.vscdb`, not the `projects`/`acp-sessions` stores) contributes session-grain model and sparse message-grain token counts with cache coverage marked missing (see Data quality verification).

### Corpus measurement

One heavy user (135-day span, 2026-01-08 to 2026-05-23): 427,759 messages (~3,170/day), 166,868 tool uses (~1,240/day), roughly 4,400 combined fact rows/day. At about 150 bytes/row:

- Base fact tables at 1-year TTL: ~240 MB/user. 1,000 such users: ~240 GB, about $14/month at the $0.058/GB-month storage overage rate.
- Hourly/daily rollups at 1-year TTL: ~28 MB/user. 1,000 users: ~28 GB, about $1.65/month.

Storage is not the cost driver on Tinybird (vCPU-hours are), so keeping the facts a full year is cheap (~$14/month at 1,000 heavy users). Derived facts do not carry full prompt/response transcript text, but they may carry bounded redacted operational excerpts as described below. Lossless Raw Transcripts exist only in an explicitly enrolled Pro Conversation Archive with its own 100 GB cap and Paid Archive Retention. Correctness comes from append-clean base facts first: the Collector keeps local fact checksums, the ingest path has a Durable Object ledger, and materialized rollups are derived serving tables that must be rebuildable from clean facts.

## Scope (v1)

A vertical slice that proves ingestion, dedupe, pricing, rollup, and the three launch queries end to end, for all three sources from day one. No source fork. `source` is a dimension column, not a branch in the pipeline.

Day-one breadth means source-tagged activity, not uniform economics. Verified against the live corpus (Data quality verification): Claude and Codex carry full tokens, model, and cache detail, while Cursor carries partial economics from its `state.vscdb` store — session-grain model and sparse message-grain token counts, no cache breakdown. So the full cost, token, and cache product is Claude plus Codex; Cursor `agent_message_facts` rows carry a normalized model and, where the bubble `tokenCount` is populated with nonzero values, tokens. Missing Cursor token/cache components are stored as zero-valued numeric columns plus explicit coverage fields (`token_coverage`, `cache_coverage`), not nullable metric columns; `cost_usd` is null when usage or pricing is unavailable. The architecture stays unforked; the asymmetry is in the data each source exposes, not in the pipeline.

## Decisions

### Collector (Trace Flow implementation, Otto-informed)

The Collector is built by vendoring Otto's working code and refactoring it behind the decisions in this ADR. Otto's parser, source discovery, and git-remote resolution are extracted into Trace Flow and reused; what Trace Flow does not inherit is Otto's wire contract, storage schema, local-pricing behavior, app state, and backend assumptions. The vendored parsing and discovery code is refactored to land behind Trace Flow-owned types, tests, redaction rules, and ingest compatibility policy rather than rebuilt from scratch. See [Otto Extraction Reference](./0017-otto-extraction-reference.md) for the Otto files and modules to consult during implementation.

Trace Flow uses the same useful binary split that Otto explored without copying its directory split or state model: the Collector has two first-class binaries over shared core packages, but Trace Flow Desktop is the v1 product surface. The desktop app is the default user experience and owns connect, continuous watching, autostart, pause/resume, status, and background sync. A user should be able to install it, log in quickly, and let it run without thinking about the CLI. The desktop embeds the shared sync libraries directly rather than shelling out to the CLI, so normal background behavior is not coupled to subprocess management, stdout parsing, or CLI exit semantics. Shared Rust crates live under `packages/` alongside the rest of the monorepo packages, with thin apps under `apps/`. See [Trace Flow Desktop Collector](./0015-trace-flow-desktop-collector.md) for the desktop product, local state, privacy, release, and update decisions.

The repo layout follows the existing Turborepo shape. Trace Flow Desktop lives at `apps/desktop` with package name `@trace-flow/desktop` and Tauri product name `Trace Flow Desktop`. If the CLI is scaffolded in v1, it lives at `apps/cli` and builds the `trace-flow` binary. Shared Rust packages live under `packages/` with Collector-oriented names such as `collector-sync`, `collector-parser`, `collector-api-client`, `collector-common`, and `collector-contracts`.

The CLI binary is `trace-flow`, matching the repo and package spelling, but it is not the primary v1 interface and does not drive the desktop experience. It can be built as a thin, flat command surface over the same packages for future headless, diagnostic, CI, or agent-friendly workflows, but v1 does not spend product effort on CLI installation, desktop integration, or a polished command taxonomy. The CLI must not accept credentials as command-line arguments because argv leaks through shell history, process listings, logs, and agent transcripts. A future proxy-oriented CLI may keep the existing `TRACE_FLOW_API_KEY` environment convention, but a future headless Collector path must use a Collector Credential through the shared credential store or another deliberately designed non-argv credential flow.

Desktop connect mints a hidden Collector Credential scoped to the selected Organization, current User, stable Collector identity, local machine identity, and Collector ingest capabilities. Trace Flow Desktop stores that secret with Tauri Stronghold, not SQLite or plain config, and uses it only for Collector ingest. Stronghold is unlocked with locally generated secret material protected by the OS credential store/keychain where available, not a hardcoded vault password and not the user's Trace Flow account password. If Stronghold unlock fails, the app requires reconnect/login and mints a replacement Collector Credential rather than exposing or recovering the old secret. The ingest Worker authenticates Collector Credentials through a separate control-plane record and Cloudflare KV namespace from user-facing API Keys. Browser/session tokens are not sent to the ingest Worker as the long-lived desktop credential.

Collector Credentials are not user-facing API Keys. They do not appear on the API Keys page, API-key filters, cost alerts, MCP `list_api_keys`, or Tinybird `api_keys` JWT fixed parameters. They cannot call the Proxy or authorize LLM Request reads. The product may expose a separate Connected Desktops/security surface for the current user and org admins, showing device label, platform, last seen, status, and a revoke action, but it never shows the secret and never treats the credential as a reusable API key. Revoking, rotating, or replacing a Collector Credential changes authentication and internal server audit metadata only; it must not change Agent Session identity, Repo identity, or dedupe keys. This gives a lost-laptop/offboarding path without polluting the user-facing API-key model.

Disconnect revokes and stops. When the user signs out or disconnects Trace Flow Desktop, the app stops watcher and sync loops; revokes the Collector Credential server-side; removes the Stronghold secret and local unlock material; and returns to a disconnected state. Non-secret SQLite state is kept by default to avoid unnecessary rescans on reconnect, but a separate explicit "Delete local data" control can remove local Collector state.

Trace Flow Desktop supports one active Organization in v1. Connect chooses one Organization, and all Agent Session facts upload there. Switching Organizations requires disconnect/reconnect and mints a new Collector Credential. Local SQLite state records the active Organization and must not silently reuse sync cursors across Organizations. Simultaneous multi-org sync is deferred.

Disconnect, Delete Local Data, and Reset App are separate controls. Disconnect revokes the credential and removes secrets while keeping non-secret SQLite state by default. Delete Local Data removes SQLite state, logs, and caches and is only available while disconnected or after stopping sync. Reset App is the explicit combined destructive path that disconnects, revokes, and deletes local data.

Trace Flow Desktop is a menu-bar/tray app with a small settings window. The menu owns fast operational controls: connection and sync status, last sync, Source counts, pause/resume, run sync/backfill, recent errors, open logs, and quit. The settings window owns interactive and consent-heavy flows: connect/login, Conversation Archive activation and Collector Enrollment, Source enable/disable, custom Source paths when defaults are wrong, autostart, Archive Export, and opening the Web dashboard. This keeps routine control lightweight while avoiding menu-only UX for privacy and authentication choices.

The tray menu shows compact operational status for detected enabled Sources only. Disabled, missing, or custom-path Source configuration lives in settings. This keeps the tray as a status/control surface rather than a full configuration inventory.

Trace Flow Desktop detects transcript Sources from the local Source transcript stores and shows detected Claude, Codex, and Cursor Sources before sync starts; detected Sources are enabled by default but can be turned off before the user clicks "Start syncing." Source discovery reads only the local transcript stores and does not depend on any external CLI.

Default Source paths are platform-specific because v1 ships macOS arm64 and Windows x64. On macOS, defaults are `~/.claude/projects`, `~/.codex/sessions`, and `~/Library/Application Support/Cursor/User/{globalStorage,workspaceStorage}` for Cursor `state.vscdb` files. On Windows, defaults are `%USERPROFILE%\.claude\projects`, `%USERPROFILE%\.codex\sessions`, and `%APPDATA%\Cursor\User\{globalStorage,workspaceStorage}` for Cursor `state.vscdb` files. Linux defaults are deferred with Linux packaging. Users can add custom Source paths when defaults are wrong. Absolute Source paths stay local-only; uploaded facts use Source IDs, repo-relative paths, redacted paths, or hashes.

Source settings are cursor-scoped. Disabling a Source stops watching and syncing it but keeps its local cursor/cache. Re-enabling the same Source path resumes from the existing cursor. Changing a Source path creates a new local cursor namespace for that path and follows the normal incremental/default import rules; it does not reuse the old path's cursor. If a path change broadens scan scope, the settings UI asks for confirmation before applying it.

Provider usage and subscription-cost tracking (the `codexbar` idea) are a separate feature with their own ADR ([Provider Usage Tracking](./0016-provider-usage-tracking.md)). They are out of scope here, are not wired into Collector ingest, queue, storage, or first-run setup, and are not a v1 dependency. The desktop app may host that feature later, but it observes personal provider subscription/quota state rather than agent conversations, so it does not belong in this pipeline.

First-run setup configures parsed fact sync only. Conversation Archive is a separate explicit Pro action in Settings, not a raw-upload toggle embedded in ordinary analytics setup. Its setup copy distinguishes parsed facts from lossless Raw Transcripts and explains Organization ownership, per-Collector enrollment, encryption, Paid Archive Retention, export, and deletion.

Login alone does not start syncing. First-run setup shows detected Sources, then starts parsed fact sync only after an explicit "Start syncing" action. After that action, Trace Flow Desktop runs the initial incremental sync and begins watching. This keeps install-and-forget behavior after setup while making the first data egress boundary visible to users who do not yet understand what the app will do.

Autostart is part of first-run setup. "Start Trace Flow Desktop when you log in" is visible and enabled by default before the user clicks "Start syncing"; the user can turn it off there or later in settings. Default-on matches the background utility model, while setup visibility makes the OS login behavior explicit.

First-run fact sync is incremental by default, not an automatic historical backfill. Trace Flow Desktop should not silently process a large historical corpus just because it was installed. Importing older facts is a separate explicit action with three v1 presets: 7 days, 30 days, or 1 year. There is no all-history fact import in v1. The one-year preset matches the fact retention horizon; importing older facts would be wasteful and surprising.

For the first incremental scan, Trace Flow Desktop records `collector_started_at` when the user clicks "Start syncing" and includes transcript files modified within the preceding 24 hours. That active-session grace window catches conversations already in progress when the app is installed without turning first run into a historical import. Older files require the explicit history import path.

Collector Enrollment has a separate all-currently-available-history choice because Conversation Archive is not bounded by the one-year fact horizon. That archive import preserves every Source record still present locally, while parsed fact ingestion continues to discard rows outside its one-year retention window.

Trace Flow Desktop runs one sync job at a time. A scoped history import pauses watcher dispatch, runs the backfill, then resumes watching. The status model stays simple and user-visible (`Watching`, `Syncing`, `Importing history`, `Paused`, `Error`) rather than allowing concurrent watch and backfill jobs with ambiguous progress and cancellation behavior.

Pause is a full local-work pause, not upload-only. While paused, Trace Flow Desktop does not process watcher batches, parse transcripts, read git fallback state, or upload. In-flight work may finish or cancel cleanly, but no new local scanning or network sync begins until the user resumes. This matches Pause as a privacy and control affordance rather than a background queue mode.

Quit and Pause are distinct controls. Quit cancels watcher and sync loops and exits Trace Flow Desktop; it does not disable autostart, so the app starts again on next login if autostart remains enabled. Pause keeps the app running but stops local Collector work until resumed. Menu labels should make that distinction clear, for example `Pause Sync`, `Resume Sync`, and `Quit Trace Flow Desktop`.

Trace Flow Desktop uses a local SQLite database for durable Collector state, managed through Tauri's SQL plugin with the SQLite feature. The database stores sync cursors, processed file metadata, Source enablement and paths, path/worktree-to-remote cache entries, machine id, parser-version observations, last successful sync timestamps, and job/status metadata. The database lives under the Trace Flow Desktop app config/data location, not an Otto path. Local state is an optimization and UX aid; server-side stable IDs and Tinybird dedupe remain authoritative, so losing or rebuilding the SQLite state may cause reprocessing but must not create lasting duplicate facts.

SQLite is not a durable upload queue for parsed analytics facts. If fact upload fails, the Collector leaves or rewinds cursors so it can re-read from Source files later; server dedupe absorbs repeats.

Conversation Archive enrollment is the deliberate exception. Each enrolled Collector writes newly observed Archive JSONL into a fixed 2 GB encrypted Archive Spool and removes it only after Archive API acknowledges both durable record storage and the corresponding Archive Session Manifest. Network and archive-capacity failures remain visibly pending rather than advancing archive progress. Reaching 2 GB fails loudly and stops new archive collection without blocking parsed analytics or evicting pending records. Disconnect asks whether to finish uploading or discard pending archive records. This extra local sensitive state is justified by explicit enrollment and by the fact that a Source may compact or delete records before a later retry.

The ordinary Collector SQLite state remains unencrypted because it stores only non-secret resumable metadata. Archive Spool payloads are encrypted separately with locally generated secret material protected by the OS credential store; they are not readable through the normal cursor database.

SQLite may store absolute local paths for local-only cursor/cache lookup because those paths already exist on the user's disk and are useful for reliable watching and debugging. Absolute paths are not uploaded. Logs, support exports, and server facts use repo-relative, redacted, hashed, or coarse path forms unless a local settings screen is showing the user their own configured paths.

Trace Flow Desktop includes a sanitized diagnostics export in v1. The default export includes app version, OS/arch, sync status, recent error classes, Source detection summary, processed file/event counts, last sync timestamps, redaction counters, and configuration toggles. It excludes raw transcripts, command/error excerpts, secrets, and absolute local paths by default. If an "include local paths" option exists, it must be explicit.

Trace Flow Desktop is quiet by default. The menu and settings/log views show recent errors and degraded status, but the app only sends desktop notifications for action-required failures: disconnected or expired auth that stops sync, archive capacity or Archive Spool exhaustion for an enrolled Collector, a Source path inaccessible for a sustained period, or repeated sync failure after retries. Transient parse errors, individual failed files, retryable rate limits, and temporary server errors stay in status/log surfaces. Notifications should open the relevant settings or error view.

Otto is a reference point, not a state lineage. Trace Flow Desktop gets a new Tauri identifier, app data directory, config path, keychain/credential service name, autostart entry, log directory, machine id, release channel, and updater URL. It does not automatically import Otto config, API keys, last-sync state, path caches, local databases, or any other Otto-branded state. If migration is ever useful, it must be an explicit command, not first-launch behavior.

The Collector is transcript-led, not repo-monitoring-led. It watches Source transcript stores and parses Agent Sessions; it only reads git state on demand when the transcript lacks enough repository evidence. That fallback is scoped to attribution fields such as normalized remote, git root, branch/head when available, and the durable path-to-remote cache. It does not scan every checkout for arbitrary git changes or act as a general repository monitor.

Collector CI and release are v1 scope, not deferred cleanup. The user-facing desktop product is Trace Flow Desktop; Collector remains the architecture term for the local parsing and sync component. PR CI verifies the Rust workspace and Tauri desktop crate with normal checks, while Otto's desktop release workflow is reference material for Trace Flow's production packaging path. The release workflow remains a manual `workflow_dispatch` pipeline that builds signed macOS arm64 (`aarch64-apple-darwin`) and Windows x64 (`x86_64-pc-windows-msvc`) desktop artifacts, writes the Tauri updater release config, publishes GitHub Release assets, and uploads the updater manifest. Required signing and updater secrets are configured in GitHub rather than stripping the release path down to unsigned builds. External release assets carry the Trace Flow Desktop brand (`traceflow-desktop-latest.json`, platform artifact names such as `traceflow-desktop-macos-arm64` and `traceflow-desktop-windows-x64`) so updater URLs, support docs, and downloaded files are unambiguous; generic names are acceptable only for internal workflow labels. Linux and macOS Intel are deferred until there is real demand; building unused platforms adds CI and signing cost without improving v1.

Trace Flow Desktop uses signed prompted updates. The app may check the updater manifest on startup and periodically, but it shows an update badge/prompt instead of silently installing and restarting. Updates are installed only when the user chooses, and not in the middle of an active sync or history import; the app waits until idle or asks the user to confirm interruption. Stronger behavior for critical security updates is deferred.

Trace Flow Desktop versions independently from the repo root, Web app, and Worker deploy cadence. The desktop app uses its own SemVer (starting at `0.1.0` unless changed during implementation), release tags like `traceflow-desktop-v{version}`, and the `traceflow-desktop-latest.json` updater manifest. This keeps desktop updater compatibility and signing cadence separate from Cloudflare/Web releases.

The Otto survey creates explicit Trace Flow implementation obligations:

1. Strip local pricing, and normalize token accounting per source. Otto's parser computes `cost_usd` from a price map; Trace Flow prices server-side (Cost and pricing), so the Collector ships tokens and model only. Per-source token shapes differ and must be reduced to per-message tokens before upload, because both raw stores overcount under naive summation (Data quality verification): Claude repeats one `message.usage` across several JSONL records sharing a `message.id` (collapse to one; summing the repeats inflated sampled sessions 2x to 15x), and Codex `token_count` events carry a running cumulative `total_token_usage` alongside a per-turn `last_token_usage` (sum the `last_token_usage` deltas or take the final cumulative; summing `total_token_usage` overcounted a 671-event session ~331x). Server-side `message_pk` dedupe is the backstop for the Claude case, but the Codex cumulative trap has no surrogate-key backstop and must be handled in the parser.
2. Sync to the Collector ingest Worker with Trace Flow Collector Credential auth, Worker-side compatibility policy, org rate limits, queue buffering, and the opt-in raw-transcript upload.
3. Assemble canonical IDs in the ingest Worker, not the Collector (Tenancy and identity); parser-local IDs that mix in redacted text or line position are not dedupe keys.
4. Target Cursor's `state.vscdb`, not the JSONL or protobuf stores. Otto parses the legacy `~/.cursor/projects` JSONL; the current store is `state.vscdb`, a VS Code-style SQLite key-value DB (table `cursorDiskKV`) under Cursor's `User/globalStorage` plus per-workspace `workspaceStorage/<hash>/state.vscdb`. Sessions are `composerData:<composerId>` rows; messages are `bubbleId:<composerId>:<bubbleId>` rows, with the composerId in the key giving the session join and model lookup. Verified 2026-05-25: composers carry `modelConfig.modelName` on ~99% (3,396 of 3,417) but as Cursor-specific labels (reasoning suffixes like `gpt-5.2-xhigh` / `claude-4.5-opus-high-thinking`, proprietary `composer-1`/`composer-2-fast`, and `default`) that need a normalization/alias layer and are partly unpriceable; bubbles carry `tokenCount.{inputTokens,outputTokens}` present-but-zero on 99% and nonzero on only 1,085 of 123,790 (0.9%, summing 93.3M input + 5.2M output), with no cache breakdown and no per-bubble model. So Cursor yields session-grain model plus sparse token economics, not Claude/Codex-grade detail. The denser `agentKv:` blobs (209,618 rows) are the likely home of fuller per-request usage and remain an unparsed implementation investigation. The Collector never writes to Cursor's live DB: it creates a read-only consistent snapshot with the SQLite backup API when possible, or by copying the `state.vscdb` / `state.vscdb-wal` / `state.vscdb-shm` trio when Cursor is closed or copy-safe, then opens only the snapshot as immutable. If snapshot creation fails or appears inconsistent, it backs off and reports Source degraded instead of touching the live DB. Prefix scans use `GLOB`, never `LIKE` — SQLite `LIKE` is case-insensitive by default, which disables the `key` index and forces a full multi-GB scan. Mature OSS extractors target exactly this store (cursor-view, cursor-history, cursor-chat-export). The `acp-sessions` protobuf store (un-schema'd, content-addressed, only 38 of ~118k dirs populated, `t3code_desktop` origin) is not the primary target; guard any blob parsing with per-source canary fixtures and `parser_version` flags.
5. Add first-class Capability Snapshots. Otto has useful Codex hints (`base_instructions`, `dynamic_tools`) but no normalized upload contract, no Tinybird table, and no coverage semantics. Trace Flow defines that contract for the opportunistic capability capture described under Data model; the Context Bloat analysis built on top of it is deferred.
6. Redact early while preserving operational context. The Collector redacts known API tokens, cookies, secret-looking strings, absolute home paths, and other obvious sensitive values from Agent Session facts before upload; the ingest Worker re-redacts defensively. Facts should carry analytics fields, command families, tool names, what commands/tools ran, relevant arguments or targets, status, exit codes, durations, token counts, model names, repo-relative paths, and redacted error detail. This operational context is necessary for tool/failure analytics, but it is bounded and best-effort redacted before leaving the machine. Full prompt/response transcript text leaves the machine only through an explicitly enrolled Pro Conversation Archive.

The trade-off: refactoring the vendored Otto code behind Trace Flow-owned contracts costs more upfront than using it wholesale unchanged, but it keeps the product boundary clean: server-side pricing, Worker-owned identity, Tinybird-native tables, conversation-only capability extraction, and source-specific coverage are not retrofits. Otto's gaps (unparsed Cursor `state.vscdb`, no tool-pair folding, synthetic Codex message IDs, no Capability Snapshot contract) are treated as requirements to close, not inherited behavior.

### Tenancy and identity

Agent facts are org-scoped, not API-key-scoped. The Collector Credential authenticates upload, but fact rows carry durable identity columns: `OrgId`, `UserId`, `CollectorId`, and `CollectorCredentialId` for internal audit. `OrgId`, `UserId`, and `CollectorId` come from the credential record; `CollectorCredentialId` is not a dedupe key and may change on reconnect, rotation, or Stronghold recovery. Project is a read-time grouping that spans agent and LLM data; it is not stamped onto facts and its Convex entity is deferred.

This diverges from the proxied LLM Request path on purpose. User-facing API Keys remain the row-security and dashboard filter for `llm_request_facts`; hidden Collector Credentials are short-lived/replaceable desktop credentials and should not pollute a user's API key inventory or fragment Agent Sessions. Agent Tinybird pipes use Convex-generated fixed params such as `org_id`, not the existing `api_keys` parameter.

Within an Organization, the first accepted upload of an Agent Session claims that `session_pk` for the uploading `UserId`. A later upload of the same Source transcript under a different `UserId` is a permanent ownership conflict, not an overwrite. The ingest Worker checks a narrow server-side session ownership claim keyed by `OrgId + session_pk` before enqueueing facts; if the claim exists for another user, it returns a structured `session_owner_conflict` result for that Agent Session and does not enqueue or store raw for it. Mixed sync batches skip only the conflicting Agent Sessions and continue with unrelated sessions, so one historical ownership conflict does not block current work. This prevents a logout/login on the same machine from reassigning historical conversations while keeping `UserId` out of Tinybird row identity. The claim exists only to protect ingestion ownership and dedupe semantics; it is not a user-facing conversation-sharing or reassignment model. If ownership ever needs to move, it should be an explicit admin/support repair path, not an automatic Collector behavior.

Identity is vendor-ID-first, assembled at the ingest Worker:

- `session_pk` = hash(`source`, vendor session ID), a stable UUID for Claude, Codex, and Cursor.
- `message_pk` adds the vendor message ID. Claude and Cursor carry one; Codex does not, so for Codex it falls back to (vendor session ID, positional turn index). That positional surrogate is the only identity component derived from parse position rather than vendor bytes, so a re-parse that renumbers Codex turns can move it; it is the weakest dedupe key and is flagged as provisional (Trust boundary).
- `tool_use_pk` adds the tool-use block's `tool_use_id`; when that is absent, substitute (vendor message ID, block index).
- `repo_fingerprint` = hash(normalized git remote); the Collector resolves the remote string and the ingest Worker hashes it, keeping hashing in one place. Codex carries the remote in-band (`session_meta.payload.git.repository_url`); Claude and Cursor do not, so the Collector resolves it from the session's `cwd` the moment it first observes the session — while that worktree is still live — and freezes it, keeping a durable `cwd → remote` cache so a worktree deleted before sync stays resolvable. SSH and HTTPS remote forms normalize to one fingerprint. When no remote resolves (pre-install history, an already-deleted uncached worktree, a local-only repo), the fact falls back to a normalized path hash stamped `repo_source = path`; since `repo_fingerprint` is a regular column, a later remote-bearing re-sync heals the rows upward. Path/`cwd` is never the trusted identity. v1 assigns one primary Repo per Agent Session, chosen from the Source's session metadata or observed `cwd`; other repos mentioned or touched during the session are a known limitation rather than split-cost inputs.
- Content-hash is a last-resort session identity for any source where no vendor UUID is recoverable, not a Cursor default. Cursor exposes a UUID (the `composerData:<composerId>` id in `state.vscdb`, and also the `acp-sessions` directory name and the `projects/.../agent-transcripts/<uuid>/` path), so it normally takes `session_pk` like the others. Where the fallback is unavoidable, the hash must be over stable vendor bytes (never parser output) and byte-stable across versions, the same determinism `StartedAt` requires, or a re-sync mints a new identity and inflates counts.
- Claude and Cursor can store subagent transcripts as separate files (`.../<session>/subagents/<agent>.jsonl`, or Cursor's `agent-transcripts/<parent>/subagents/<uuid>.jsonl`). The Collector links them to the parent `session_pk` from the path/session id and emits their facts under it with `agent_depth` > 0, never as standalone Agent Sessions. Claude also marks those rows with `isSidechain` and an `agentId`, which can be joined back to the parent tool result. Codex subagents run in the same transcript.

This replaces the research note's compound `session_fingerprint` algorithm. Hashing and ID assembly live in one place (the ingest Worker), not in the Collector or scattered across the consumer.

### Repo and review-unit attribution

Repo is a first-class Trace Flow concept, not just an agent fact dimension. Agent facts still carry `repo_fingerprint`, but the read side normalizes repositories around the same remote identity so Agent Sessions, Review Units, and future code-aware views share one code anchor. Fact rows keep the fingerprint as the stable join key; the Repo record carries normalized display metadata such as host, owner, and repository name. Local-only repositories without a remote still create Provisional Repos from the path fallback, so pre-push work is captured and groupable; when a later observation resolves a remote from the same observed local path/worktree history, that Provisional Repo heals into the remote-backed Repo. Name similarity alone is not merge evidence. v1 assigns one primary Repo per Agent Session; multi-repo work is a known limitation documented under Trust boundary.

Review Unit authoring cost is session-based and uses the canonical Agent Session Authoring Cost, not an ad hoc sum over one fact table. A Review Unit is the provider-neutral reporting unit for reviewable branch work: GitHub Pull Requests, GitLab/Gitea Merge Requests, Bitbucket Pull Requests, and later branch-only review units when no hosted review link is observed. The UI may label a known host's unit as "PR" or "MR", but the model must not require GitHub or any other provider.

Review-unit attribution must work without GitHub, GitLab, Bitbucket, or Gitea API calls. The Collector supplies passive local evidence from transcripts and git metadata; it does not run `gh`, `glab`, provider CLIs, provider APIs, or remote PR queries for discovery. Link extraction is host-shaped internally (`host`, `owner`, `repo`, `number`, `url`) and should support canonical hosted-review URLs where their repo identity is visible in the URL, such as GitHub `/pull/123`, GitLab `/-/merge_requests/123`, Bitbucket `/pull-requests/123`, and Gitea/Forgejo-style `/pulls/123`. Provider integrations can exist later as a separate feature, but they must not be required for Review Unit cost.

Facts, cost, and attribution decisions stay separate. `agent_pull_request_facts` records observed link evidence from transcripts. `agent_session_summaries` remains the canonical session-cost aggregate. A dedicated attribution decision model records only the edge from an Agent Session to a Review Unit: `session_pk`, `review_unit_key`, `review_url`, `repo_fingerprint`, optional `git_branch`, `attribution_method`, `confidence`, `status`, `ambiguity_reason`, optional evidence fact key, `rule_version`, and `DecidedAt`. It must not copy `cost_usd`, token counts, message counts, model, source, or other usage aggregates; Review Unit cost is always computed by joining attribution edges to `agent_session_summaries`.

`review_unit_key` is deterministic and provider-neutral. Hosted links use the normalized repo identity plus normalized review locator (`host`, owner/repo path, review kind, number), never display text or the surrounding transcript excerpt. Branch-only keys use a distinct branch prefix plus `repo_fingerprint + git_branch` and are reported as Branch Cost until a hosted-review link promotes them to a Review Unit. `attribution_method` is `direct_link`, `branch_retro`, or `manual`; `confidence` is `high`, `medium`, or `low`; `status` is `attributed`, `ambiguous`, or `rejected`. Any behavior change to attribution logic bumps `rule_version`; re-running the same version may supersede that version's decision for the session, while older decisions and rule versions remain available for audit and comparison.

Direct link attribution is the first shipped rule. An Agent Session is assigned to at most one Review Unit in the same Repo only when local evidence is unambiguous: exactly one distinct canonical review link matches the session's resolved repo. If there are no review links, links for multiple review units, or links that do not match the session repo, the session remains Unattributed Repo Authoring Cost. Trace Flow does not split one Agent Session across several Review Units in v1.

Branch retro-attribution is a later rule and must be visibly lower confidence than a direct link. Once a direct link establishes `repo + branch -> review_unit_key` from local evidence, earlier sessions on the same `repo_fingerprint + git_branch` may be attributed only when no competing Review Unit is known for that branch and the rule can explain its time bounds. Branch-only work without a review link is reported as Branch Cost, not Review Unit Cost. Branch names and HEAD SHAs remain hints, not identity or proof.

### Transport

Local parse, then upload facts for normal analytics. An explicitly enrolled Pro Collector additionally sends Archive JSONL through a separate durable archive-upload path; there is no ordinary raw-upload mode.

```text
Collector (desktop tray)       Agent Ingest                    Queue              Consumer
  parse transcripts      ->    auth + org rate limit    ->   durable buffer ->   price (KV)
  upload fact envelope         size cap, assemble IDs         DLQ                reconcile
  (tokens + model)             chunk to <128 KiB                                 typed datasources

Enrolled Collector             Archive API                     Agent Archive R2
  Archive Spool          ->     validate Pro + enrollment ->   encrypted chunks
  Archive JSONL                 reserve 100 GB budget           manifests
```

The Collector parses locally, ships facts, and never computes price. Only a Collector with a current Collector Enrollment may send Archive JSONL to the dedicated Archive API at `archive.trace-flow.dev`. Archive API validates the Collector Credential, Pro entitlement, and enrollment, reserves bytes against the dedicated 100 GB archive pool, encrypts accepted chunks with the Organization's Archive Encryption Key, and writes them to the isolated Agent Archive bucket, where plaintext is never persisted. Agent Ingest remains fact-only, and fact ingestion continues when archive upload is blocked. See Conversation Archive storage and replay below and [R2 Storage Caps](./0013-r2-storage-caps.md).

The ingest Worker authenticates the Collector Credential, resolves `OrgId`, `UserId`, `CollectorId`, and credential audit identity from the control plane, applies a per-org rate limit (new `AGENT_INGEST_LIMITER`, namespace `2006`, since `2005` is already `TOKEN_REFRESH_LIMITER`; mirroring `ORG_LIMITER`'s pattern) and a request-size cap, returns 202/429/413, and chunks oversized POSTs into sub-128KB queue messages.

Every Collector payload includes Trace Flow Desktop version and parser version. The ingest Worker records both and enforces supported semantic version ranges plus an emergency denylist; it does not accept old clients indefinitely. The compatibility policy is owned in Convex, not environment variables, so minimum versions and denylisted releases can change without a Worker deploy. The Worker caches the policy using the existing edge-cache pattern (short-lived module-scope L1 plus Cache API where appropriate) and falls back gracefully on cache miss. If policy refresh fails but a recent cached policy exists, the Worker uses that stale policy briefly and logs degraded; if no cached policy exists, it fails closed with a retryable `policy_unavailable` response rather than accepting unknown desktop/parser versions. Trace Flow Desktop treats `policy_unavailable` as temporary service unavailability: it does not advance cursors, retries with backoff or the next scheduled sync, and only notifies if the condition persists. The normal path is minimum supported desktop/parser versions or ranges, while the denylist blocks specific bad releases known to produce unsafe identity, schema, or redaction output. If a desktop/parser version is too old, unsafe, or denied, the Worker returns a structured `upgrade_required` error with the minimum required version and reason category. Trace Flow Desktop surfaces that as an update-required state and stops syncing until updated.

The fact upload envelope is explicit because the Collector emits several fact types but the Worker owns tenancy and final IDs:

```text
AgentIngestEnvelope
  batch: source, collector_batch_id, desktop_version, parser_version
  facts: messages[], tool_events[], file_events[], capability_snapshots[], pull_request_links[]
```

The fact envelope never carries Raw Transcripts. The Collector does not send trusted `OrgId`, `UserId`, cost, or final Tinybird primary keys. It sends source-visible vendor IDs, timestamps, parsed fields, and redaction counters. The Worker authenticates the Collector Credential, stamps tenancy/audit identity, assembles `session_pk` and row keys, chunks queue messages, and drops or rejects fields that violate the ingest contract. This keeps reconnect/credential churn out of row identity and gives parser upgrades a single compatibility boundary.

The consumer is stateless: bounded `max_concurrency`, one batched insert per invocation, with the queue's DLQ for poison messages.

### Conversation Archive storage and replay

Raw Transcripts leave the machine only through a Pro Conversation Archive after Archive Activation and per-Collector Enrollment. There is no separate 90-day raw-upload toggle or storage mode. Raw Transcripts use **Archive JSONL**, a canonical envelope format rather than a normalized conversation schema. Each versioned wrapper contains `source`, `source_session_id`, `source_record_identity`, `observed_at`, `payload_encoding`, `payload`, and `content_sha256`. `content_sha256` is computed over the exact Source-native payload bytes before wrapping. `payload_encoding` is `utf8` when the exact bytes are valid UTF-8 and `base64` otherwise, so parsing and JSON serialization never alter the payload. Source adapters may add namespaced provenance fields, but absolute local paths and unrelated store metadata are excluded. Claude and Codex records retain their original JSONL record bytes; Cursor's relevant `cursorDiskKV` keys are record identities and their values are payloads. Subagent parts linked to the parent Agent Session use the same format. The archive never includes unrelated Source store contents, whole SQLite pages, repository files, or data discovered outside the Source transcripts.

Archive API packs new Archive JSONL records from one Archive Contribution and Agent Session into immutable, losslessly compressed Archive Chunks before encrypting each chunk with the Organization's Archive Encryption Key and writing it to a dedicated Agent Archive R2 Standard bucket. The target chunk size is 16 MiB, with earlier flush at a session or sync boundary, and remains below the upload path's request and memory limits. Each Archive Session Manifest maps its ordered record identities and content hashes to chunk byte ranges. Chunks never mix sessions or contributors, and v1 performs no physical deduplication across Archive Contributions. Each Organization has an independent, versioned data-encryption key, stored only in wrapped form outside the archive bucket; this is not the shared-root derivation used for short-lived Body Objects. Every encrypted object records its key version. Rotation makes a new version active for writes immediately, re-encrypts old objects in the background, and retains an older wrapped key only until no archive object references it. Organization deletion destroys every wrapped Archive Encryption Key version before asynchronous R2 deletion so residual ciphertext is unreadable. Keys are server-managed because authorized archive reads and lossless exports require server-side decryption.

R2's provider-managed encryption is defense in depth, not a replacement for the Archive Encryption Key. Only Archive API binds the bucket and key material; Agent Ingest, Raw API, and Analyst Sandbox do not. Archive API routes each session through an Archive Session Ledger Durable Object keyed by Organization, contributor, Source, and Agent Session. The ledger serializes uploads from multiple enrolled Collectors, deduplicates stable Source record identity plus content hash, and treats changed content for the same Source identity as a new retained version. Chunk and manifest object keys are deterministic and contribution-scoped. The ledger records the pending deterministic commit intent before Archive API performs its R2 writes, then commits only after verifying those objects. A retry after a lost response completes that intent or returns the previous acknowledgement; it never creates another logical copy. Source compaction, rewriting, or disappearance never deletes an earlier observation.

An Archive Steward must first activate the Organization's Conversation Archive, then each User explicitly enrolls each Collector before that machine contributes Raw Transcripts. For the primary case, a Pro owner clicks **Enable Conversation Archive** in Desktop; one guided flow authenticates the owner, creates Archive Activation, enrolls that Desktop, asks whether to import all currently available history, and starts ongoing archive sync. Once activated, another member sees **Contribute this computer**, which records only that User's per-Collector consent and history-import choice. The two authorization records stay distinct even when the owner creates both in one flow. Enrolled archive records use Paid Archive Retention and are removed by the Archive Steward, Organization deletion, or expiration of the cancellation grace period; removing a User stops future collection but retains their existing Archive Contribution.

When the Organization's Pro entitlement ends, archive collection stops and the server archive freezes for 90 days. Enrolled Collectors stop new archive scans but retain pending encrypted Archive Spool data during grace. The Archive Steward may export the archive or restore Pro without re-importing; restoration resumes pending uploads. When grace expires, Trace Flow first destroys every wrapped Archive Encryption Key version for the Organization, making residual ciphertext unreadable, then asynchronously deletes its Archive Chunks, manifests, and session ledgers. The terminal state revokes enrollments and instructs each Collector to purge its Archive Spool the next time it connects.

The Archive Steward has two deletion scopes in v1: one complete Archive Contribution or the entire Conversation Archive. Individual Agent Session deletion is deferred. Contribution deletion first revokes every Collector Enrollment for that Organization and User, blocks new writes under that contribution, then deletes its contribution-scoped session ledgers, chunks, and manifests. Whole-archive deletion revokes all Archive Enrollments, destroys every Archive Encryption Key version first, then deletes the complete Organization prefix and session ledgers asynchronously. Contribution-scoped physical storage avoids shared-chunk reference counting or repacking during deletion.

Pro includes a Conversation Archive with its own fixed 100 GB capacity. Archive writes do not report success or advance archive progress at that cap: the Collector keeps them in its fixed 2 GB encrypted Archive Spool, the archive enters a visible blocked state, and upload resumes only after the Archive Steward explicitly deletes stored archive data. If the spool fills first, archive collection pauses with an action-required error. Parsed fact ingest continues independently. v1 has no separate archive purchase or capacity upgrade. Trace Flow never silently drops or automatically evicts archived conversations.

Conversation Archive Raw Transcripts exist for four reasons:

- Reprocess without re-syncing. A parser fix, a new derived column, or a pricing correction re-reads the stored transcript server-side, re-parses, and replays facts through the same dedupe ledger. Same key and hash is skipped; same key with a different hash becomes an explicit repair signal instead of a hot duplicate insert.
- Deep analysis. Future authorized analysis can scan the retained conversation content without returning to the Source machine.
- Lossless ownership. In v1, the Archive Steward can export the exact Archive JSONL records and Archive Session Manifests without normalization, sanitization, or model-specific templating.
- Future organization-owned model improvement. A later versioned exporter may select coherent Training Segments from Archive Session Manifests and emit a normalized conversational dataset. A compaction boundary closes the pre-compaction segment and starts a new segment with the summary or replacement context the model actually received; the exporter must never flatten earlier full turns and later responses into a fictional context. The normalized dataset and any model-specific chat template remain derived outputs, never the canonical archive.

The v1 Archive Export is an owner-only Trace Flow Desktop operation through Archive API. Each export requires an interactive Archive Steward sign-in that mints a short-lived Archive Export Grant scoped to one Organization and one export. Collector Credentials remain upload-only and cannot read or export archive data. Archive API validates the grant and streams decrypted Archive Chunks in bounded responses; Desktop reconstructs Archive JSONL records and Archive Session Manifests incrementally in a directory chosen by the owner, verifies checksums, and persists local progress so an interrupted export resumes at chunk boundaries. Resuming after the grant expires requires another interactive owner sign-in for the same local export state. The export does not generate or retain a second object in R2, and it is not the sanitized diagnostics export. A future CLI may wrap the same shared export library rather than define a second export protocol.

The Web app provides persistent proof that the feature exists and is working through a Conversation Archive status card on `/app/agents`. Convex owns the access-scoped Archive Status projection. After a ledger commit, capacity change, lifecycle transition, or deletion step, Archive API updates that projection through an authenticated internal mutation with the authoritative durable acknowledgement and Storage Budget values. Collector heartbeats update only their own pending spool bytes, local error, and observation time. The Web card reads the projection through an Organization-scoped Convex query rather than calling Archive API from the browser.

Archive Status is one of `not_enabled`, `active`, `blocked`, `frozen`, or `deleting`. The card shows server-metered bytes against the 100 GB cap, the last durable Archive API acknowledgement, enrolled contributor and Collector counts, the most recent Collector-reported pending spool bytes or error with its observation time, and the Pro grace deadline when frozen. An Archive Steward sees Organization totals and every contributor; an ordinary member sees only their own Archive Contribution and Collectors. Desktop remains the management surface for activation, enrollment, export, and deletion.

Replay heals rather than duplicates only because the dedupe key is stable identity (see Table physics). A fix that changes an existing row's `EventAt` is not a normal append: the ledger treats that as changed content for the same fact key and routes it to repair so the affected serving rows can be rebuilt deliberately.

Without a Conversation Archive, Trace Flow stores no Raw Transcript records. Fact rows still live one year by `EventAt`, and cost-only fixes can re-run pricing over their stored token columns throughout that horizon without a raw read. Structural re-derivation or new columns require either a fresh local import while the Source still exists or an active Conversation Archive. Past one year, expired facts and summaries can be rebuilt only from an active archive.

### Agent fact batching Durable Object

The proxy path uses `TraceBatcher` (a Durable Object) because individual LLM Requests arrive unbatched and need accumulation. Agent ingest also uses a Durable Object boundary, but for a different reason: it is the server-side fact ledger keyed by `(OrgId, fact type, fact id)`. Exact duplicate facts are skipped before Tinybird; changed same-key facts are captured as repair signals. This makes `MergeTree` fact tables viable and keeps query-time `FINAL` off the product path. This does not replace the shared `STORAGE_BUDGET` Durable Object from [R2 Storage Caps](./0013-r2-storage-caps.md), which is a cross-feature billing guardrail rather than an ingest dedupe ledger.

### Data model

Bespoke typed fact tables written directly by the consumer, the `llm_request_facts` analogue. Never routed through `otel_trace_spans`. Agent conversations are not proxied LLM Requests; forcing them into the span schema would lose the turn and tool grain.

Five base fact tables, one attribution-decision table, rebuildable read aggregates, one session aggregate:

| Table                             | Grain                                              | Role                                                                                                                                 |
| --------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `agent_message_facts`             | one turn (Agent Message)                           | direct model-call tokens and estimated cost. Numeric token/cache columns are non-null; coverage columns explain missing source data. |
| `agent_tool_event_facts`          | one tool invocation (Tool Event)                   | failures, command families, durations, subagent/result facts.                                                                        |
| `agent_file_event_facts`          | one file touch                                     | repeated-path attention and hotspots. Repo-relative paths only.                                                                      |
| `agent_capability_snapshot_facts` | one conversation-visible capability observation    | opportunistic capability metadata (Codex strongest); retained for later Context Bloat analysis, no v1 launch query.                  |
| `agent_pull_request_facts`        | one canonical hosted-review link observation       | passive review-unit evidence without provider API calls. Existing name is historical; the row shape is host/repo/number/url.         |
| `agent_review_unit_attributions`  | one session-to-review-unit decision edge           | auditable attribution state only: method, confidence, status, ambiguity, evidence key, rule version. No cost/token/message fields.   |
| `agent_usage_hourly` / `_1d`      | hour / day, by org/source/repo/model               | replacement-snapshot read aggregate for token, cost, cache, message, and session trends.                                             |
| `agent_tool_usage_hourly` / `_1d` | hour / day, by org/source/repo/tool/command_family | replacement-snapshot read aggregate for tool mix and failure rates.                                                                  |
| `agent_session_summaries`         | one Agent Session (aggregate)                      | session-level outliers (cost, file count, duration).                                                                                 |

Tool mix, web/research domains, and task subjects/statuses are cheap queries over the base tables, not their own rollups. Subagent patterns ride on `is_subagent_spawn` / `agent_depth` (messages) and `extracted_subagent_*` (tool events), not a separate table. Tool-event subagent fields are evidence used by the cost classifier and subagent dashboards. Hosted-review links are extracted into their own fact table so Review Unit attribution can work when the link appears in assistant text, tool output, or another transcript record; Review Unit authoring cost reads the canonical session aggregate after dedupe/classification, not raw tool-event cost fields directly.

Sparse source data uses coverage columns, not nullable numeric metrics. Token and cache columns are non-null integers with missing values stored as 0; `token_coverage` is `full`, `partial`, or `missing`, and `cache_coverage` is `full` or `missing`. Claude and Codex are normally `full` for token and cache coverage; Cursor messages with nonzero bubble `tokenCount` are `partial` token coverage and `missing` cache coverage; Cursor messages with only zero/default `tokenCount` are `missing` token coverage and `missing` cache coverage. The consumer sets `cost_usd` to null when token coverage is `missing`, when the normalized model is unpriced, or when the pricing catalog cannot price the row. That preserves the "only Nullable column is `cost_usd`" rule while making sparse Cursor economics honest.

#### Context bloat and context rot (deferred, data retained)

Context Bloat and Context Rot Exposure are deferred. They began as exploratory questions about whether the conversation data even supports them, and the honest answer is: only partially, and only for some Sources. A 2026-05-25 structural sample showed available-capability inventory is essentially absent from Claude transcripts, weak in Cursor, and strong only in Codex `session_meta` (`base_instructions`, `dynamic_tools`). Building utilization rates, context-tax estimates, a Convex Effective Context Length benchmark catalog (HELM/MRCR/RULER), and a context-engineering report on data we mostly cannot see is not a v1 bet.

v1 keeps the door open by retaining the inputs, not by computing the signals:

- `agent_message_facts` already stores input/cache/output tokens for cost, which is also the raw material for any later session-token analysis (first-call context load, cache-creation spikes, tokens per Tool Event). No extra work.
- `agent_capability_snapshot_facts` opportunistically captures conversation-visible capability metadata where a Source exposes it (Codex strongest), so a later analysis has historical coverage instead of starting from zero. It is best-effort and backs no v1 launch query. Capture stays passive and conversation-only: privacy-safe counts, hashed/redacted identities, and size estimates; never raw schema text, skill bodies, config values, environment variables, secrets, or absolute paths. If a transcript does not record the available surface, Trace Flow does not infer it from local config. It never starts MCP servers, calls `list_tools`, shells out to CLIs, or scans agent config.

The metrics, the benchmark catalog, and the report are listed under Deferred. If the retained data later shows the signal is real, that work can be picked up without a re-ingest.

#### Tool use/result reconciliation

The parser emits the tool-use block and the tool-result block as separate events sharing one `tool_use_id`; `extracted_success`, `extracted_exit_code`, and duration live on the result. The Collector folds the pair into one Tool Event fact before sync, carrying both the invocation (tool name, command family, extracted files/queries) and the outcome (status, exit code, duration). This is required for correctness. The use and result blocks share one `tool_use_id`, hence one `tool_use_pk`: keep them as two rows and the failure-rate denominator double-counts every invocation, while a pre-Tinybird ledger would treat one side as a conflicting repair for the other. Folding the pair in the Collector avoids both. This single reconciled row replaces the research note's `tool_phase` column.

Operational context is structured first, excerpt second. Tool Event facts carry normalized fields for `tool_name`, `command_family`, command program/subcommand where available, status, exit code, duration, target repo-relative paths, and extracted provider/repo/PR hints. They may also carry capped redacted excerpts such as `command_excerpt` and `error_excerpt` for debugging context. `command_excerpt` is capped at 1 KB, `error_excerpt` is capped at 4 KB, and total excerpt text per Tool Event is capped at 5 KB. Dashboards and rollups should group by structured fields; excerpts are supporting detail, not identity or aggregation keys.

If redaction detects likely sensitive content but cannot confidently sanitize a field, the Collector drops that field instead of uploading it. The fact carries redaction status/counter metadata such as `dropped_sensitive` so the UI can explain missing context without exposing the value. Local logs may report that redaction dropped a field, but must not print the dropped content.

Local logs are safe to share by default. They do not include raw transcript text, raw command/output blobs, API keys, tokens, cookies, or dropped redaction content. Logs should prefer structured event counts, Source names, statuses, error classes, and repo-relative or redacted paths; they may be less detailed than uploaded facts.

File facts store repo-relative paths only. Files inside the primary Repo are normalized relative to that Repo; files outside the Repo are dropped or represented by a coarse category such as `outside_repo`, never by an absolute local path. This is both a privacy guard and a correctness guard for worktree-heavy setups where absolute paths are noisy, surprising, and unstable.

For worktrees, Repo identity resolves from the observed worktree's own git metadata and normalized remote, not from the main checkout path. The Collector may run `git -C <cwd> rev-parse --show-toplevel` and read that worktree's remote config on demand, then cache the observed cwd/worktree root to normalized remote mapping. Absolute worktree paths are not uploaded and are not identity.

Branch name and HEAD SHA are optional attribution hints, not identity. When cheaply available from the observed worktree, the Collector may capture sanitized `git_branch` and `git_head_sha` to help explain ambiguous sessions and support future PR attribution. Missing or stale hints never fail sync, and branch/head are not part of Repo identity, Agent Session identity, or dedupe keys.

### Table physics

```sql
agent_message_facts
  ENGINE MergeTree
  SORTING KEY OrgId, session_pk, message_pk
  PARTITION BY toYYYYMMDD(EventAt)
  TTL EventAt + INTERVAL 1 YEAR

agent_tool_event_facts
  ENGINE MergeTree
  SORTING KEY OrgId, session_pk, tool_use_pk
  PARTITION BY toYYYYMMDD(EventAt)
  TTL EventAt + INTERVAL 1 YEAR

agent_file_event_facts
  ENGINE MergeTree
  SORTING KEY OrgId, session_pk, file_event_pk
  PARTITION BY toYYYYMMDD(EventAt)
  TTL EventAt + INTERVAL 1 YEAR

agent_capability_snapshot_facts
  ENGINE MergeTree
  SORTING KEY OrgId, session_pk, capability_snapshot_pk
  PARTITION BY toYYYYMMDD(EventAt)
  TTL EventAt + INTERVAL 1 YEAR

agent_pull_request_facts
  ENGINE MergeTree
  SORTING KEY OrgId, session_pk, pull_request_link_pk
  PARTITION BY toYYYYMMDD(EventAt)
  TTL EventAt + INTERVAL 1 YEAR

agent_review_unit_attributions
  ENGINE MergeTree
  SORTING KEY OrgId, rule_version, session_pk, review_unit_attribution_pk
  PARTITION BY toYYYYMMDD(DecidedAt)
  TTL DecidedAt + INTERVAL 1 YEAR
  stores only attribution decisions; latest-decision reads use argMax by DecidedAt, IngestedAt, and review_unit_attribution_pk
  Review Unit cost joins to agent_session_summaries

agent_session_summaries
  ENGINE AggregatingMergeTree
  SORTING KEY OrgId, session_pk
  NO PARTITION KEY
  maintained by incremental materializations from append-clean fact tables

agent_usage_hourly / agent_usage_daily
  ENGINE AggregatingMergeTree
  SORTING KEY OrgId, BucketStart, source, model, repo_fingerprint
  maintained by incremental materializations from append-clean message facts
  TTL BucketStart + INTERVAL 1 YEAR

agent_tool_usage_hourly / agent_tool_usage_daily
  ENGINE AggregatingMergeTree
  SORTING KEY OrgId, BucketStart, source, tool_name, command_family, repo_fingerprint
  maintained by incremental materializations from append-clean tool facts
  TTL BucketStart + INTERVAL 1 YEAR

session_pk  = hash(source, vendor_session_id)
message_pk  = hash(source, vendor_session_id, vendor_message_id)
tool_use_pk = hash(source, vendor_session_id, tool_use_id)
file_event_pk = hash(source, vendor_session_id, vendor_message_id, normalized_repo_path, operation, source_block_index)
capability_snapshot_pk = hash(source, vendor_session_id, source_snapshot_id_or_stable_turn_index)
pull_request_link_pk = hash(source, vendor_session_id, source_event_id_or_stable_turn_index, canonical_pull_request_url)
review_unit_attribution_pk = hash(source, vendor_session_id, rule_version, decision_signature)
```

The sorting key holds stable tenant and row identity first. The ingest ledger, not ClickHouse merge
behavior, is responsible for idempotency. Agent facts are re-parsed over time, and `model`,
`repo_fingerprint`, `command_family`, `tool_name`, capability labels, size estimates, and PR-link
confidence can improve. Those mutable parser outputs stay out of fact identity; the `*_pk`
surrogates hash immutable vendor IDs and stable source positions. Query-local dimensions live in
serving tables ordered by the dashboard filters.

`OrgId` leads for org-scoped reads; `session_pk` groups a session's rows for drilldown. `UserId`, `CollectorId`, and `CollectorCredentialId` are regular columns because they are attribution and internal audit metadata, not row identity. Partition and TTL key on `EventAt` for fact rows, never ingest time and never session `StartedAt`. `EventAt` is the timestamp of the specific message, tool result, file event, capability observation, or hosted-review link evidence. Partitioning by event time lets a re-synced old row land in its original partition and dedupe while avoiding the long-lived-session trap where a session that started a year ago but resumed today would immediately age out new work. A one-time historical backfill still keeps only the last year of facts because rows with old `EventAt` values are TTL-eligible on arrival.

`StartedAt` remains session metadata: the earliest observed conversation-turn timestamp (`user`/`assistant` records only), computed in the ingest Worker so it stays a pure function of the session's turn bytes. `LastEventAt` is the newest event timestamp observed for the Agent Session and is the retention anchor for the `agent_session_summaries` summary. `VendorStartedAt` is the Source's declared session start when it exists (Codex emits it in `session_meta`; Claude's UUIDv4 id does not, so it stores a zero sentinel to preserve the single-Nullable-column rule). Excluding app-metadata record types (`ai-title`, `queue-operation`, `attachment`, `pr-link`, `last-prompt`) from `StartedAt` keeps Claude Code version drift from shifting session metadata; changing `EventAt` for a real fact is the partition-moving case that requires an affected-partition rebuild before replay.

All fact-row event timestamps (`EventAt`, `IngestedAt`, `LastEventAt`, `StartedAt`, `VendorStartedAt`) are `DateTime64(3)`; rollup `BucketStart` is `DateTime`. This deliberately diverges from `llm_request_facts`, which stores `Int64` epoch-nanoseconds because its source is OTel spans; agent facts are parsed from transcripts with no nanosecond source, so the partition and TTL expressions above (`toYYYYMMDD(EventAt)`, `EventAt + INTERVAL 1 YEAR`) read the column directly with no `/1e9` conversion. `VendorStartedAt`'s zero sentinel is the epoch (`1970-01-01 00:00:00.000`).

`agent_session_summaries` is not partitioned. It holds aggregate states by `(OrgId, session_pk)`, and
materialized pipes merge message, tool, file, and pull-request facts into one serving table. Session
metadata chooses the latest relevant event with aggregate states instead of rebuilding a full snapshot
on a schedule.

### Dedupe

Facts are deduped before Tinybird. The Collector stores local cursors and fact checksums so normal
appends only send new or changed facts. The agent consumer then routes rows through a sharded Durable
Object ledger keyed by `(OrgId, fact type, fact id)`. Same key and hash is skipped. Same key with a
different hash is captured as a repair signal and not inserted into the hot fact table.

Materialized rollups are serving tables, not the source of truth. They are maintained incrementally
from append-clean facts with `AggregatingMergeTree` aggregate states. Because duplicate physical facts
are blocked before Tinybird, additive aggregate states are safe in the normal path. Repairs and
backfills are explicit operations over bounded windows; they do not run as scheduled replacement-copy
jobs.

### Cost and pricing

Cost is computed server-side in the consumer from tokens and model, reusing the chain Trace Flow already runs for proxied LLM Requests. The Collector ships tokens and model only and never prices. Otto's parser computes `cost_usd` locally from a price map; that behavior is not carried into Trace Flow, so pricing exists in exactly one place. Server-side is the natural home: it is one pricing implementation to maintain and correct, it is where proxied LLM Requests are already priced, and it keeps the per-model price catalog and KV out of the desktop client.

This cost is an API-equivalent estimate of model usage represented in the transcript, not actual provider spend. For pay-as-you-go API usage it should be close to actual billable usage when model pricing and token fields are complete; for flat subscriptions, bundled plans, Cursor house models, credits, discounts, or provider-side rounding, it is not an invoice or cash-spend ledger. Actual provider account spend and subscription/quota state belong to the separate Provider Usage Tracking feature, not Agent Conversation Analytics.

The canonical cost unit is Agent Session Authoring Cost: every billable model usage record represented in the Agent Session, including nested/subagent work, counted exactly once. It is built from an explicit priced-usage view before session, hourly/daily, and PR aggregates are calculated:

- Include direct Agent Message usage for top-level, nested, and sidechain messages.
- Include source-reported subagent/result usage only when there is no matching nested/sidechain Agent Message usage for the same Source, `session_pk`, and subagent agent id.

This rule comes from checking Otto's parser and local Claude Code data, not from a theoretical schema. Otto persists `extracted_subagent_*` token fields on tool-result rows, while Claude Code also writes subagent transcript files under the same session with `isSidechain=true` and `agentId`. In current Claude data the parent/subagent `toolUseResult.usage` can match one sidechain assistant call, not the whole subagent transcript; blindly adding both over-counts, while ignoring the tool-result usage can under-count older or incomplete imports where the sidechain transcript is missing. Trace Flow stores both forms as facts, classifies them into one priced-usage view, and exposes coverage when only summary/fallback subagent usage is available.

`agent_session_summaries.cost_usd`, `agent_usage_hourly` / `_1d`, and Review Unit authoring-cost queries must all read from that same canonical priced-usage view or aggregate. No code path should define Review Unit cost as "sum `agent_message_facts.cost_usd`" or "sum messages plus all tool subagent costs" independently, because those two shortcuts fail in opposite directions.

A shared `@trace-flow/pricing` workspace package holds the calculation, used by both the proxy consumer and the agent consumer. A daily Convex cron `importFromModelsDev` mirrors `importFromOpenRouter`: it pulls `models.dev/api.json` into the `modelPricing` table, then syncs to Cloudflare KV. First-party providers only; gateway re-listings of the same model are skipped. Pinning to first-party is mandatory, not a preference: each corpus model also appears under roughly 25 gateway re-listings (helicone, auriko, databricks, nano-gpt) at divergent prices, so the import must read the `anthropic` and `openai` provider entries specifically or it will silently mis-price. `gpt-5.5` uses context-tier pricing (about 2x above a 200k-token context) and Codex runs near a 258k window, so `calculateCost` must be context-tier-aware for it rather than applying one flat rate. `importFromOpenRouter` stays for `provider=openrouter`. The `source` enum gains `'models.dev'` (three files: `schema.ts`, `modelPricing.ts`, `pricing.ts`).

models.dev does not publish reasoning or 1-hour-cache rates, so `calculateCost` falls back gracefully for those components; the missing 1-hour cache-write rate has low single-digit dollar impact because cache-creation is roughly 2% of cache-read volume in the corpus. `cost_usd` is `Nullable(Float64)`: null means no price exists for the model or the row lacks usable token coverage, 0 means a genuinely free priced model. Cursor rows with `token_coverage = 'missing'`, Cursor house models (`composer-*`, `default`) absent from the catalog, `<synthetic>`, and the `codex-auto-review` alias resolve to null; alias `codex-auto-review` to its underlying gpt-5 model or accept it in the coverage denominator, and normalize Cursor model labels (strip reasoning suffixes like `-xhigh` / `-high-thinking`) before catalog lookup. This is the one deliberate exception to the avoid-Nullable rule. That rule targets always-present and sorting-key columns, where the hidden null-map is pure overhead; `cost_usd` is neither, and it needs a real not-applicable state, so the null-map is the honest representation rather than waste. null drives the coverage metric below (`count(cost_usd) / count(*)`) and backfills to a price on re-sync once the catalog covers the model.

Cost is a derived value the store can rebuild, not a number frozen at first ingest. Tokens are immutable stored columns, so across the fact rows' one-year life a cost-only fix re-runs pricing over them in place with no fresh import or raw read. A deeper structural correction replays an enrolled Conversation Archive or requires a fresh local import if no archive exists.

### Failure semantics

`status` is `LowCardinality(String)` in {`success`, `failure`, `unknown`}, mapped from `extracted_success` (None becomes `unknown`). This avoids a Nullable boolean. `failure_rate = failure / (success + failure)`. `unknown` is excluded from the denominator but counted, so a source with poor outcome signal shows up as low coverage rather than as false success.

### Retention and visibility

Storage splits by sensitivity. Agent fact tables carry a one-year TTL by `EventAt`, and `agent_session_summaries` carry a one-year TTL by `LastEventAt`; they may include bounded redacted operational excerpts but never full prompt/response transcript text. Full Raw Transcripts exist only in an explicitly activated and enrolled Pro Conversation Archive, use Paid Archive Retention, and count against its fixed 100 GB pool. Losing Pro stops collection and starts the 90-day frozen grace before cryptographic erasure. Hobby and unenrolled Collectors store no server-side transcript content.

Visibility is tier-gated at read time and decoupled from storage: a hobby org sees the last 7 days, a pro org the full retained window. A tier upgrade reveals already-stored history without re-ingestion, an upsell lever rather than an accident. Both terms are defined in the glossary (Retention Window, Visibility Window).

### Launch queries

All deterministic, zero tuning. The research note's "failing above baseline" detector is dropped; it would have needed fine-tuning to be useful.

1. **Failure leaderboard.** Rank (`tool_name`, `command_family`) by failure rate and count over a window, with a display floor of at least N events so rare tools do not top the chart on one failure.
2. **Period-over-period delta.** This window versus the prior, sorted by movement, via a self-join on `agent_tool_usage_hourly` or `agent_tool_usage_daily`.
3. **Session outliers.** Top sessions by cost and file count (the "$400 and 200 files" case) from the `agent_session_summaries` aggregate.

`agent_tool_usage_hourly` is logically keyed on `BucketStart` (hour), `OrgId`, `source`, `tool_name`, `command_family`, and `repo_fingerprint`, with counts for success/failure/unknown and summed duration. Materialized rows are aggregate states from append-clean facts.

Post-launch product signals are tracked in
[`signal-catalog.md`](../guides/agent-conversation-analytics/signal-catalog.md). That catalog separates
high-confidence signals such as runaway Agent Sessions, cache-read pressure, tool failure categories,
file hotspots, and hosted-review link coverage from weaker or non-actionable signals. Product surfaces
must preserve those confidence labels instead of turning exploratory correlations into claims.

### Trust boundary

Trusted in v1: deduped counts, windowed trends, source attribution, remote-resolved repo attribution (`repo_source = remote`), deterministic rankings.

Provisional, surfaced honestly rather than hidden:

- Path-fallback repo attribution (`repo_source = path`) creates a Provisional Repo until a remote-bearing re-sync heals it. This includes local-only repositories before their first push, so the work is visible before a remote exists. It also affects pre-install history and worktrees deleted before the Collector first observed the session.

- Multi-repo Agent Sessions. v1 keeps one primary Repo per Agent Session, so work that spans several repositories is not split across repos or Review Units. Secondary repo references can be added later if real workflows need that precision.

- Multi-review-unit Agent Sessions. v1 attributes an Agent Session's authoring cost to at most one primary Review Unit. If one session has credible evidence for several review units, Trace Flow does not split the session cost or pick one; the cost remains repo-level. Clean review-unit cost reporting therefore depends on the workflow convention of keeping one Review Unit per Agent Session when precise attribution matters; for now that convention lives in docs, not in product UI guidance.

- Subagent cost coverage. Direct nested/sidechain Agent Message usage is authoritative when present. Tool-result subagent usage without matching nested/sidechain messages is counted as fallback evidence and surfaced as lower coverage, because some Sources/versions report only a partial result summary there.

- Codex per-message dedupe. Codex exposes no vendor message ID, so its `message_pk` uses a positional turn index; a re-parse that renumbers turns can move it, splitting or merging a Codex message row. Claude and Cursor, with real message IDs, are unaffected.

- Absolute spend. Agent cost is API-equivalent estimated authoring cost, not actual provider spend. Show priced-token coverage % (the share of rows with non-null `cost_usd`) and label dollars as estimated cost rather than "$X spent," especially while coverage is incomplete.
- Cross-version totals. Every fact carries `parser_version`; re-ingest self-heals via newer `IngestedAt`; windows mixing versions are flagged.
- Cross-user reuploads. `UserId` is first-writer-owned for an `OrgId + session_pk`. A same-transcript upload from another user is rejected as `session_owner_conflict` rather than overwriting attribution or duplicating the Agent Session.
- Outcome attribution beyond `status` is deferred; facts stay descriptive.
- Raw base rows are append-clean before Tinybird; dashboards read serving aggregates or clean facts without query-time dedupe.
- Paths are normalized to repo-relative at ingest, which doubles as a privacy guard stripping the home directory and username.

Data quality is surfaced inline (coverage %, version flags) rather than in a separate detector table.

## Data quality verification

Verified 2026-05-25 against the live local corpus before build, by read-only sampling of the actual stores. Figures are from real data, not estimates.

### Corpus scale and field coverage

The corpus is statistically ample: a single 300-file Claude sample held 15,806 assistant messages across 151 distinct projects, spanning months. Coverage of the fields this ADR extracts, per source:

| Source                      | On disk                         | Tokens                                                    | Model                                                        | Cache detail                                          | Repo/project                          | Verdict            |
| --------------------------- | ------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------- | ------------------ |
| Claude `~/.claude/projects` | 6,674 files / 1.8 GB            | usage on 100% of assistant msgs                           | 99.8% real (0.2% `<synthetic>`)                              | input, cache_creation (ephemeral_1h + 5m), cache_read | `cwd` on ~93% of records              | gold standard      |
| Codex `~/.codex/sessions`   | 101 files / 146 MB              | `token_count` in 99% of sessions                          | `turn_context.model`                                         | `cached_input_tokens`, `reasoning_output_tokens`      | `git.repository_url` in 93%, cwd 100% | rich, repo in-band |
| Cursor `state.vscdb`        | 3.5 GB / 123,790 bubbles        | `tokenCount` nonzero on 0.9% (1,085); 93.3M in / 5.2M out | `modelConfig.modelName` on ~99% of composers (Cursor labels) | none (no cache fields)                                | `cwd` per composer/workspace          | partial economics  |
| Cursor `projects`           | 718 files                       | none                                                      | none                                                         | none                                                  | path only                             | legacy, text only  |
| Cursor `acp-sessions`       | 38 real DBs / 118,365 stub dirs | none                                                      | `modelName` label only                                       | none                                                  | `cwd` in `meta.json`                  | not the target     |

### Two accuracy traps, both measured

Both raw stores need de-duplication; naive summation overcounts badly.

Claude repeats per-message usage. Claude Code writes several JSONL records per assistant message (one per content block), each carrying the same `message.usage`. Summing raw records against de-duplicating by `message.id` diverged by 2x to 15x across sampled sessions (one case: 49 records collapse to 15 messages, raw 19,600 versus deduped 1,320 output tokens). The `message_pk` surrogate plus the pre-Tinybird fact ledger collapses this correctly, which confirms message-grain dedupe is load-bearing rather than an optimization.

Codex token counts are cumulative. Each `event_msg.token_count` carries a running `total_token_usage` and a per-turn `last_token_usage`. In one 671-event session: final `total_token_usage` was 83.3M; summing `last_token_usage` deltas gave 83.4M (consistent); summing `total_token_usage` gave 27.6B, a 331x overcount. The Collector must sum `last_token_usage`, or take the final cumulative, and never sum the running totals. This belongs in Collector obligation 1 next to "strip local pricing."

### Pricing coverage (models.dev)

Every model in the corpus resolves to a first-party price carrying input, output, cache_read, and cache_write: the six Claude models in use (haiku-4-5, opus-4-7, opus-4-6, opus-4-5, sonnet-4-6, sonnet-4-5) and `gpt-5.5`. Absolute dollar cost is therefore computable for roughly 99% of token volume, and the dominant component, `cache_read`, is priced. Four bounded caveats:

1. First-party pinning is mandatory. Each model ID also appears under roughly 25 gateway re-listings (helicone, auriko, databricks, nano-gpt) at differing prices, so `importFromModelsDev` must read the `anthropic` and `openai` provider entries. This is exactly the "first-party only" rule under Cost and pricing.
2. `gpt-5.5` uses context-tier pricing (about 2x over 200k tokens). Codex runs near a 258k window, so `calculateCost` must be tier-aware for it, not flat.
3. No 1-hour cache-write rate exists in the catalog (only one `cache_write`, the 5-minute rate). Claude's `ephemeral_1h_input_tokens` bill at roughly 2x and fall back to the 5-minute rate. Dollar impact is low single digits because `cache_creation` is about 2% of `cache_read` volume.
4. `codex-auto-review` (a review-pass alias) and `<synthetic>` have no catalog price, so `cost_usd` is null for them. Alias the former to its underlying gpt-5 model or accept it in the coverage denominator.

### Cursor economics live in state.vscdb (partial)

An initial pass concluded Cursor had no economics, because the `~/.cursor/projects` and `~/.cursor/acp-sessions` samples carry none. That was incomplete. Cursor's real store is `state.vscdb`, a VS Code-style SQLite key-value DB (table `cursorDiskKV`) at `~/Library/Application Support/Cursor/User/globalStorage/` (3.5 GB), plus per-workspace copies under `workspaceStorage/<hash>/`. It is the store mature OSS extractors target (cursor-view, cursor-history, cursor-chat-export).

Identity and fields, verified 2026-05-25 over the live DB: sessions are `composerData:<composerId>` rows, messages are `bubbleId:<composerId>:<bubbleId>` rows, with the composerId embedded in the message key. Composers carry `modelConfig.modelName` on 3,396 of 3,417 (~99%), but as Cursor-specific labels — reasoning suffixes (`gpt-5.2-xhigh`, `claude-4.5-opus-high-thinking`), proprietary house models (`composer-1`, `composer-2-fast`), and `default` — that need normalization and are partly unpriceable. Bubbles carry `tokenCount.{inputTokens,outputTokens}` as an object on all 123,790 rows but nonzero on only 1,085 (0.9%), summing 93.3M input and 5.2M output; there is no cache breakdown and no per-bubble model (attribute via the composer). The denser `agentKv:` blobs (209,618 rows) likely hold fuller per-request usage and remain unparsed; characterizing them is an implementation task.

Two operational notes for the parser: read Cursor through a snapshot, not by mutating or checkpointing Cursor's live DB, and scan key prefixes with `GLOB 'bubbleId:*'`, never `LIKE` — SQLite `LIKE` is case-insensitive by default, which disables the `key` index and forces a full scan of the multi-GB table (the cause of two stalled verification runs here). The preferred snapshot path is SQLite's backup API into the Collector cache; copying `state.vscdb`, `state.vscdb-wal`, and `state.vscdb-shm` is only acceptable when it yields a consistent read-only snapshot. The immutable SQLite URI belongs on the copied snapshot, not on Cursor's actively written database.

Scope implication: Cursor contributes session-grain model attribution and sparse message-grain tokens, not Claude/Codex-grade economics. The full cost, token, and cache product stays Claude plus Codex; Cursor adds model and partial token coverage with zero-valued cache columns marked `cache_coverage = 'missing'`, and many Cursor rows still price to null (missing token coverage, unpriceable house models). The "all three sources from day one" framing holds, and Cursor is now more than activity-only, but it is not an economics peer of Claude and Codex.

### Incidental: worktree fragmentation

By raw `cwd`, the trace-flow repo split across `~/src/trace-flow`, two `~/.t3/worktrees/trace-flow/*` paths, and `~/src/trace-flow-moar-columns`: four "projects," one repo. This validates `repo_fingerprint = hash(normalized remote)` over path grouping. The worktree-heavy setup makes remote normalization necessary, not optional.

## Deferred

Explicitly out of v1, to be added when a real need appears:

- Separate `agent_subagent_events` table (covered by message and tool-event fields).
- Anomaly-feature table (`agent_anomaly_features_1h`) and z-score detectors.
- `agent_source_observations` and `agent_import_batches` provenance tables.
- Secondary Repo references and split-cost attribution for multi-repo Agent Sessions.
- Split-cost attribution for Agent Sessions that span multiple Review Units.
- The Project Convex entity.
- Normalized training-dataset export, model-specific chat templates, and hosted fine-tuning. v1 preserves and exports the lossless Archive JSONL plus manifests only; future training outputs remain rebuildable derivatives.
- Context Bloat metrics: capability utilization rate, unused-capability context tokens, and context-tax estimate. v1 opportunistically stores `agent_capability_snapshot_facts` but computes and reports none of these.
- Context Rot Exposure and its Convex Effective Context Length benchmark catalog (HELM/MRCR/RULER bands), plus the context-engineering report. v1 retains session token/cache facts but ships no bands, no catalog, and no report.
- Active MCP probing or local config scanning. Starting MCP servers, calling dynamic tool-list APIs, or reading agent configuration files outside the Source transcript stores is out of scope; any later Context Bloat work stays derived from conversations, not direct tool discovery.
- Running Trace Flow's own long-context benchmark suite. Independent verification is deferred until the signal proves valuable; any earlier Context Rot work would use public/curated Effective Context Length data only.

## Trade-offs

- Eventual consistency. Facts appear seconds after a sync, like the proxy path.
- Collector-side reconciliation means the desktop app owns more parsing logic, but it keeps the payload to one row per tool invocation and the consumer simple.
- Fact retention remains tier-independent at one year while visibility is tiered. Raw Transcript retention is a separate explicit Pro Conversation Archive capability and does not change fact visibility.
- No agent batching DO means no second batching tier; we rely on the Collector pre-batching and accept slightly larger per-invocation inserts.
- Replay, deep analysis, structural re-derivation, and lossless export require Conversation Archive enrollment. Unenrolled Organizations accept that those capabilities require a fresh local import if the Source still exists; training datasets remain future rebuildable projections rather than a second canonical store.

## Done

Verifiable outcomes for the v1 slice:

- A local transcript parsed by the Collector becomes queryable typed facts (`agent_message_facts`, `agent_tool_event_facts`, `agent_file_event_facts`, `agent_capability_snapshot_facts`, `agent_pull_request_facts`) for the owning org, filterable by `source` and `repo_fingerprint`.
- A remote-backed Agent Session resolves to one first-class Repo record with normalized display metadata; multiple worktrees or renamed checkouts for the same normalized remote collapse to that Repo.
- A local-only Agent Session without a remote still creates a Provisional Repo; after the same observed path/worktree later resolves a remote, the Provisional Repo heals into the remote-backed Repo, while same-name-only repos do not merge.
- Review Unit authoring cost is queryable from canonical Agent Session Authoring Cost by joining `agent_review_unit_attributions` to `agent_session_summaries`; no provider API call, provider CLI, or local provider auth is required.
- Hosted-review link evidence lands in `agent_pull_request_facts` with canonical host/owner/repo/number/url fields, source evidence metadata, and confidence; links are extracted passively from transcripts only.
- Direct attribution creates a decision edge only when passive transcript evidence contains exactly one review link in the same Repo; no evidence, cross-repo evidence, or credible evidence for multiple Review Units remains Unattributed Repo Authoring Cost.
- Branch retro-attribution is a later, lower-confidence rule based on local `repo_fingerprint + git_branch` evidence. Branch-only work without a review link is reported as Branch Cost, not Review Unit Cost.
- A Claude session, a Codex session, and a Cursor session (from `state.vscdb` `cursorDiskKV`: `composerData:` sessions and `bubbleId:` messages) each parse to facts under a vendor-UUID `session_pk`; Claude and Codex carry full token, model, and cache columns, while Cursor carries a normalized model and, where the bubble `tokenCount` is populated with nonzero values, tokens; Cursor cache columns are zero with `cache_coverage = 'missing'`. Claude and Cursor subagent transcripts land under their parent's `session_pk` with `agent_depth` > 0, not as standalone Agent Sessions.
- The Cursor parser snapshots `state.vscdb` before reading, joins `bubbleId:<composerId>:*` messages to their `composerData:<composerId>` session with `GLOB` prefix scans (never `LIKE`), normalizes the composer `modelConfig.modelName` label (reasoning suffixes stripped, house `composer-*`/`default` left unpriced), and emits nonzero tokens only where the bubble `tokenCount` is nonzero.
- Agent Session Authoring Cost includes top-level, nested, and sidechain model usage exactly once; `agent_session_summaries.cost_usd`, `agent_usage_hourly`, `agent_usage_daily`, and Review Unit authoring-cost queries all agree because they derive from the same append-clean facts.
- A Claude fixture with both a subagent transcript file and a matching `toolUseResult.usage` row does not double-count the overlapping subagent usage; a fixture with only tool-result subagent usage counts that fallback usage and marks the session's subagent cost coverage as partial/fallback.
- Re-syncing the same Agent Session twice does not change counts: local checksums and the server-side ledger skip same-key/same-hash facts before Tinybird. Query-time rollups over clean facts match materialized serving aggregates. A session whose facts span two `EventAt` days materializes to exactly one `agent_session_summaries` row.
- Direct `agent_message_facts.cost_usd` and any included fallback subagent usage cost are computed in the consumer from KV pricing; no pricing math runs in the Collector; priced-token coverage % is queryable.
- The Collector source has no local cost calculation, and a fact reaches the consumer carrying tokens and model but no price.
- The daily `importFromModelsDev` cron populates `modelPricing` with `source='models.dev'`; a known first-party model resolves to a non-zero price; an unknown model lands with null `cost_usd` and is backfilled on a later run once the catalog covers it.
- The import reads first-party (`anthropic`, `openai`) prices, not gateway re-listings, so a model with both does not pick up a gateway rate; a `gpt-5.5` usage record above the 200k-token context tier prices at the higher tier, not the flat base rate.
- A Codex session's per-message tokens derive from `last_token_usage` deltas (or the final cumulative), so its session total matches the transcript's final `total_token_usage` rather than the ~331x sum of running totals; a Claude message split across multiple JSONL records counts its `usage` once after `message_pk` dedupe.
- The failure leaderboard returns ranked (`tool_name`, `command_family`) with the display floor applied; the period delta returns movers via query-time rollup or a rebuilt rollup self-join; the session-outlier query returns top sessions by cost and file count.
- Capability Snapshot upload excludes raw MCP schemas, skill bodies, config values, secrets, environment variables, and absolute local paths; sample rows contain counts, stable hashes, redacted labels, and size/token estimates only.
- Collector Credential creation, rotation, revocation, and Stronghold recovery do not create user-facing API Keys and do not fragment Agent Session rows; the same transcript re-synced under a replacement Collector Credential dedupes by `OrgId` + `session_pk` + row key, with the new credential retained only as hidden internal audit metadata.
- Re-syncing the same transcript under the original `UserId` may update rows through normal dedupe; re-syncing it under a different `UserId` in the same Organization is rejected as `session_owner_conflict` and does not overwrite the original uploader's attribution.
- `status` is one of {`success`, `failure`, `unknown`}; `unknown` is excluded from the failure-rate denominator; the schema's only Nullable column is `cost_usd` (null = unpriced model or missing usable token coverage).
- No stored `agent_file_event_facts` path contains a home directory or username (verified by scanning a sample for `/Users/` and `$HOME`); stored paths are repo-relative.
- An oversized POST returns 413; an over-rate org returns 429; the ingest Worker chunks a large batch into sub-128KB queue messages; a backfill of the 135-day heavy-user corpus drains through the queue without the consumer hitting CPU/subrequest limits or shedding to the DLQ.
- Fact tables carry a one-year TTL on `EventAt`; re-syncing a row older than its original partition still dedupes (partition/TTL key on event time, not ingest time); a backfilled row whose `EventAt` predates the one-year fact window does not survive the next merge; a long-lived Agent Session that resumed today keeps today's facts even if `StartedAt` is older than one year; a hobby org's reads are clamped to the last 7 days while a pro org sees the full retained window.
- Without Archive Activation and Collector Enrollment, fact sync uploads no Raw Transcript fields and Agent Ingest has no implicit raw-storage side effect.
- An enrolled Pro Collector losslessly imports all currently available Source history when chosen, then appends new observations without losing earlier versions after Source compaction or rewriting.
- Claude JSONL, Codex JSONL, and Cursor `cursorDiskKV` fixtures survive Archive JSONL export and re-import byte-for-byte at the Source-native payload boundary, including non-JSON Cursor values.
- Re-uploading an unchanged session through a second enrolled Collector leaves the same logical record count, live bytes, Archive Chunk keys, and manifest generation. Changed content under the same Source record identity adds a retained version, and Source compaction never removes a prior observation.
- Archive Chunks contain records from exactly one Archive Contribution and Agent Session, do not exceed 16 MiB, and flush early at session or sync boundaries. An Archive Session Manifest resolves every ordered record identity and content hash to a chunk byte range.
- Conversation Archive chunks and manifests reserve against the dedicated 100 GB pool; at the cap, fact ingest still succeeds while archive data remains unacknowledged in the encrypted Archive Spool with reason `storage_cap_exceeded`.
- Archive Encryption Key rotation makes the new version active before new writes, re-encrypts old objects in the background, and destroys an old wrapped key only after no live archive object references it.
- An ordinary member cannot read, export, or delete another User's Archive Contribution. An Archive Steward can export every contribution and can delete one complete Archive Contribution or the whole Conversation Archive, but cannot delete one Agent Session in v1.
- Archive Contribution deletion first revokes that User's Collector Enrollments and then deletes only that contribution's session ledgers, chunks, and manifests. Whole-archive deletion and terminal Pro-grace expiry destroy every wrapped Archive Encryption Key version before object deletion.
- A lossless Archive Export requires a fresh Archive Export Grant, resumes at Archive Chunk boundaries after interruption, verifies checksums, and produces Archive JSONL plus manifests without creating a server-side export copy. A Collector Credential cannot authorize it.
- `/app/agents` always shows one Archive Status from `not_enabled`, `active`, `blocked`, `frozen`, or `deleting`, server-metered bytes against 100 GB, last durable acknowledgement, contributor and Collector counts, and timestamped Collector spool/error observations. Owners see Organization totals; members see only their own contribution status.
- Archive API updates the Convex Archive Status projection only after authoritative server transitions; Collector heartbeats can update only their own timestamped local fields, and the Web query enforces owner-wide versus member-own visibility.
- Replaying a session from its Conversation Archive re-derives facts and updates rows in place with no re-sync from the Source machine: the post-replay count is unchanged and the newest `IngestedAt` wins.
- Re-running pricing over stored tokens corrects `cost_usd` with no fresh import or Raw Transcript read for any session still inside the one-year fact window, regardless of Conversation Archive enrollment.
- v1 creates no normalized training dataset, model-specific chat template, or hosted fine-tuning job.
