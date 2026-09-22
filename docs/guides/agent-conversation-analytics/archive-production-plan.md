# Conversation Archive: repair plan

Reviewed code: 3339d24b. Status: proposed. Nothing in this document has been implemented, released, or run against production.

Goal: Trace Flow Desktop captures every Claude and Codex conversation file into the encrypted spool and uploads it to R2, indefinitely, with no manual action. The owner can restore the whole archive and verify bytes.

Historical implementation and Cloud-Dev evidence stays in [archive-recovery-runbook.md](archive-recovery-runbook.md).

## What is actually broken

| Problem                                                                                                              | Evidence                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collector credentials expire after 90 days. Expiry maps to `Frozen`, which stops capture and upload.                 | `packages/convex/httpRoutes/mcpCallback.ts:108`, `packages/convex/collectorCredentials.ts:98`, `packages/utils/src/collector-auth.ts:98`, `collector-archive-sync/src/policy.rs:22-28,81`. The installed collector went dark on 2026-09-21. |
| Reconnect mints a new collector ID and credential row, so the enrollment (and its `authorized_at` baseline) changes. | `mcpCallback.ts:109`, `collectorLogin.ts:70`, `archiveEnrollmentSlots` keyed by credential id in `packages/convex/schema.ts:556`. Under `new_only` consent a new baseline excludes everything written since expiry.                         |
| Archive policy refresh lives in the fact-sync engine, and a test-only composed capture/upload path still exists.     | `apps/desktop/src-tauri/src/engine.rs:877-930`, `collector-embedder/src/sync.rs:109,299`, `collector-archive-sync/src/cycle.rs:155` (`run_archive_cycle`, callers are tests and one example only).                                          |
| Initial import can report `Complete` while discovery skipped files.                                                  | `collector-embedder/src/archive_history/mod.rs:302` records errors; `collector-archive-sync/src/history/report.rs:136` ignores them.                                                                                                        |
| Claude tool-result files are not captured.                                                                           | `collector-sync/src/discovery.rs:114` accepts `.jsonl` only. On this Mac: 781 files, 184 MB, under `~/.claude/projects/<project>/<sessionId>/tool-results/`.                                                                                |
| Export requires 1 to 64 caller-supplied session IDs. There is no way to list the archive.                            | `packages/convex/archiveExport.ts:15,51`; `archive-erasure-state.ts:60` only lists registered ledgers during erasure.                                                                                                                       |
| Updates are manual. The installed app stayed on 0.1.45 while 0.1.49 was published.                                   | `apps/desktop/src-tauri/src/updater.rs:29` is only called from window and tray actions.                                                                                                                                                     |

Three older Codex files had receipts that did not match their current bytes, and one shares a vendor session ID with a different file. PR #540 added prefix-rewrite forking after those receipts were written. Treat them as regression fixtures, not as a known open bug.

## How the source files actually change

Verified 2026-09-22 against vendor docs, upstream issues, and this Mac. Every item below is either already handled by the current code or becomes a concrete line in PR 2 or PR 3.

Claude Code:

- The transcript `<session>.jsonl` is append-only. Rewind moves a head pointer by appending `last-prompt` records; compaction appends a new root. Abandoned branches stay in the file ([#24471](https://github.com/anthropics/claude-code/issues/24471), [#89646](https://github.com/anthropics/claude-code/issues/89646)). In-place rewrites do happen, but from third-party tools and users pruning oversized sessions ([#81793](https://github.com/anthropics/claude-code/issues/81793)). The prefix digest check at `source_capture.rs:49` covers that case.
- Claude sets aside a prior transcript as `<session>.orphaned-<timestamp>-<suffix>.jsonl` or `<session>.jsonl.superseded-<timestamp>` "instead of overwriting or deleting it" ([.claude directory docs](https://code.claude.com/docs/en/claude-directory)). Both carry the parent's `sessionId`. The `.superseded-` name fails the `.jsonl` filter at `discovery.rs:114` and is never discovered. The `.orphaned-` name passes the filter and receives the same initial part as the live transcript at `scan.rs:60`; production discovery then groups same-session, same-part files, compares their prefixes, and gives divergent contents distinct lineage parts while identical copies share one (`archive_history/mod.rs:308-340`, tested for three same-name files across agent homes at `archive_history/tests.rs:174`). Whether an orphaned copy comes out of that path correctly is untested: none exist on this Mac.
- Subagent transcripts live at `<session>/subagents/agent-<id>.jsonl`, carry the parent's `sessionId` plus an `agentId`, and are already keyed to their own part by `scan.rs:60-70`. 2,206 exist on this Mac. Tool-result files live at `<session>/tool-results/`; 781 on this Mac.
- The retention sweep hard-deletes the transcript, `subagents/`, `tool-results/`, and the set-aside copies once older than `cleanupPeriodDays`. Default 30 days, minimum 1, `0` is rejected. Deletion is `unlink()` with no trash ([docs](https://code.claude.com/docs/en/claude-directory)). Reported misbehavior: deleting sessions newer than 30 days ([#59248](https://github.com/anthropics/claude-code/issues/59248)) and a bulk sweep of roughly 950 transcripts after an update ([#85466](https://github.com/anthropics/claude-code/issues/85466)). 176 referenced tool-result files are missing on this Mac; the cause is unverified, and the sweep is one possible explanation. This Mac is set to 36500.

Codex:

- Rollouts are `sessions/YYYY/MM/DD/rollout-*.jsonl`. Archiving is a move to `archived_sessions/` with identical contents; there is no age-based deletion ([openai/codex discussion #3827](https://github.com/openai/codex/discussions/3827)). The collector already walks both directories (`sources.rs:87`). 2,163 archived rollouts on this Mac.
- Upstream Codex reads `rollout-*.jsonl.zst` and materializes a compressed rollout back to plain `.jsonl` before appending on resume ([openai/codex#25087](https://github.com/openai/codex/pull/25087), merged 2026-06-01). The compression worker is [#25089](https://github.com/openai/codex/pull/25089), merged the same day: disabled by default behind `local_thread_store_compression`, it "scans only `archived_sessions`, not active `sessions`", replaces the plain file with `.jsonl.zst`, and its author says not to treat it as production-ready. Third-party tools report a seven-day rule in later upstream commits ([deja-vu #3640](https://github.com/vshulcz/deja-vu/issues/3640), [orrerix #2601](https://github.com/willem445/orrerix/pull/2601)); that scope is not confirmed against a shipped release. This Mac runs 0.153.4 with zero `.zst` files. If it ships enabled, the `.jsonl` filter stops discovering compressed archived rollouts that were not captured before compression. Already-captured content is unaffected. Verify the actual behavior against the installed Codex version before relying on any of this.
- Every Codex file receives `codex:part:primary` initially (`scan.rs:71`), and the lineage comparison at `archive_history/mod.rs:308` separates divergent same-session files afterwards. The three observed discrepancies predate PR #540 and need to be replayed through that path.

Watcher:

- macOS FSEvents coalesces and drops events and then delivers `MustScanSubDirs`, which the `notify` crate surfaces as `Flag::Rescan` with an empty path list ([Apple FSEvents guide](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/UsingtheFSEventsFramework/UsingtheFSEventsFramework.html), [notify fsevent.rs](https://github.com/notify-rs/notify/blob/4a3f5a35d15dbed5611732016f90c785fdf0f0ac/src/fsevent.rs)). `archive_scheduler.rs:393` forwards only paths, so a rescan hint produces an empty change set. The 5-minute reconcile is the backstop, which is the right design; the hint should just trigger it sooner.

Prior art: Filebeat fingerprints the first 1024 bytes, Vector checksums the first N lines, and Fluent Bit uses inode plus a size-decrease check ([filestream](https://www.elastic.co/docs/reference/beats/filebeat/filebeat-input-filestream), [Vector file source](https://vector.dev/docs/reference/configuration/sources/file/), [Fluent Bit tail](https://docs.fluentbit.io/manual/data-pipeline/inputs/tail)). All three miss a same-size-or-larger rewrite with an unchanged head. The collector's full captured-prefix digest detects it. That mechanism stays.

## What stays as is

The encrypted spool, format-2 byte capture, generations, the Archive API upload contract, the per-session ledger, encrypted R2 objects, storage budget, key custody, and the verification code. None of the observed failures are in that layer. Do not add SQLite, a new object format, a queue policy subsystem, per-part eligibility metadata, capability negotiation, a LaunchAgent watchdog, or a desktop export UI as part of this repair.

## Implementation: five PRs, in order

### PR 1: Collector credentials never expire

This fixes the outage and removes the need for any credential migration flow.

- `packages/convex/schema.ts:445`: `expiresAt: v.optional(v.number())`. Absent means valid until revoked.
- `mcpCallback.ts:108` and `collectorLogin.ts:37-63`: stop computing and validating a TTL. `collectorCredentials.ts:85-100` (public `mint`): same.
- `packages/utils/src/collector-auth.ts:51,98`: accept a record without `expiresAt`; reject only when a number is present and past.
- `packages/convex/integrations/cloudflare.ts:203`: pass `expiresAt` through as absent. Any KV validator that requires a number is updated in the same PR.
- Rust: `collector-embedder/src/connection.rs:39` `expires_at` becomes `Option<i64>`; `login.rs` parses an optional `expires_at`; `apps/desktop/src-tauri/src/commands.rs:100` reports expired only when present and past. Existing `connection.json` files with an old `expires_at` are read but ignored for status.
- Web: `apps/web/src/components/api-keys/ApiKeys.tsx` shows "until revoked" when absent.
- Migration: one internal mutation that clears `expiresAt` on every `active` credential row and schedules `syncCollectorCredToKV` for each. Run it once on dev, then on production with approval. The installed desktop resumes on its next policy refresh with the same secret, collector ID, and enrollment. No browser flow, no keychain change, no new collector.
- `rg expiresAt` across `packages/convex`, `packages/utils`, `apps/archive-api`, `apps/web`, and the Rust crates is the completeness check for this PR. Only export grants and body-access tokens keep an expiry.

Done: production returns 200 to the currently installed collector, uploads advance, and a fresh login mints a credential with no expiry.

### PR 2: Delete the duplicate archive path; the scheduler owns policy

- Delete `ArchiveRunConfig` from `RunConfig` and `archive` from `SyncRunOutcome` in `collector-embedder/src/sync.rs:109-150`, and the archive branch of `run_detailed`. Delete `run_archive_cycle` and `capture_archive_snapshots` from `cycle.rs`; port `tests/archive_sync.rs` and `examples/archive_capture_fixture.rs` to `capture_archive_local` plus `prepare_archive_upload` / `send_archive_upload` / `apply_archive_upload`, which is what production calls.
- Move `refresh_archive_policy` and `archive_policy_denial` handling from `engine.rs:877-930` into `archive_scheduler.rs`. The scheduler refreshes policy at the start of each reconcile (startup, wake, manual sync, and the existing 5-minute tick). `engine.rs` no longer references `archive_policy`. Port the six archive tests in `engine.rs` to the scheduler.
- Do not change part identity. Add fixtures through the production discovery path (`prepare_configured` in `archive_history`): one Claude `.orphaned-*.jsonl` beside its live transcript with divergent content, one identical orphaned copy, and the three sanitized Codex discrepancies. Divergent files must land in distinct parts and identical copies must share one, exactly as `archive_history/tests.rs:174` already requires across agent homes. Only if a fixture fails does identity code change, and then the multi-home test must still pass.
- `discovery.rs:114` accepts `*.jsonl.superseded-*` and `rollout-*.jsonl.zst` in addition to `.jsonl`. A superseded file then flows through the same lineage comparison as an orphaned one; add it to the fixtures above.
- Compressed rollouts: every stage that reads transcript bytes must see decoded bytes. Discovery reads the raw file for the session ID and the identity prefix (`archive_history/identity.rs:37`), copy comparison opens both files raw (`copies.rs:7`), and `capture` at `source_capture.rs:87` takes a seekable reader with a known length. So decode once, before identity detection: stream the `.zst` with the `zstd` crate into a file in the spool's scratch directory, never holding the expanded transcript in memory, and feed that file to identify, prefix comparison, and capture. Identity stays with the original rollout: provenance and the remembered source identity use the plain path with `.zst` stripped, so a rollout that goes plain, compressed, plain keeps one provenance and one part. The scratch filename is never an identity. Delete the scratch file on success, error, and cancellation. Prefer the plain sibling when both exist, matching Codex's own reader. Never checkpoint compressed bytes as transcript bytes.
- `archive_scheduler.rs:393`: when `event.need_rescan()` is set, call `wake.reconcile()` instead of forwarding an empty path list.
- `report.rs:136`: `Complete` requires zero discovery errors for that source. Otherwise report `InProgress` and surface the error count in the existing status. Capture backlog and capture failures are the signal that data is at risk from vendor cleanup; the desktop does not read or police `cleanupPeriodDays`.

Done: `rg 'ArchiveRunConfig|archive_policy' apps/desktop/src-tauri/src/engine.rs` is empty. `run_detailed` has no archive parameter. The Rust workspace passes, including the new fixtures.

### PR 3: Capture Claude tool-result files

- `discovery.rs:114`: for the Claude root, also accept regular files under `<sessionId>/tool-results/` where `<sessionId>.jsonl` exists as a sibling. Nothing else under `~/.claude/projects` (3,111 `.wakatime` and 2,337 `.json` files there are not conversation data).
- Each file is a part of that session. The part ID uses the existing derivation with `tool-results/<name>` as the identity. Add a `relative_path` field to the upload request and the manifest element. The server stores it and echoes it in the receipt; the client compares it before retiring the pending request. Export writes the file at `<session>/<relative_path>` after rejecting absolute paths and `..`.
- These parts have no JSONL records. Verify `parseAndValidateUpload` in `apps/archive-api` accepts a byte-only part; if it requires record counts, relaxing that for parts with a `relative_path` is the one server change.
- Rollout order: server merges to main first (CI deploys), then the desktop release. No capability handshake.
- Tool-result files go through the same capture path as transcripts, so an overwritten file forks a new generation exactly as a rewritten transcript does (`source_capture.rs:49,181`). Deleting the file never deletes the archived generation.
- Referenced files that no longer exist are not recoverable and are not searched for. Export restores what was captured; the transcript still names the missing path.

Done: a Cloud-Dev export of a session with tool-result files restores them byte-for-byte under the session directory.

### PR 4: Whole-archive listing and export

- `apps/archive-api/src/archive-erasure-state.ts:60`: add a listing that does not require erasure to have started. Expose `GET /v1/archive/sessions?cursor=` for organization-scoped export grants, returning ledger ID plus committed scope (source, session ID, contribution, generation, manifest key).
- `packages/convex/archiveExport.ts`: accept `scope: 'organization'` in addition to explicit targets. Organization grants get a 24-hour TTL. Reason: a 22 GB export does not finish in 10 minutes, and grant renewal is more code than a longer owner-only, single-export-ID token.
- `scripts/dev/archive-export.ts`: when the grant is organization-scoped, enumerate from the listing instead of a supplied selection. Resume and verification stay as they are. This script is the export consumer for this repair.
- Registry backfill: `registerLedger` landed 2026-09-09 (#507); the Archive API accepted uploads from 2026-09-04 (#454). A one-off operator script lists `ArchiveSessionLedger` objects through the Cloudflare Durable Objects namespace API and registers any committed ledger missing from the registry. Run once per environment.

Done: on a machine with no collector state, the script exports every session in the organization and every part verifies.

### PR 5: Automatic updates

- `apps/desktop/src-tauri/src/lib.rs` setup: call `updater::install_latest` shortly after startup and every 24 hours while running. Keep the manual action. Failed checks log and retry next interval; they never stop archival.
- Nothing special before `app.restart()`: every upload is durable in the spool until acknowledged, and an in-flight upload whose response is lost is retried idempotently by the existing code.

Done: a machine on the previous release updates itself within a day and the log shows the new version resuming capture.

## Proof

Source files change under the collector in the ways listed under "How the source files actually change". The collector handles rewrites with generations: when the captured prefix of a file no longer matches by length and digest, `source_capture.rs:181` forks a new part and the earlier generation stays in the spool and the archive. That code landed in #540 on 2026-09-15 and has never run in production; the installed 0.1.45 predates it and every production receipt is format 1. The proof below is where it gets exercised for real, so the comparison must be generation-aware, not a static diff.

The Rust test suite must cover each source behavior with a real temporary directory and the production capture entry point: append; in-place rewrite of an already-captured prefix at the same size; truncation; delete and recreate with the same name; a Claude `.orphaned-` and `.superseded-` set-aside next to the live transcript; a subagent file; a Codex rollout moved to `archived_sessions/`; a Codex rollout compressed to `.jsonl.zst` and then materialized back to plain with an appended line; and an FSEvents rescan hint. Each must produce the expected parts and generations: divergent files in distinct parts, identical copies sharing one, and no captured generation lost. For the compression sequence the assertions are explicit, matching the existing fork rules at `source_capture.rs:112` and `:172`: plain then compressed with identical decoded bytes captures nothing new and does not fork; compressed then materialized plain with an appended line continues the same part and captures only the appended bytes; a rewrite inside the already-captured prefix or a shorter file forks and preserves the earlier generation.

1. Before PR 3 ships to this Mac, record an inventory of every `.jsonl` and `tool-results` file under both source roots: relative path, size, SHA-256. Keep it out of Git. This is a floor, not the expected final state.
2. After PR 1 migration: the installed desktop uploads again without reconnecting.
3. After the desktop release: the `all_history` backfill drains to zero pending.
4. Run the PR 4 export from production into a fresh directory. Compare two ways. First, re-hash every file that still exists locally at export time and require its bytes to match the latest archived generation. Second, require every hash from the step 1 inventory to appear as some archived generation of that part. A file rewritten between the two steps therefore shows as two generations, never as a mismatch. Files deleted locally must still export from their last generation. The three Codex cases restore as distinct parts.
5. Leave the desktop running for a day through sleep, wake, and a network drop. Pending returns to zero after each. This is a manual check, not new code.
6. Confirm the production R2 bucket has no age-based lifecycle rule on archive objects, and that the wrapped organization key can be recovered from the key backup, not only from the live secret.

## Done

- Collector credentials do not expire. The installed collector recovered without a reconnect.
- One archive execution path exists. The composed test path and the engine's policy code are deleted.
- Every documented Claude and Codex file behavior (set-aside copies, subagents, archive moves, zstd compression, rescan hints) has a passing test against the production discovery and capture path, with the existing multi-home lineage test still green.
- Tool-result files are captured, uploaded, and restored alongside their transcript.
- The whole organization archive can be listed and exported from a clean machine. Every current local file matches its latest archived generation, and every inventoried hash exists as an archived generation.
- The desktop updates itself.

Not in this repair: a desktop export UI, LaunchAgent crash restart, upload priority tuning between live and backfill work, analytics changes, Cursor archival. Each is a separate decision once the above is proven in production.
