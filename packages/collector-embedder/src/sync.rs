// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector CLI: the sync embedder over collector-sync.

//! The CLI's sync embedder.
//!
//! `collector-sync` is headless and embedder-agnostic: it exposes discovery (`walk_transcripts` +
//! `select_changed`), per-file assembly (`assemble_sync_unit_from_bytes`), and the drive loop
//! (`run_sync_cycle`) that POSTs each unit and advances its cursor only on a `2xx`. This module is
//! the CLI/desktop embedder that wires those together against a real [`CollectorApiClient`] and a
//! per-org SQLite [`CursorStore`].
//!
//! One pass per Source: walk the root once, narrow to in-window files, read each needed transcript
//! once, then feed the same bytes to Archive capture (Claude/Codex only) and parsed-fact assembly.
//! Cursor stays facts-only. Archive work is serialized in this same cycle — no second watcher,
//! timer, scheduler, or spawned archive task.
//!
//! The window is the 24h active-session grace for `sync`, measured back from the last complete pass
//! recorded in the cursor store (or from now on the very first pass), or a `HistoryPreset` for
//! `import`/`--since`. A pass that finishes with no failures records its start time as the new
//! watermark, so time the collector spent not running is rescanned, never skipped.
//! Batch ids are minted per POST from a process counter seeded by the wall clock so they are unique
//! within a run without needing `Date.now()` at the cursor seam.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use collector_api_client::{CollectorApiClient, CollectorApiClientConfig};
use collector_archive::ArchiveSource;
use collector_archive_sync::{
    archive_source_session_id, policy_from_denial_reason, run_archive_cycle, transcript_part_for,
    ArchiveClient, ArchiveClientConfig, ArchiveCycleReport, ArchiveEnrollmentRecord,
    ArchiveKeyStore, ArchiveSnapshot, ArchiveSpool, OsKeyStore,
};

pub use collector_archive_sync::{ArchivePolicy, MemoryKeyStore};
use collector_contracts::AgentSource;
use collector_sync::{
    assemble_cursor_units, assemble_sync_unit_from_bytes, run_sync_cycle, select_changed,
    walk_transcripts, BatchMeta, CursorStore, DiscoveredFile, GitRemoteCache, HistoryPreset,
    ImportWindow, Orchestrator, SyncUnit, Trigger,
};

use crate::connection::Paths;
use crate::sources::{cursor_db_path, ingestable_sources, source_root};

/// The version strings the ingest worker's compatibility policy gates on. The CLI is the collector
/// "desktop" embedder; the parser version tracks the `collector-parser` crate.
pub const DESKTOP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PARSER_VERSION: &str = "0.1.0";

/// How many transcripts to assemble (read + parse + git resolve) concurrently. Bounded so a large
/// history import overlaps I/O without opening every file at once; the git freeze cache dedups the
/// per-repo `git` shell-outs across them.
const ASSEMBLY_CONCURRENCY: usize = 16;

/// How far back a sync reaches.
#[derive(Debug, Clone, Copy)]
pub enum Window {
    /// The default scan: the 24h active-session grace before the last complete pass (or before now,
    /// when no pass has completed yet).
    Incremental,
    /// An explicit history backfill of one preset.
    History(HistoryPreset),
}

impl Window {
    fn import_window(self, now_ms: i64, last_complete_sync_at_ms: Option<i64>) -> ImportWindow {
        match self {
            Window::Incremental => match last_complete_sync_at_ms {
                Some(last) => ImportWindow::resume_incremental(last, now_ms),
                None => ImportWindow::first_incremental(now_ms),
            },
            Window::History(preset) => ImportWindow::history(preset, now_ms),
        }
    }
}

/// What one Source's pass did. Aggregated across Sources for the command's summary.
#[derive(Debug, Default, Clone)]
pub struct SourceReport {
    pub source_files_scanned: usize,
    pub selected: usize,
    pub advanced: u32,
    pub failed: u32,
    /// True when a cycle-fatal error (bad credential, too-old client, rate limit) stopped the pass.
    pub aborted_early: bool,
    /// The first ingest error class of the pass, surfaced so a failed sync says *why* (no secrets).
    pub first_error: Option<String>,
}

/// Archive inputs that stay off the fact `IngestClient` path.
pub struct ArchiveRunConfig {
    pub archive_url: String,
    pub spool_dir: PathBuf,
    pub enrollment_path: PathBuf,
    pub key_store: Arc<dyn ArchiveKeyStore>,
    pub policy: ArchivePolicy,
}

/// The inputs a sync run needs that don't come from saved state: where the ingest worker is and the
/// raw Collector Credential. Both are runtime-resolved (env / keychain), never persisted here.
pub struct RunConfig<'a> {
    pub ingest_url: String,
    pub credential: String,
    pub org_id: &'a str,
    pub home: &'a Path,
    pub window: Window,
    /// `now` in epoch ms, injected so the window math is testable and the cursor seam stays clock-free.
    pub now_ms: i64,
    /// A short embedder tag (e.g. `"cli"`, `"desktop"`) that prefixes the per-POST batch id, so a
    /// batch id reads as `cli-<n>` / `desktop-<n>` for audit. Not security-relevant.
    pub batch_id_prefix: &'a str,
    /// Present only when local Archive enrollment is not inactive. CLI leaves this `None`.
    pub archive: Option<ArchiveRunConfig>,
    /// Test seam for the state directory. Production embedders leave this `None` and use [`Paths`].
    pub state_dir: Option<&'a Path>,
}

/// Outcome of one serialized Desktop/CLI cycle, including Archive stats for tests.
#[derive(Debug, Clone)]
pub struct SyncRunOutcome {
    pub reports: Vec<(AgentSource, SourceReport)>,
    pub discovery_passes: usize,
    pub files_read: usize,
    pub archive: Option<ArchiveCycleReport>,
}

/// Load Archive run inputs from the non-secret enrollment file. Missing/inactive means no spool.
pub fn load_archive_run_config(
    paths: &Paths,
    org_id: &str,
    archive_url: String,
    key_store: Arc<dyn ArchiveKeyStore>,
) -> Result<Option<ArchiveRunConfig>> {
    let enrollment_path = paths.archive_enrollment_file(org_id);
    let policy =
        ArchiveEnrollmentRecord::load(&enrollment_path).context("load archive enrollment")?;
    if policy == ArchivePolicy::Inactive {
        return Ok(None);
    }
    Ok(Some(ArchiveRunConfig {
        archive_url,
        spool_dir: paths.archive_spool_dir(org_id),
        enrollment_path,
        key_store,
        policy,
    }))
}

/// Desktop production path: OS keyring spool key, baked/overridden Archive URL.
pub fn load_desktop_archive_run_config(
    paths: &Paths,
    org_id: &str,
) -> Result<Option<ArchiveRunConfig>> {
    load_archive_run_config(
        paths,
        org_id,
        crate::defaults::archive_url(),
        Arc::new(OsKeyStore),
    )
}

/// Run a sync pass over every ingestable Source, returning one report per Source attempted.
///
/// Errors only on setup failures (bad client config, broken cursor DB). A per-envelope or cycle-fatal
/// ingest failure is captured in the [`SourceReport`], not returned as `Err`, so a bad credential on
/// Claude still lets the caller render a useful summary.
pub async fn run(cfg: RunConfig<'_>) -> Result<Vec<(AgentSource, SourceReport)>> {
    Ok(run_detailed(cfg).await?.reports)
}

/// Same cycle as [`run`], with discovery/read/archive counters for the single-traversal contract.
pub async fn run_detailed(cfg: RunConfig<'_>) -> Result<SyncRunOutcome> {
    let client = CollectorApiClient::new(CollectorApiClientConfig::new(
        cfg.ingest_url.clone(),
        cfg.credential.clone(),
    ))
    .context("build ingest client")?;

    let paths = resolve_paths(&cfg)?;
    let store =
        CursorStore::open(paths.cursor_db(cfg.org_id), cfg.org_id).context("open cursor store")?;
    store
        .repair_legacy_cursors_without_fact_state()
        .context("repair legacy cursor state")?;
    let needs_replay_backfill = store
        .needs_replay_backfill()
        .context("read replay backfill marker")?;
    let window = if needs_replay_backfill && matches!(cfg.window, Window::Incremental) {
        Window::History(HistoryPreset::Last7Days)
    } else {
        cfg.window
    };
    let last_complete_sync_at_ms = store
        .last_complete_sync_at_ms()
        .context("read last complete sync")?;
    let window = window.import_window(cfg.now_ms, last_complete_sync_at_ms);

    let cache = GitRemoteCache::new();
    let mut batch_seq: u64 = cfg.now_ms.max(0) as u64;
    let prefix = cfg.batch_id_prefix.to_string();
    let mut mint = move || {
        batch_seq = batch_seq.wrapping_add(1);
        format!("{prefix}-{batch_seq}")
    };

    let mut discovery_passes = 0usize;
    let mut files_read = 0usize;
    let mut archive_snapshots = Vec::new();
    let mut archive_discovery_errors = Vec::new();
    let mut prepared = Vec::new();

    for source in ingestable_sources() {
        let mut report = SourceReport::default();
        let units = match source_root(cfg.home, source) {
            Some(root) => {
                discovery_passes += 1;
                let pass = assemble_jsonl_pass(
                    &store,
                    &cache,
                    source,
                    &root,
                    window,
                    cfg.archive.as_ref(),
                    &mut report,
                )
                .await?;
                files_read += pass.files_read;
                archive_snapshots.extend(pass.snapshots);
                archive_discovery_errors.extend(pass.archive_discovery_errors);
                pass.units
            }
            None => assemble_cursor_source_units(&store, &cfg, window, &mut report)?,
        };
        prepared.push((source, report, units));
    }

    let mut archive = if let Some(archive_cfg) = &cfg.archive {
        let mut report =
            run_archive_work(archive_cfg, cfg.org_id, &cfg.credential, &archive_snapshots).await;
        for class in &archive_discovery_errors {
            report.failed += 1;
            if report.first_error.is_none() {
                report.first_error = Some(class.clone());
            }
        }
        Some(report)
    } else {
        None
    };

    let mut reports = Vec::new();
    for (source, mut report, units) in prepared {
        if !units.is_empty() {
            apply_fact_cycle(&client, &store, source, &units, &mut mint, &mut report).await?;
        }
        reports.push((source, report));
    }

    apply_archive_policy_after_cycle(cfg.archive.as_ref(), cfg.org_id, archive.as_mut(), &reports);

    let archive_incomplete = archive
        .as_ref()
        .is_some_and(|report| report.failed > 0 && !report.purged);
    let complete = reports
        .iter()
        .all(|(_, report)| report.failed == 0 && !report.aborted_early)
        && !archive_incomplete;
    if complete {
        // The pass started at `now_ms`; anything modified after that is caught by the next pass's
        // grace window. A pass with failures keeps the old watermark so the failed files stay in scope.
        store
            .mark_complete_sync(cfg.now_ms)
            .context("record complete sync")?;
    }
    if needs_replay_backfill && complete {
        store
            .mark_replay_backfill_complete()
            .context("mark replay backfill complete")?;
    }
    Ok(SyncRunOutcome {
        reports,
        discovery_passes,
        files_read,
        archive,
    })
}

fn resolve_paths(cfg: &RunConfig<'_>) -> Result<Paths> {
    let paths = match cfg.state_dir {
        Some(dir) => Paths::at(dir.to_path_buf()),
        None => Paths::resolve()?,
    };
    paths.ensure()?;
    Ok(paths)
}

async fn apply_fact_cycle(
    client: &CollectorApiClient,
    store: &CursorStore,
    source: AgentSource,
    units: &[SyncUnit],
    mint: &mut dyn FnMut() -> String,
    report: &mut SourceReport,
) -> Result<()> {
    let meta = BatchMeta {
        source,
        desktop_version: DESKTOP_VERSION.to_string(),
        parser_version: PARSER_VERSION.to_string(),
    };

    let mut orch = Orchestrator::new();
    orch.apply(Trigger::Resume);
    orch.apply(Trigger::SyncNow);

    let (cycle, _actions) = run_sync_cycle(client, store, &mut orch, &meta, units, mint, None)
        .await
        .context("run sync cycle")?;

    report.advanced += cycle.advanced;
    report.failed += cycle.failed;
    report.aborted_early = cycle.aborted_early;
    if let Some(err) = &cycle.first_error {
        // The IngestError Display is a stable error class (e.g. "unauthorized", "upgrade required"),
        // never the credential or transcript text — safe to surface.
        report.first_error = Some(err.to_string());
    }
    Ok(())
}

fn ingest_denial_reason(first_error: &Option<String>) -> Option<&str> {
    first_error.as_deref()?.strip_prefix("unauthorized: ")
}

fn apply_archive_policy_after_cycle(
    archive_cfg: Option<&ArchiveRunConfig>,
    org_id: &str,
    archive: Option<&mut ArchiveCycleReport>,
    reports: &[(AgentSource, SourceReport)],
) {
    let Some(archive_cfg) = archive_cfg else {
        return;
    };
    let archive_purged = archive.as_ref().is_some_and(|report| report.purged);
    // Terminal revocation from fact ingest always purges, including after Frozen/Grace
    // retention. Those states only retain for frozen/expired/grace denials, not for
    // credential_revoked / enrollment_invalid / deleting / revoked.
    let fact_revoked = reports.iter().any(|(_, report)| {
        ingest_denial_reason(&report.first_error).and_then(policy_from_denial_reason)
            == Some(ArchivePolicy::Revoked)
    });
    if archive_purged || fact_revoked {
        match ArchiveSpool::purge_at(
            &archive_cfg.spool_dir,
            org_id,
            archive_cfg.key_store.as_ref(),
        ) {
            Ok(()) => {
                if let Some(report) = archive {
                    report.purged = true;
                }
            }
            Err(err) => {
                if let Some(report) = archive {
                    report.purged = false;
                    report.failed += 1;
                    if report.first_error.is_none() {
                        report.first_error = Some(err.class().to_string());
                    }
                }
            }
        }
        let _ = ArchiveEnrollmentRecord::save(&archive_cfg.enrollment_path, ArchivePolicy::Revoked);
        return;
    }
    if archive.as_ref().is_some_and(|report| report.frozen) {
        let _ = ArchiveEnrollmentRecord::save(&archive_cfg.enrollment_path, ArchivePolicy::Frozen);
    }
}

#[cfg(test)]
fn is_unauthorized(first_error: &Option<String>) -> bool {
    ingest_denial_reason(first_error).is_some()
}

struct JsonlPass {
    units: Vec<SyncUnit>,
    snapshots: Vec<ArchiveSnapshot>,
    files_read: usize,
    archive_discovery_errors: Vec<String>,
}

/// Discover + assemble units for a JSONL source (Claude, Codex): one walk, one full read per needed
/// file, then Archive snapshots (when enrolled) and fact units from the same bytes.
async fn assemble_jsonl_pass(
    store: &CursorStore,
    cache: &GitRemoteCache,
    source: AgentSource,
    root: &Path,
    window: ImportWindow,
    archive: Option<&ArchiveRunConfig>,
    report: &mut SourceReport,
) -> Result<JsonlPass> {
    let files = walk_transcripts(root);
    report.source_files_scanned = files.len();

    let selected =
        select_changed(files.clone(), store, source, window).context("select changed files")?;
    report.selected = selected.len();

    let archive_files = archive_files_for_source(source, &files, window, archive);

    let mut needed: HashMap<String, DiscoveredFile> = HashMap::new();
    for file in selected.iter().chain(archive_files.iter()) {
        needed.insert(file.path.clone(), file.clone());
    }

    let mut bytes_by_path = HashMap::new();
    let mut files_read = 0usize;
    for path in needed.keys() {
        if let Ok(bytes) = std::fs::read(path) {
            bytes_by_path.insert(path.clone(), bytes);
            files_read += 1;
        }
    }

    let (snapshots, archive_discovery_errors) =
        archive_snapshots_from_bytes(source, &archive_files, &bytes_by_path);

    if selected.is_empty() {
        return Ok(JsonlPass {
            units: Vec::new(),
            snapshots,
            files_read,
            archive_discovery_errors,
        });
    }

    use futures_util::stream::{self, StreamExt};
    let assembled: Vec<_> = stream::iter(selected.iter())
        .map(|file| {
            let bytes = bytes_by_path.get(&file.path).cloned();
            async move {
                match bytes {
                    Some(bytes) => assemble_sync_unit_from_bytes(file, source, cache, &bytes).await,
                    None => Err(std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "unreadable transcript",
                    )),
                }
            }
        })
        .buffer_unordered(ASSEMBLY_CONCURRENCY)
        .collect()
        .await;
    let mut units = Vec::with_capacity(assembled.len());
    for result in assembled {
        match result {
            Ok(unit) => units.push(unit),
            // A file that fails to read is skipped this pass; its cursor never advanced, so it is
            // retried next pass. One unreadable transcript must not strand the whole Source, but it
            // does keep the pass incomplete (no watermark advance), so it must be visible: a stable
            // class, never the path or the transcript. An ingest error class, if one follows, wins.
            Err(_) => {
                report.failed += 1;
                report
                    .first_error
                    .get_or_insert_with(|| "unreadable transcript".to_string());
            }
        }
    }
    Ok(JsonlPass {
        units,
        snapshots,
        files_read,
        archive_discovery_errors,
    })
}

fn archive_files_for_source(
    source: AgentSource,
    files: &[DiscoveredFile],
    window: ImportWindow,
    archive: Option<&ArchiveRunConfig>,
) -> Vec<DiscoveredFile> {
    if !archive.is_some_and(|config| config.policy.captures()) {
        return Vec::new();
    }
    if ArchiveSource::try_from(source).is_err() {
        return Vec::new();
    }
    files
        .iter()
        .filter(|file| window.includes(file.mtime_ms))
        .cloned()
        .collect()
}

fn archive_snapshots_from_bytes(
    source: AgentSource,
    archive_files: &[DiscoveredFile],
    bytes_by_path: &HashMap<String, Vec<u8>>,
) -> (Vec<ArchiveSnapshot>, Vec<String>) {
    let Ok(archive_source) = ArchiveSource::try_from(source) else {
        return (Vec::new(), Vec::new());
    };
    let mut snapshots = Vec::new();
    let mut errors = Vec::new();
    for file in archive_files {
        let Some(bytes) = bytes_by_path.get(&file.path) else {
            errors.push("archive_io".to_string());
            continue;
        };
        match archive_source_session_id(archive_source, bytes) {
            Ok(source_session_id) => {
                match transcript_part_for(archive_source, Some(&file.path), bytes) {
                    Ok((source_transcript_part_id, transcript_part_identity)) => {
                        snapshots.push(ArchiveSnapshot {
                            source: archive_source,
                            source_session_id,
                            source_transcript_part_id,
                            transcript_part_identity,
                            bytes: bytes.clone(),
                            observed_at: file.mtime_ms as i64,
                        });
                    }
                    Err(_) => errors.push("invalid_archive_session".to_string()),
                }
            }
            Err(_) => errors.push("invalid_archive_session".to_string()),
        }
    }
    (snapshots, errors)
}

async fn run_archive_work(
    archive: &ArchiveRunConfig,
    org_id: &str,
    credential: &str,
    snapshots: &[ArchiveSnapshot],
) -> ArchiveCycleReport {
    if archive.policy.purges() {
        let mut report = ArchiveCycleReport::default();
        match ArchiveSpool::purge_at(&archive.spool_dir, org_id, archive.key_store.as_ref()) {
            Ok(()) => report.purged = true,
            Err(err) => {
                report.failed = 1;
                report.first_error = Some(err.class().to_string());
            }
        }
        return report;
    }

    let mut spool = match open_spool_for_policy(archive, org_id) {
        Ok(Some(spool)) => spool,
        Ok(None) => return ArchiveCycleReport::default(),
        Err(class) => {
            return ArchiveCycleReport {
                failed: 1,
                first_error: Some(class.to_string()),
                ..ArchiveCycleReport::default()
            };
        }
    };

    let uploader = match ArchiveClient::new(ArchiveClientConfig::new(
        archive.archive_url.clone(),
        credential.to_string(),
    )) {
        Ok(client) => client,
        Err(_) => {
            return ArchiveCycleReport {
                failed: 1,
                first_error: Some("archive_client".to_string()),
                ..ArchiveCycleReport::default()
            };
        }
    };

    run_archive_cycle(
        &uploader,
        &mut spool,
        archive.key_store.as_ref(),
        snapshots,
        archive.policy,
        None,
    )
    .await
}

fn open_spool_for_policy(
    archive: &ArchiveRunConfig,
    org_id: &str,
) -> Result<Option<ArchiveSpool>, &'static str> {
    if archive.policy.captures() {
        ArchiveSpool::open(&archive.spool_dir, org_id, archive.key_store.as_ref())
            .map(Some)
            .map_err(|err| err.class())
    } else {
        ArchiveSpool::open_existing(&archive.spool_dir, org_id, archive.key_store.as_ref())
            .map_err(|err| err.class())
    }
}

/// Discover + assemble units for the Cursor source: snapshot `state.vscdb` read-only and assemble each
/// changed composer. A missing DB (Cursor not installed, or a non-macOS host) is a clean no-op.
fn assemble_cursor_source_units(
    store: &CursorStore,
    cfg: &RunConfig<'_>,
    window: ImportWindow,
    report: &mut SourceReport,
) -> Result<Vec<SyncUnit>> {
    let Some(db) = cursor_db_path(cfg.home).filter(|p| p.exists()) else {
        return Ok(Vec::new());
    };
    let paths = resolve_paths(cfg)?;
    let units = assemble_cursor_units(&db, &paths.scratch_dir(), store, window)
        .context("assemble cursor units")?;
    // For the Cursor source, "files scanned" is the single state.vscdb; "selected" is the changed
    // composers the snapshot assembled.
    report.source_files_scanned = 1;
    report.selected = units.len();
    Ok(units)
}

/// Parse a `--since` value into a [`Window`]. Accepts the ADR presets only; an unknown value is a
/// hard error so a typo can't silently widen or narrow the import.
pub fn window_from_since(since: &str) -> Result<Window> {
    let w = match since {
        "24h" | "1d" => Window::Incremental,
        "7d" => Window::History(HistoryPreset::Last7Days),
        "30d" => Window::History(HistoryPreset::Last30Days),
        "1y" | "365d" => Window::History(HistoryPreset::LastYear),
        other => anyhow::bail!("unknown --since '{other}'; use one of: 24h, 7d, 30d, 1y"),
    };
    Ok(w)
}

#[cfg(test)]
mod tests {
    use super::*;
    use collector_archive::default_transcript_part_id;
    use collector_archive_sync::{
        ArchiveEnrollmentRecord, ArchiveKeyStore, ArchiveSpool, PendingArchiveRequest,
    };
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const CLAUDE: &[u8] = include_bytes!("../../collector-archive/tests/fixtures/claude.jsonl");
    const CODEX: &[u8] = include_bytes!("../../collector-archive/tests/fixtures/codex.jsonl");

    fn test_pending(session: &str, body: &[u8]) -> PendingArchiveRequest {
        PendingArchiveRequest {
            source: ArchiveSource::Claude,
            source_session_id: session.to_string(),
            source_transcript_part_id: default_transcript_part_id(ArchiveSource::Claude),
            expected_record_count: 1,
            expected_appended_records: 1,
            body: body.to_vec(),
        }
    }

    #[test]
    fn since_maps_to_the_adr_presets() {
        assert!(matches!(
            window_from_since("24h").unwrap(),
            Window::Incremental
        ));
        assert!(matches!(
            window_from_since("7d").unwrap(),
            Window::History(HistoryPreset::Last7Days)
        ));
        assert!(matches!(
            window_from_since("30d").unwrap(),
            Window::History(HistoryPreset::Last30Days)
        ));
        assert!(matches!(
            window_from_since("1y").unwrap(),
            Window::History(HistoryPreset::LastYear)
        ));
    }

    #[test]
    fn an_unknown_since_is_rejected() {
        assert!(window_from_since("2w").is_err());
        assert!(window_from_since("").is_err());
    }

    #[test]
    fn first_incremental_window_is_the_24h_grace_ending_now() {
        let now = 1_779_840_000_000;
        let w = Window::Incremental.import_window(now, None);
        assert_eq!(w.cutoff_ms(), now - 24 * 60 * 60 * 1000);
    }

    #[test]
    fn later_incremental_windows_resume_from_the_last_complete_sync() {
        let now = 1_779_840_000_000;
        let thirteen_days = 13 * 24 * 60 * 60 * 1000;
        let w = Window::Incremental.import_window(now, Some(now - thirteen_days));
        assert_eq!(w.cutoff_ms(), now - thirteen_days - 24 * 60 * 60 * 1000);
    }

    #[test]
    fn history_windows_ignore_the_watermark() {
        let now = 1_779_840_000_000;
        let w = Window::History(HistoryPreset::Last7Days).import_window(now, Some(now - 1));
        assert_eq!(w.cutoff_ms(), now - 7 * 24 * 60 * 60 * 1000);
    }

    #[test]
    fn inactive_enrollment_does_not_create_archive_config() {
        let dir = tempfile::TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        assert!(load_archive_run_config(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            Arc::new(MemoryKeyStore::new()),
        )
        .unwrap()
        .is_none());
    }

    fn write_home_transcripts(home: &Path) {
        let claude_dir = home.join(".claude").join("projects").join("p1");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(claude_dir.join("claude-session-001.jsonl"), CLAUDE).unwrap();
        let codex_dir = home.join(".codex").join("sessions").join("p1");
        std::fs::create_dir_all(&codex_dir).unwrap();
        std::fs::write(codex_dir.join("codex-session-001.jsonl"), CODEX).unwrap();
    }

    fn raw_response(status: u16, reason: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    async fn spawn_http(handler: impl Fn(Vec<u8>) -> String + Send + Sync + 'static) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            for _ in 0..16usize {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = stream.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if request_complete(&buf) || buf.len() > (1 << 20) {
                        break;
                    }
                }
                let response = handler(buf);
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        format!("http://{addr}")
    }

    fn archive_ack(body: &[u8]) -> String {
        let value: serde_json::Value =
            serde_json::from_slice(body).unwrap_or(serde_json::json!({}));
        let session = value
            .get("source_session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let count = value
            .get("checkpoint")
            .and_then(|c| c.get("record_count"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let source = if session.starts_with("codex") {
            "codex"
        } else {
            "claude"
        };
        raw_response(
            200,
            "OK",
            &format!(
                r#"{{"status":"acknowledged","source":"{source}","source_session_id":"{session}","record_count":{count}}}"#
            ),
        )
    }

    fn request_complete(buf: &[u8]) -> bool {
        let Some(header_end) = buf.windows(4).position(|window| window == b"\r\n\r\n") else {
            return false;
        };
        let headers = String::from_utf8_lossy(&buf[..header_end]);
        let content_length = headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        });
        match content_length {
            Some(length) => buf.len() >= header_end + 4 + length,
            None => true,
        }
    }

    fn request_body(raw: &[u8]) -> Vec<u8> {
        match raw.windows(4).position(|window| window == b"\r\n\r\n") {
            Some(header_end) => raw[header_end + 4..].to_vec(),
            None => raw.to_vec(),
        }
    }

    async fn run_with_servers(
        home: &Path,
        state: &Path,
        ingest_url: String,
        archive: Option<ArchiveRunConfig>,
    ) -> SyncRunOutcome {
        run_detailed(RunConfig {
            ingest_url,
            credential: "tfc_secret".to_string(),
            org_id: "org_1",
            home,
            window: Window::Incremental,
            now_ms: 1_779_840_000_000,
            batch_id_prefix: "test",
            archive,
            state_dir: Some(state),
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn one_traversal_feeds_archive_and_facts() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        write_home_transcripts(home.path());

        let ingest_hits = Arc::new(Mutex::new(0u32));
        let ingest_url = spawn_http({
            let ingest_hits = Arc::clone(&ingest_hits);
            move |_raw| {
                *ingest_hits.lock().unwrap() += 1;
                raw_response(
                    202,
                    "Accepted",
                    r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
                )
            }
        })
        .await;

        let archive_sources = Arc::new(Mutex::new(Vec::<String>::new()));
        let archive_url = spawn_http({
            let archive_sources = Arc::clone(&archive_sources);
            move |raw| {
                let request = String::from_utf8_lossy(&raw);
                if let Some(line) = request.lines().find(|line| {
                    line.to_lowercase()
                        .starts_with("x-trace-flow-archive-source:")
                }) {
                    archive_sources
                        .lock()
                        .unwrap()
                        .push(line.split(':').nth(1).unwrap_or("").trim().to_string());
                }
                archive_ack(&request_body(&raw))
            }
        })
        .await;

        let keys = Arc::new(MemoryKeyStore::new());
        let outcome = run_with_servers(
            home.path(),
            state.path(),
            ingest_url,
            Some(ArchiveRunConfig {
                archive_url,
                spool_dir: state.path().join("archive-spool-org_1"),
                enrollment_path: state.path().join("archive-enrollment-org_1.json"),
                key_store: keys,
                policy: ArchivePolicy::Enrolled,
            }),
        )
        .await;

        assert_eq!(outcome.discovery_passes, 2);
        assert_eq!(outcome.files_read, 2);
        assert_eq!(outcome.archive.as_ref().unwrap().uploaded, 2);
        assert!(*ingest_hits.lock().unwrap() >= 2);
        let sources = archive_sources.lock().unwrap().clone();
        assert!(sources.contains(&"claude".to_string()));
        assert!(sources.contains(&"codex".to_string()));
        assert!(!sources.iter().any(|source| source == "cursor"));
    }

    #[tokio::test]
    async fn archive_failure_does_not_block_fact_sync() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        write_home_transcripts(home.path());

        let ingest_url = spawn_http(|_raw| {
            raw_response(
                202,
                "Accepted",
                r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
            )
        })
        .await;
        let archive_url =
            spawn_http(|_raw| raw_response(400, "Bad Request", r#"{"error":"invalid_upload"}"#))
                .await;

        let outcome = run_with_servers(
            home.path(),
            state.path(),
            ingest_url,
            Some(ArchiveRunConfig {
                archive_url,
                spool_dir: state.path().join("archive-spool-org_1"),
                enrollment_path: state.path().join("archive-enrollment-org_1.json"),
                key_store: Arc::new(MemoryKeyStore::new()),
                policy: ArchivePolicy::Enrolled,
            }),
        )
        .await;

        let fact_advanced: u32 = outcome
            .reports
            .iter()
            .map(|(_, report)| report.advanced)
            .sum();
        assert!(fact_advanced >= 1);
        assert!(outcome.archive.as_ref().unwrap().failed >= 1);
        assert!(!outcome.archive.as_ref().unwrap().purged);
    }

    #[tokio::test]
    async fn cursor_is_not_an_archive_upload_source() {
        assert!(ArchiveSource::try_from(AgentSource::Cursor).is_err());
        let files = archive_files_for_source(
            AgentSource::Cursor,
            &[DiscoveredFile {
                path: "/tmp/cursor.jsonl".to_string(),
                mtime_ms: 1.0,
                size_bytes: 1,
            }],
            ImportWindow::first_incremental(2),
            Some(&ArchiveRunConfig {
                archive_url: "http://127.0.0.1:1".to_string(),
                spool_dir: PathBuf::from("/tmp/spool"),
                enrollment_path: PathBuf::from("/tmp/enroll.json"),
                key_store: Arc::new(MemoryKeyStore::new()),
                policy: ArchivePolicy::Enrolled,
            }),
        );
        assert!(files.is_empty());
    }

    #[tokio::test]
    async fn terminal_revocation_purges_archive_and_facts_continue() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        write_home_transcripts(home.path());
        let keys = Arc::new(MemoryKeyStore::new());
        let spool_dir = state.path().join("archive-spool-org_1");
        let pending = test_pending(
            "claude-session-001",
            b"{\"source_session_id\":\"claude-session-001\"}",
        );
        {
            let spool = ArchiveSpool::open(&spool_dir, "org_1", keys.as_ref()).unwrap();
            spool.persist_pending(&pending).unwrap();
        }
        assert!(keys.load("org_1").unwrap().is_some());

        let ingest_url = spawn_http(|_raw| {
            raw_response(
                202,
                "Accepted",
                r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
            )
        })
        .await;

        let outcome = run_with_servers(
            home.path(),
            state.path(),
            ingest_url,
            Some(ArchiveRunConfig {
                archive_url: "http://127.0.0.1:1".to_string(),
                spool_dir: spool_dir.clone(),
                enrollment_path: state.path().join("archive-enrollment-org_1.json"),
                key_store: keys.clone(),
                policy: ArchivePolicy::Revoked,
            }),
        )
        .await;

        assert!(outcome.archive.as_ref().unwrap().purged);
        assert!(keys.load("org_1").unwrap().is_none());
        assert!(!spool_dir.exists());
        let fact_advanced: u32 = outcome
            .reports
            .iter()
            .map(|(_, report)| report.advanced)
            .sum();
        assert!(fact_advanced >= 1);
    }

    #[tokio::test]
    async fn unauthorized_fact_ingest_purges_archive_state() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        write_home_transcripts(home.path());
        let keys = Arc::new(MemoryKeyStore::new());
        let spool_dir = state.path().join("archive-spool-org_1");
        let enrollment_path = state.path().join("archive-enrollment-org_1.json");
        let pending = test_pending(
            "claude-session-001",
            b"{\"source_session_id\":\"claude-session-001\"}",
        );
        {
            let spool = ArchiveSpool::open(&spool_dir, "org_1", keys.as_ref()).unwrap();
            spool.persist_pending(&pending).unwrap();
        }
        ArchiveEnrollmentRecord::save(&enrollment_path, ArchivePolicy::Enrolled).unwrap();

        let ingest_url = spawn_http(|_raw| {
            raw_response(401, "Unauthorized", r#"{"reason":"credential_revoked"}"#)
        })
        .await;

        let outcome = run_with_servers(
            home.path(),
            state.path(),
            ingest_url,
            Some(ArchiveRunConfig {
                archive_url: "http://127.0.0.1:1".to_string(),
                spool_dir: spool_dir.clone(),
                enrollment_path: enrollment_path.clone(),
                key_store: keys.clone(),
                policy: ArchivePolicy::Enrolled,
            }),
        )
        .await;

        assert!(outcome
            .reports
            .iter()
            .any(|(_, report)| is_unauthorized(&report.first_error)));
        assert!(keys.load("org_1").unwrap().is_none());
        assert!(!spool_dir.exists());
        assert_eq!(
            ArchiveEnrollmentRecord::load(&enrollment_path).unwrap(),
            ArchivePolicy::Revoked
        );
    }

    #[tokio::test]
    async fn frozen_enrollment_still_purges_on_fact_credential_revoked() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        write_home_transcripts(home.path());
        let keys = Arc::new(MemoryKeyStore::new());
        let spool_dir = state.path().join("archive-spool-org_1");
        let enrollment_path = state.path().join("archive-enrollment-org_1.json");
        let pending = test_pending(
            "claude-session-001",
            b"{\"source_session_id\":\"claude-session-001\"}",
        );
        {
            let spool = ArchiveSpool::open(&spool_dir, "org_1", keys.as_ref()).unwrap();
            spool.persist_pending(&pending).unwrap();
        }
        ArchiveEnrollmentRecord::save(&enrollment_path, ArchivePolicy::Frozen).unwrap();

        let ingest_url = spawn_http(|_raw| {
            raw_response(401, "Unauthorized", r#"{"reason":"credential_revoked"}"#)
        })
        .await;

        let outcome = run_with_servers(
            home.path(),
            state.path(),
            ingest_url,
            Some(ArchiveRunConfig {
                archive_url: "http://127.0.0.1:1".to_string(),
                spool_dir: spool_dir.clone(),
                enrollment_path: enrollment_path.clone(),
                key_store: keys.clone(),
                policy: ArchivePolicy::Frozen,
            }),
        )
        .await;

        assert!(outcome
            .reports
            .iter()
            .any(|(_, report)| is_unauthorized(&report.first_error)));
        assert!(keys.load("org_1").unwrap().is_none());
        assert!(!spool_dir.exists());
        assert_eq!(
            ArchiveEnrollmentRecord::load(&enrollment_path).unwrap(),
            ArchivePolicy::Revoked
        );
    }

    #[tokio::test]
    async fn expired_fact_ingest_retains_grace_archive_state() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        write_home_transcripts(home.path());
        let keys = Arc::new(MemoryKeyStore::new());
        let spool_dir = state.path().join("archive-spool-org_1");
        let enrollment_path = state.path().join("archive-enrollment-org_1.json");
        let pending = test_pending(
            "claude-session-001",
            b"{\"source_session_id\":\"claude-session-001\"}",
        );
        {
            let spool = ArchiveSpool::open(&spool_dir, "org_1", keys.as_ref()).unwrap();
            spool.persist_pending(&pending).unwrap();
        }
        ArchiveEnrollmentRecord::save(&enrollment_path, ArchivePolicy::Grace).unwrap();

        let ingest_url =
            spawn_http(|_raw| raw_response(401, "Unauthorized", r#"{"reason":"expired"}"#)).await;

        let outcome = run_with_servers(
            home.path(),
            state.path(),
            ingest_url,
            Some(ArchiveRunConfig {
                archive_url: "http://127.0.0.1:1".to_string(),
                spool_dir: spool_dir.clone(),
                enrollment_path: enrollment_path.clone(),
                key_store: keys.clone(),
                policy: ArchivePolicy::Grace,
            }),
        )
        .await;

        assert!(outcome
            .reports
            .iter()
            .any(|(_, report)| is_unauthorized(&report.first_error)));
        assert!(keys.load("org_1").unwrap().is_some());
        assert!(spool_dir.exists());
        assert_eq!(
            ArchiveEnrollmentRecord::load(&enrollment_path).unwrap(),
            ArchivePolicy::Grace
        );
    }

    #[tokio::test]
    async fn grace_retains_pending_without_upload_and_facts_continue() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        write_home_transcripts(home.path());
        let keys = Arc::new(MemoryKeyStore::new());
        let spool_dir = state.path().join("archive-spool-org_1");
        let pending = test_pending(
            "claude-session-001",
            b"{\"source_session_id\":\"claude-session-001\"}",
        );
        {
            let spool = ArchiveSpool::open(&spool_dir, "org_1", keys.as_ref()).unwrap();
            spool.persist_pending(&pending).unwrap();
        }

        let archive_hits = Arc::new(Mutex::new(0u32));
        let archive_url = spawn_http({
            let archive_hits = Arc::clone(&archive_hits);
            move |_raw| {
                *archive_hits.lock().unwrap() += 1;
                raw_response(500, "Error", "{}")
            }
        })
        .await;
        let ingest_url = spawn_http(|_raw| {
            raw_response(
                202,
                "Accepted",
                r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
            )
        })
        .await;

        let outcome = run_with_servers(
            home.path(),
            state.path(),
            ingest_url,
            Some(ArchiveRunConfig {
                archive_url,
                spool_dir: spool_dir.clone(),
                enrollment_path: state.path().join("archive-enrollment-org_1.json"),
                key_store: keys.clone(),
                policy: ArchivePolicy::Grace,
            }),
        )
        .await;

        assert_eq!(*archive_hits.lock().unwrap(), 0);
        assert!(!outcome.archive.as_ref().unwrap().purged);
        let restored = ArchiveSpool::open_existing(&spool_dir, "org_1", keys.as_ref())
            .unwrap()
            .unwrap()
            .pending(ArchiveSource::Claude, "claude-session-001")
            .unwrap();
        assert!(restored.is_some());
        assert!(keys.load("org_1").unwrap().is_some());
        let fact_advanced: u32 = outcome
            .reports
            .iter()
            .map(|(_, report)| report.advanced)
            .sum();
        assert!(fact_advanced >= 1);
    }

    #[test]
    fn archive_unreadable_and_invalid_session_stay_off_fact_report() {
        let files = vec![
            DiscoveredFile {
                path: "/missing.jsonl".to_string(),
                mtime_ms: 1.0,
                size_bytes: 1,
            },
            DiscoveredFile {
                path: "/bad.jsonl".to_string(),
                mtime_ms: 1.0,
                size_bytes: 1,
            },
            DiscoveredFile {
                path: "/ok.jsonl".to_string(),
                mtime_ms: 1.0,
                size_bytes: 1,
            },
        ];
        let mut bytes = HashMap::new();
        bytes.insert("/bad.jsonl".to_string(), b"{\"uuid\":\"x\"}".to_vec());
        bytes.insert(
            "/ok.jsonl".to_string(),
            br#"{"sessionId":"claude-session-001","uuid":"r1"}"#.to_vec(),
        );
        let (snapshots, errors) = archive_snapshots_from_bytes(AgentSource::Claude, &files, &bytes);
        assert_eq!(snapshots.len(), 1);
        assert_eq!(errors.len(), 2);
        assert!(errors.contains(&"archive_io".to_string()));
        assert!(errors.contains(&"invalid_archive_session".to_string()));
    }
}
