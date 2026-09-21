# Archive release and recovery

New collectors require the Archive API byte-format reader first. Deploy server
support, verify cloud-dev upload/export, then release the desktop. Version 1
pending requests and immutable objects remain supported. Never deploy an older
Archive API reader after format 2 writes begin.

## Local migration and rollback

Stop the desktop before copying a spool. The new desktop copies encrypted legacy
files into a separate versioned root, syncs them to disk, and publishes the root
with an atomic rename. The original encrypted root is retained. The migration copies the OS keyring material into a separate
`<organization-id>:archive-v2` reference under `trace-flow-archive-spool`, verified
before publishing the new root. Legacy binaries still use the old organization
reference. Their cleanup cannot destroy the new root's key. Keep both references
recoverable while their encrypted roots remain.

An older desktop uses the legacy root. It cannot process data captured in the new
root. Keep a compatible reader installed to drain or inspect that data. Do not
replace the new root with its old backup. Do not manually delete either root to
clear a capacity warning. Explicit enrollment revocation retains its established
consent cleanup semantics.

## Cloud recovery

Retain organization key-custody records, all required wrapped key versions,
contribution metadata and the wrapping secret in separately recoverable backups.
An R2 copy without those keys is insufficient. Test with synthetic organizations;
never destroy a real organization's key to demonstrate recovery.

Keep export selections and verified receipts. They pin immutable manifest keys,
so a resumed export can identify the original archive even after the live ledger
advances. Format 2 manifests also contain their encrypted organization,
contribution and source scope for index reconstruction. Existing format 1
manifests still require the backed-up control-plane scope mapping.

After restoring custody, decrypt a pinned manifest, verify its content-addressed
key and scope, traverse every referenced page and chunk, verify the complete
chain, and reconstruct each byte-format part in contiguous offset order. Compare
its prefix digest with the last checkpoint. A missing key/object, gap, hash
mismatch or interrupted session means the export is incomplete. Never substitute
an empty file or skip that session.

Recovery of the live write ledger requires a separate verified rebuild. Export
recovery does not authorize resuming uploads against an empty ledger. Freeze
collection until the restored ledger agrees with the immutable manifests.

## Evidence required before production release

- The collector captures synthetic Claude and Codex bytes while offline, preserves
  earlier generations after rewrites and deletion, and restarts from its spool.
- Cloud-dev commits those requests and replays their receipts. After the fixture
  source and spool are removed, authenticated export reconstructs exact bytes.
- Crash, consent, capacity, malformed-tail, oversized-record and backpressure
  tests pass. Existing version 1 reader, key rotation and recovery tests pass.
- Record the commit, desktop build, Worker version, fixture hashes and test result
  together. Run the awake/sleep, network-loss and rewrite workload for 24 hours
  and measure capture/ACK lag separately from offline intervals.
- Verify wrapped-key backup restore and independently recovered wrapping-secret
  access. A test using the currently live key is not a backup-recovery drill.
- The owner approves the production release and completes the normal installation,
  enrollment, capture and export walkthrough.

On 2026-09-21, read-only Wrangler inspection of both
`trace-flow-agent-archive-dev` and `trace-flow-agent-archive-prod` in jurisdiction
`us` returned one enabled rule: abort incomplete multipart uploads after seven
days. Neither bucket had an object-expiration rule. Recheck at release and after
any infrastructure change. [R2 lifecycle documentation](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

## Capture configuration

Desktop persists `source_homes.claude_config_dirs` and `source_homes.codex_homes`
in its existing settings file. Startup merges standard homes and any observed
`CLAUDE_CONFIG_DIR` / `CODEX_HOME` into that list. A GUI process cannot discover
an environment variable that it never inherited; configure additional homes in
that settings list or launch once with the environment present. Capture watches
Claude `projects` and Codex `sessions` plus `archived_sessions` below those homes.
Consent still controls which source types and history are eligible.

## Verified export

The authenticated organization owner calls `archiveExport.issueGrant` with an
`exportId` and a bounded list of `{ contributionId, source, sourceSessionId }`
targets. Use an authenticated Convex client. Collector Credentials do not authorize
export. The returned grant expires after ten minutes; retain the same export ID
and target order when renewing a grant to resume.

Pass the grant as `TRACE_FLOW_ARCHIVE_EXPORT_GRANT` in the environment and run
`bun run dev:export:archive <archive-url> <output-directory>`. Do not place the grant
in a command argument, log, or checked-in file. Keep `archive-manifest.json` in
the output directory for resume. The client pins immutable roots, verifies
content and chain hashes, checks every byte checkpoint, and writes one exact
`.bin` file per captured generation. Its per-session manifest identifies part
lineage, byte lengths and SHA-256. Format 1 exports remain labelled non-byte-exact
because the original record archive did not retain all source separators.
For format 2, `observed_source_size` and `source_capture_complete` distinguish a
verified archive prefix from a fully captured source extent. Preserve and inspect
an incomplete prefix; the exporter cannot reconstruct bytes that were never captured.

## Implementation evidence

- Cloud-Dev Convex deployment: `hardy-iguana-812`.
- Cloud-Dev Archive API version: `dda8f64d-06d1-41b6-aaea-bf97f9dacaa7`.
- The hosted smoke passed source authorization, cross-organization rejection,
  key bootstrap, idempotent receipts, audit events, export, pinned resume, and
  exact Claude/Codex restore, including empty truncation generations, after
  synthetic source and spool deletion. It ran the actual export command twice
  into the same directory and verified cleanup of 36 tracked R2 objects.
- Local repository CI passed all 68 tasks. The Archive API suite passed 270 tests;
  the Convex suite passed 630 tests with one hosted integration test skipped.
- Raw capture regressions passed for rewrites, deletion/restart, independent
  collectors, oversized malformed bytes, and receipt rejection. The capacity
  regression proves other metadata cannot consume reserved receipt space.
- Embedder tests passed 104/104; desktop tests passed 44/44. These include
  changed-path capture, same-size rewrites, three divergent homes, capture during
  a stalled upload, remembered malformed-file identity, and rejection of a file
  replaced between discovery and capture. Workspace check and Clippy passed
  with warnings denied.
- PR review regressions cover pausing before upload, unexpected pending-directory
  entries without under-reserving receipt space, fresh source metadata, short
  identity reads, and stable lineage IDs when divergent homes appear or disappear.
  Archive export lint, isolated Bun type checking, and tests now run in the
  Archive API CI job. The development restore smoke passed again after these fixes.
- The final `cargo test --workspace --locked` passed 723 tests with one ignored.
  `cargo fmt --all -- --check`, workspace check, and workspace Clippy with
  `--all-targets --locked -- -D warnings` passed on the same implementation.
- These results describe the working tree on 2026-09-21. A production release
  must record its final commit and repeat the applicable checks after changes.

An earlier synthetic smoke run tracked chunks and roots but omitted immutable
manifest pages from cleanup. Its temporary selection and synthetic key custody
were already removed, so the remaining encrypted page keys cannot be identified
from its aggregate log. No broad deletion was attempted. The corrected smoke
tracks the full manifest graph and verified cleanup of all 36 tracked objects.
This concerns test objects in the development bucket, not production archives.

## Author QA

Reviewed working tree based on `4dbb153ba23fbec127de0ec6bf0ef5447927c616`.
Review evidence remains unchanged; implementation-author review is not an
independent PR approval. No commit, PR, or production deployment is represented
by these results.

| Requirement                                 | Evidence                                                                                         | Result     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------- |
| Exact bytes, prior generations, source loss | `tests/byte_capture.rs`; actual export command in Cloud-Dev smoke                                | Pass       |
| Durable capture and receipt promotion       | `tests/archive_sync.rs`; migration and spool fault tests                                         | Pass       |
| Consent survives scheduling changes         | Embedder new-only, replacement-race, revocation and retained-pending tests                       | Pass       |
| Capture proceeds during upload stalls       | Embedder stalled-uploader test; desktop wake/event regressions                                   | Pass       |
| Authenticated, resumable R2 restore         | Export grant tests; Cloud-Dev command run twice after source/spool removal                       | Pass       |
| Permanent retention configuration           | No object expiration in inspected dev/prod lifecycle; entitlement freezes have no grace deadline | Pass       |
| Independent key-backup recovery             | Requires recovery from separately stored keys and wrapping secret                                | Unverified |
| 24-hour installed workload                  | Requires awake/sleep, network-loss and rewrite run with measured lag                             | Unverified |
| Production installation and release         | Requires owner approval and installation/enrollment/export walkthrough                           | Unverified |

## Done

Release evidence covers the deployed commit and a restore after source loss.
Custody recovery and the unattended run have explicit results. Until those
checks pass, the implementation is awaiting release validation.
