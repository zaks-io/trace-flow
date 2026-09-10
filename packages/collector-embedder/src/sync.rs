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

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use collector_api_client::{CollectorApiClient, CollectorApiClientConfig};
use collector_archive_sync::{
    finish_terminal_cleanup, run_archive_cycle, ArchiveAuthorizedSource, ArchiveClient,
    ArchiveClientConfig, ArchiveCycleReport, ArchiveEnrollmentRecord, ArchiveHistoryPlan,
    ArchiveSnapshot, OsKeyStore,
};

pub use collector_archive_sync::{
    cleanup_obligation_exists, ArchiveKeyStore, ArchivePolicy, ArchiveSpool, MemoryKeyStore,
};
use collector_contracts::AgentSource;
use collector_sync::{
    assemble_cursor_units, run_sync_cycle, BatchMeta, CursorStore, GitRemoteCache, HistoryPreset,
    ImportWindow, Orchestrator, SyncUnit, Trigger,
};

use crate::archive_history::prepare as prepare_archive_history;
use crate::connection::Paths;
use crate::fact_sources::FactSources;
use crate::sources::{cursor_db_path, ingestable_sources, source_roots};

/// The version strings the ingest worker's compatibility policy gates on. The CLI is the collector
/// "desktop" embedder; the parser version tracks the `collector-parser` crate.
pub const DESKTOP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PARSER_VERSION: &str = "0.2.0";

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
    pub authorized_sources: Vec<ArchiveAuthorizedSource>,
}

/// The inputs a sync run needs that don't come from saved state: where the ingest worker is and the
/// raw Collector Credential. Both are runtime-resolved (env / keychain), never persisted here.
pub struct RunConfig<'a> {
    pub ingest_url: String,
    pub credential: String,
    pub org_id: &'a str,
    pub home: &'a Path,
    pub window: Window,
    /// Explicitly resend Claude and Codex facts in the selected history window without deleting
    /// local cursors. Cursor replay requires a full composer-selection path and is not claimed here.
    pub replay: bool,
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
    let spool_dir = paths.archive_spool_dir(org_id);
    let cleanup_required = cleanup_obligation_exists(&spool_dir);
    let enrollment = match ArchiveEnrollmentRecord::load_record(&enrollment_path) {
        Ok(enrollment) => enrollment,
        Err(_) if cleanup_required => ArchiveEnrollmentRecord::from_policy(ArchivePolicy::Revoked),
        Err(err) => {
            return Err(err).context("load archive enrollment");
        }
    };
    archive_run_config_from_enrollment(
        enrollment_path,
        spool_dir,
        archive_url,
        key_store,
        enrollment,
        cleanup_required,
    )
}

fn archive_run_config_from_enrollment(
    enrollment_path: PathBuf,
    spool_dir: PathBuf,
    archive_url: String,
    key_store: Arc<dyn ArchiveKeyStore>,
    enrollment: ArchiveEnrollmentRecord,
    cleanup_required: bool,
) -> Result<Option<ArchiveRunConfig>> {
    let policy = enrollment.policy().context("load archive enrollment")?;
    if cleanup_required {
        return Ok(Some(ArchiveRunConfig {
            archive_url,
            spool_dir,
            enrollment_path,
            key_store,
            policy: ArchivePolicy::Revoked,
            authorized_sources: Vec::new(),
        }));
    }
    if policy == ArchivePolicy::Inactive {
        return Ok(None);
    }
    Ok(Some(ArchiveRunConfig {
        archive_url,
        spool_dir,
        enrollment_path,
        key_store,
        policy,
        authorized_sources: enrollment.authorized_sources,
    }))
}

pub fn prepare_confirmed_archive(
    paths: &Paths,
    org_id: &str,
    archive_url: String,
    key_store: Arc<dyn ArchiveKeyStore>,
    enrollment: ArchiveEnrollmentRecord,
) -> (Option<ArchiveRunConfig>, Option<String>) {
    let spool_dir = paths.archive_spool_dir(org_id);
    let result = archive_run_config_from_enrollment(
        paths.archive_enrollment_file(org_id),
        spool_dir.clone(),
        archive_url,
        key_store,
        enrollment,
        cleanup_obligation_exists(&spool_dir),
    );
    match result {
        Ok(config) => (config, None),
        Err(err) => (None, Some(err.to_string())),
    }
}

pub fn prepare_desktop_confirmed_archive(
    paths: &Paths,
    org_id: &str,
    enrollment: ArchiveEnrollmentRecord,
) -> (Option<ArchiveRunConfig>, Option<String>) {
    prepare_confirmed_archive(
        paths,
        org_id,
        crate::defaults::archive_url(),
        Arc::new(OsKeyStore),
        enrollment,
    )
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

/// Isolate optional Archive setup for the serialized Desktop/CLI cycle.
///
/// Unreadable enrollment without a cleanup marker stays fail-loud in `load_error` so diagnostics
/// remain, but `config` is `None` so parsed-fact sync still runs. Marker-driven cleanup still
/// returns `Some(Revoked)` from the loader.
pub fn prepare_serialized_archive(
    paths: &Paths,
    org_id: &str,
    archive_url: String,
    key_store: Arc<dyn ArchiveKeyStore>,
) -> (Option<ArchiveRunConfig>, Option<String>) {
    match load_archive_run_config(paths, org_id, archive_url, key_store) {
        Ok(config) => (config, None),
        Err(err) => (None, Some(err.to_string())),
    }
}

/// Desktop production isolate: same as [`prepare_serialized_archive`] with the OS key store.
pub fn prepare_desktop_serialized_archive(
    paths: &Paths,
    org_id: &str,
) -> (Option<ArchiveRunConfig>, Option<String>) {
    match load_desktop_archive_run_config(paths, org_id) {
        Ok(config) => (config, None),
        Err(err) => (None, Some(err.to_string())),
    }
}

/// Run a sync pass over every ingestable Source, returning one report per Source attempted.
///
/// Errors only on setup failures (bad client config, broken cursor DB). A per-envelope or cycle-fatal
/// ingest failure is captured in the [`SourceReport`], not returned as `Err`, so a bad credential on
/// Claude still lets the caller render a useful summary.
pub async fn run(cfg: RunConfig<'_>) -> Result<Vec<(AgentSource, SourceReport)>> {
    Ok(run_detailed(cfg).await?.reports)
}

/// Same cycle as [`run`], with fact discovery/read counters and archive progress.
pub async fn run_detailed(cfg: RunConfig<'_>) -> Result<SyncRunOutcome> {
    let client = CollectorApiClient::new(CollectorApiClientConfig::new(
        cfg.ingest_url.clone(),
        cfg.credential.clone(),
    ))
    .context("build ingest client")?;

    let paths = resolve_paths(&cfg)?;
    let mut store =
        CursorStore::open(paths.cursor_db(cfg.org_id), cfg.org_id).context("open cursor store")?;
    store.set_active_parser_version(PARSER_VERSION);
    let reparse_known = store.parser_version()?.as_deref() != Some(PARSER_VERSION);
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

    let history = if let Some(archive_cfg) = &cfg.archive {
        if archive_cfg.policy.captures() {
            match open_spool_for_policy(archive_cfg, cfg.org_id) {
                Ok(Some(spool)) => prepare_archive_history(
                    cfg.home,
                    &spool,
                    &archive_cfg.authorized_sources,
                    cfg.now_ms,
                ),
                Ok(None) => Default::default(),
                Err(class) => {
                    let mut history = crate::archive_history::PreparedArchiveHistory::default();
                    history.errors.push(class.to_string());
                    history.plan = ArchiveHistoryPlan::default().with_failed_sources(
                        archive_cfg
                            .authorized_sources
                            .iter()
                            .map(|authorization| authorization.source)
                            .collect(),
                    );
                    history
                }
            }
        } else {
            Default::default()
        }
    } else {
        Default::default()
    };
    let mut archive = if let Some(archive_cfg) = &cfg.archive {
        let mut report = run_archive_work(
            archive_cfg,
            cfg.org_id,
            &cfg.credential,
            &history.snapshots,
            &history.plan,
        )
        .await;
        for class in &history.errors {
            report.failed += 1;
            if report.first_error.is_none() {
                report.first_error = Some(class.clone());
            }
        }
        Some(report)
    } else {
        None
    };

    let mut discovery_passes = 0usize;
    let mut files_read = 0usize;
    let mut reports = Vec::new();
    for source in ingestable_sources() {
        let mut report = SourceReport::default();
        let roots = source_roots(cfg.home, source);
        store.set_replay_facts(replay_facts_for_source(cfg.replay, source));
        if roots.is_empty() {
            let units = assemble_cursor_source_units(&store, &cfg, window, &mut report)?;
            if !units.is_empty() {
                apply_fact_cycle(&client, &store, source, &units, &mut mint, &mut report).await?;
            }
        } else {
            discovery_passes += 1;
            let mut files = FactSources::discover(
                &roots,
                source,
                &store,
                window,
                cfg.replay,
                reparse_known,
                &mut report,
            )
            .context("select changed files")?;
            while let Some(units) = files.next_batch(&cache, &mut report, &mut files_read).await {
                if !units.is_empty() {
                    apply_fact_cycle(&client, &store, source, &units, &mut mint, &mut report)
                        .await?;
                }
                if report.aborted_early {
                    break;
                }
            }
        }
        reports.push((source, report));
    }

    apply_archive_policy_after_cycle(cfg.archive.as_ref(), cfg.org_id, archive.as_mut(), &reports);

    let complete = reports
        .iter()
        .all(|(_, report)| report.failed == 0 && !report.aborted_early);
    if complete {
        store.mark_parser_version(PARSER_VERSION)?;
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

fn replay_facts_for_source(replay: bool, source: AgentSource) -> bool {
    replay && matches!(source, AgentSource::Claude | AgentSource::Codex)
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
        matches!(
            ingest_denial_reason(&report.first_error),
            Some("credential_revoked" | "enrollment_invalid" | "deleting" | "revoked")
        )
    });
    let archive_halted = archive.as_ref().is_some_and(|report| report.halted);
    if archive_purged || fact_revoked || archive_halted {
        match finish_terminal_cleanup(
            &archive_cfg.spool_dir,
            org_id,
            archive_cfg.key_store.as_ref(),
            Some(&archive_cfg.enrollment_path),
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
        return;
    }
    if archive.as_ref().is_some_and(|report| report.frozen) {
        if let Ok(mut record) = ArchiveEnrollmentRecord::load_record(&archive_cfg.enrollment_path) {
            record.status = ArchivePolicy::Frozen.as_str().to_string();
            let _ = record.save_record(&archive_cfg.enrollment_path);
        }
    }
}

#[cfg(test)]
fn is_unauthorized(first_error: &Option<String>) -> bool {
    ingest_denial_reason(first_error).is_some()
}

async fn run_archive_work(
    archive: &ArchiveRunConfig,
    org_id: &str,
    credential: &str,
    snapshots: &[ArchiveSnapshot],
    plan: &ArchiveHistoryPlan,
) -> ArchiveCycleReport {
    if archive.policy.purges() || cleanup_obligation_exists(&archive.spool_dir) {
        let mut report = ArchiveCycleReport::default();
        match finish_terminal_cleanup(
            &archive.spool_dir,
            org_id,
            archive.key_store.as_ref(),
            Some(&archive.enrollment_path),
        ) {
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
    spool.set_enrollment_path(archive.enrollment_path.clone());

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
        plan,
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
    use collector_archive::{default_transcript_part_id, ArchiveSource};
    use collector_archive_sync::{
        cleanup_obligation_exists, ArchiveEnrollmentRecord, ArchiveHistoryChoice, ArchiveKeyStore,
        ArchiveSpool, ArchiveSpoolKey, ArchiveSyncError, ArchiveSyncResult, PendingArchiveRequest,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const CLAUDE: &[u8] = include_bytes!("../../collector-archive/tests/fixtures/claude.jsonl");
    const CODEX: &[u8] = include_bytes!("../../collector-archive/tests/fixtures/codex.jsonl");

    fn authorization(source: ArchiveSource) -> ArchiveAuthorizedSource {
        ArchiveAuthorizedSource {
            source,
            history_choice: ArchiveHistoryChoice::AllHistory,
            authorized_at: 1_770_000_000_001,
        }
    }

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
    fn explicit_replay_is_scoped_to_jsonl_sources() {
        assert!(replay_facts_for_source(true, AgentSource::Claude));
        assert!(replay_facts_for_source(true, AgentSource::Codex));
        assert!(!replay_facts_for_source(true, AgentSource::Cursor));
        assert!(!replay_facts_for_source(false, AgentSource::Claude));
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
            replay: false,
            now_ms: 1_779_840_000_000,
            batch_id_prefix: "test",
            archive,
            state_dir: Some(state),
        })
        .await
        .unwrap()
    }

    fn last_complete_sync_at_ms(state: &Path) -> Option<i64> {
        let path = Paths::at(state.to_path_buf()).cursor_db("org_1");
        CursorStore::open(path, "org_1")
            .unwrap()
            .last_complete_sync_at_ms()
            .unwrap()
    }

    fn cursor_store(state: &Path) -> CursorStore {
        CursorStore::open(Paths::at(state.to_path_buf()).cursor_db("org_1"), "org_1").unwrap()
    }

    async fn run_fact_sync(
        home: &Path,
        state: &Path,
        ingest_url: String,
        replay: bool,
        now_ms: i64,
    ) -> SyncRunOutcome {
        run_detailed(RunConfig {
            ingest_url,
            credential: "tfc_secret".to_string(),
            org_id: "org_1",
            home,
            window: Window::Incremental,
            replay,
            now_ms,
            batch_id_prefix: "test",
            archive: None,
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
                authorized_sources: vec![
                    authorization(ArchiveSource::Claude),
                    authorization(ArchiveSource::Codex),
                ],
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
    async fn archived_codex_transcripts_are_ingested_by_the_normal_fact_cycle() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        let archived = home.path().join(".codex").join("archived_sessions");
        std::fs::create_dir_all(&archived).unwrap();
        let transcript = archived.join("codex-session-001.jsonl");
        std::fs::write(&transcript, CODEX).unwrap();
        let hits = Arc::new(Mutex::new(0u32));
        let ingest_url = spawn_http({
            let hits = Arc::clone(&hits);
            move |_raw| {
                *hits.lock().unwrap() += 1;
                raw_response(
                    202,
                    "Accepted",
                    r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
                )
            }
        })
        .await;

        let outcome = run_fact_sync(
            home.path(),
            state.path(),
            ingest_url,
            false,
            1_779_840_000_000,
        )
        .await;
        let codex = outcome
            .reports
            .iter()
            .find(|(source, _)| *source == AgentSource::Codex)
            .unwrap();
        assert_eq!(codex.1.source_files_scanned, 1);
        assert_eq!(codex.1.selected, 1);
        assert_eq!(codex.1.advanced, 1);
        assert_eq!(*hits.lock().unwrap(), 1);
        assert!(cursor_store(state.path())
            .get(AgentSource::Codex, transcript.to_str().unwrap())
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn trailing_blank_lines_complete_then_a_real_append_uploads() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        let codex_dir = home.path().join(".codex/sessions");
        std::fs::create_dir_all(&codex_dir).unwrap();
        let transcript = codex_dir.join("blank-tail.jsonl");
        let mut bytes = br#"{"type":"session_meta","payload":{"id":"codex-blank","timestamp":"2020-01-01T00:00:00Z"}}
{"type":"event_msg","payload":{"id":"one"}}
"#
        .to_vec();
        bytes.extend_from_slice(b"\n \t\x0c\r\n");
        std::fs::write(&transcript, &bytes).unwrap();

        let ingest_url = spawn_http(|_raw| {
            raw_response(
                202,
                "Accepted",
                r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
            )
        })
        .await;
        let archive_hits = Arc::new(Mutex::new(0u32));
        let archive_url = spawn_http({
            let archive_hits = Arc::clone(&archive_hits);
            move |raw| {
                *archive_hits.lock().unwrap() += 1;
                archive_ack(&request_body(&raw))
            }
        })
        .await;
        let keys = Arc::new(MemoryKeyStore::new());
        let spool_dir = state.path().join("archive-spool-org_1");

        let first = run_with_servers(
            home.path(),
            state.path(),
            ingest_url.clone(),
            Some(ArchiveRunConfig {
                archive_url: archive_url.clone(),
                spool_dir: spool_dir.clone(),
                enrollment_path: state.path().join("archive-enrollment-org_1.json"),
                key_store: keys.clone(),
                policy: ArchivePolicy::Enrolled,
                authorized_sources: vec![authorization(ArchiveSource::Codex)],
            }),
        )
        .await;
        let history = first
            .archive
            .as_ref()
            .unwrap()
            .history
            .iter()
            .find(|history| history.source == ArchiveSource::Codex)
            .unwrap();
        assert_eq!(
            history.initial_import,
            collector_archive_sync::ArchiveInitialImport::Complete
        );

        bytes.extend_from_slice(b"{\"type\":\"event_msg\",\"payload\":{\"id\":\"two\"}}\n");
        std::fs::write(&transcript, bytes).unwrap();
        let second = run_with_servers(
            home.path(),
            state.path(),
            ingest_url,
            Some(ArchiveRunConfig {
                archive_url,
                spool_dir,
                enrollment_path: state.path().join("archive-enrollment-org_1.json"),
                key_store: keys,
                policy: ArchivePolicy::Enrolled,
                authorized_sources: vec![authorization(ArchiveSource::Codex)],
            }),
        )
        .await;

        assert_eq!(*archive_hits.lock().unwrap(), 2);
        assert_eq!(second.archive.as_ref().unwrap().uploaded, 1);
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
                authorized_sources: vec![
                    authorization(ArchiveSource::Claude),
                    authorization(ArchiveSource::Codex),
                ],
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
        assert_eq!(
            last_complete_sync_at_ms(state.path()),
            Some(1_779_840_000_000)
        );
    }

    #[tokio::test]
    async fn fact_failure_does_not_advance_the_complete_sync_watermark() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        write_home_transcripts(home.path());
        let ingest_url =
            spawn_http(|_raw| raw_response(500, "Error", r#"{"error":"ingest_failed"}"#)).await;

        let outcome = run_with_servers(home.path(), state.path(), ingest_url, None).await;

        assert!(outcome.reports.iter().any(|(_, report)| report.failed > 0));
        assert_eq!(last_complete_sync_at_ms(state.path()), None);
    }

    #[tokio::test]
    async fn parser_migration_reparses_known_old_transcripts_without_importing_unknown_ones() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        let claude_dir = home.path().join(".claude/projects/p1");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(claude_dir.join("known.jsonl"), CLAUDE).unwrap();
        let hits = Arc::new(Mutex::new(0u32));
        let ingest_url = spawn_http({
            let hits = Arc::clone(&hits);
            move |_raw| {
                *hits.lock().unwrap() += 1;
                raw_response(
                    202,
                    "Accepted",
                    r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
                )
            }
        })
        .await;
        run_fact_sync(
            home.path(),
            state.path(),
            ingest_url.clone(),
            false,
            1_779_840_000_000,
        )
        .await;
        std::fs::write(claude_dir.join("unknown.jsonl"), CLAUDE).unwrap();
        let mut old_store = cursor_store(state.path());
        old_store.set_active_parser_version("0.1.0");
        for cursor in old_store.list(AgentSource::Claude).unwrap() {
            old_store.advance(AgentSource::Claude, &cursor).unwrap();
        }
        old_store.mark_parser_version("0.1.0").unwrap();

        let migrated = run_fact_sync(
            home.path(),
            state.path(),
            ingest_url,
            false,
            9_000_000_000_000,
        )
        .await;
        let claude = migrated
            .reports
            .iter()
            .find(|(source, _)| *source == AgentSource::Claude)
            .unwrap()
            .1
            .clone();
        assert_eq!(claude.source_files_scanned, 2);
        assert_eq!(claude.selected, 1);
        assert_eq!(migrated.files_read, 1);
        assert_eq!(claude.advanced, 1);
        assert_eq!(*hits.lock().unwrap(), 2);
        assert_eq!(
            cursor_store(state.path())
                .parser_version()
                .unwrap()
                .as_deref(),
            Some(PARSER_VERSION)
        );
    }

    #[tokio::test]
    async fn failed_parser_migration_keeps_the_old_version_for_retry() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        let claude_dir = home.path().join(".claude/projects/p1");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(claude_dir.join("known.jsonl"), CLAUDE).unwrap();
        let accepted = spawn_http(|_raw| {
            raw_response(
                202,
                "Accepted",
                r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
            )
        })
        .await;
        run_fact_sync(
            home.path(),
            state.path(),
            accepted,
            false,
            1_779_840_000_000,
        )
        .await;
        let mut old_store = cursor_store(state.path());
        old_store.set_active_parser_version("0.1.0");
        for cursor in old_store.list(AgentSource::Claude).unwrap() {
            old_store.advance(AgentSource::Claude, &cursor).unwrap();
        }
        old_store.mark_parser_version("0.1.0").unwrap();
        let rejected =
            spawn_http(|_raw| raw_response(500, "Error", r#"{"error":"ingest_failed"}"#)).await;

        let outcome = run_fact_sync(
            home.path(),
            state.path(),
            rejected,
            false,
            9_000_000_000_000,
        )
        .await;
        assert!(outcome.reports.iter().any(|(_, report)| report.failed > 0));
        assert_eq!(
            cursor_store(state.path())
                .parser_version()
                .unwrap()
                .as_deref(),
            Some("0.1.0")
        );
    }

    #[tokio::test]
    async fn replay_resends_accepted_facts_without_deleting_cursor_state() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        let claude_dir = home.path().join(".claude/projects/p1");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(claude_dir.join("session.jsonl"), CLAUDE).unwrap();
        let hits = Arc::new(Mutex::new(0u32));
        let ingest_url = spawn_http({
            let hits = Arc::clone(&hits);
            move |_raw| {
                *hits.lock().unwrap() += 1;
                raw_response(
                    202,
                    "Accepted",
                    r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
                )
            }
        })
        .await;
        run_fact_sync(
            home.path(),
            state.path(),
            ingest_url.clone(),
            false,
            1_779_840_000_000,
        )
        .await;
        let before = cursor_store(state.path())
            .list(AgentSource::Claude)
            .unwrap();

        let replayed = run_fact_sync(
            home.path(),
            state.path(),
            ingest_url,
            true,
            1_779_840_000_000,
        )
        .await;
        let after = cursor_store(state.path())
            .list(AgentSource::Claude)
            .unwrap();
        let claude = replayed
            .reports
            .iter()
            .find(|(source, _)| *source == AgentSource::Claude)
            .unwrap();
        assert_eq!(claude.1.advanced, 1);
        assert_eq!(*hits.lock().unwrap(), 2);
        assert_eq!(after, before);
    }

    #[test]
    fn after_cycle_freeze_preserves_source_authorization_metadata() {
        let state = tempfile::TempDir::new().unwrap();
        let enrollment_path = state.path().join("archive-enrollment-org_1.json");
        let original = ArchiveEnrollmentRecord {
            status: ArchivePolicy::Enrolled.as_str().to_string(),
            collector_id: None,
            authorized_sources: vec![authorization(ArchiveSource::Claude)],
            reason: None,
        };
        original.save_record(&enrollment_path).unwrap();
        let archive = ArchiveRunConfig {
            archive_url: "http://127.0.0.1:1".to_string(),
            spool_dir: state.path().join("archive-spool-org_1"),
            enrollment_path: enrollment_path.clone(),
            key_store: Arc::new(MemoryKeyStore::new()),
            policy: ArchivePolicy::Enrolled,
            authorized_sources: original.authorized_sources.clone(),
        };
        let mut report = ArchiveCycleReport {
            frozen: true,
            ..ArchiveCycleReport::default()
        };

        apply_archive_policy_after_cycle(Some(&archive), "org_1", Some(&mut report), &[]);

        let persisted = ArchiveEnrollmentRecord::load_record(&enrollment_path).unwrap();
        assert_eq!(persisted.policy().unwrap(), ArchivePolicy::Frozen);
        assert_eq!(persisted.authorized_sources, original.authorized_sources);
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
                authorized_sources: Vec::new(),
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
                authorized_sources: vec![authorization(ArchiveSource::Claude)],
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
                authorized_sources: vec![authorization(ArchiveSource::Claude)],
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
                authorized_sources: vec![authorization(ArchiveSource::Claude)],
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
                authorized_sources: vec![authorization(ArchiveSource::Claude)],
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

    struct ControllableDeleteKeyStore {
        inner: MemoryKeyStore,
        fail_delete: AtomicBool,
    }

    impl ControllableDeleteKeyStore {
        fn new() -> Self {
            Self {
                inner: MemoryKeyStore::new(),
                fail_delete: AtomicBool::new(true),
            }
        }

        fn allow_delete(&self) {
            self.fail_delete.store(false, Ordering::SeqCst);
        }
    }

    impl ArchiveKeyStore for ControllableDeleteKeyStore {
        fn load(&self, org_id: &str) -> ArchiveSyncResult<Option<ArchiveSpoolKey>> {
            self.inner.load(org_id)
        }

        fn store(&self, org_id: &str, key: &ArchiveSpoolKey) -> ArchiveSyncResult<()> {
            self.inner.store(org_id, key)
        }

        fn delete(&self, org_id: &str) -> ArchiveSyncResult<()> {
            if self.fail_delete.load(Ordering::SeqCst) {
                return Err(ArchiveSyncError::KeyUnavailable);
            }
            self.inner.delete(org_id)
        }
    }

    fn block_enrollment_replace(enrollment_path: &Path) {
        let tmp = enrollment_path.with_extension("tmp");
        if tmp.exists() {
            let _ = std::fs::remove_file(&tmp);
            let _ = std::fs::remove_dir_all(&tmp);
        }
        std::fs::create_dir(&tmp).unwrap();
    }

    #[tokio::test]
    async fn failed_enrollment_replace_keeps_marker_and_loader_blocks_later_capture() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        write_home_transcripts(home.path());
        let paths = Paths::at(state.path().to_path_buf());
        paths.ensure().unwrap();
        let enroll = paths.archive_enrollment_file("org_1");
        let spool_dir = paths.archive_spool_dir("org_1");
        ArchiveEnrollmentRecord {
            status: ArchivePolicy::Enrolled.as_str().to_string(),
            collector_id: None,
            authorized_sources: vec![authorization(ArchiveSource::Claude)],
            reason: None,
        }
        .save_record(&enroll)
        .unwrap();
        block_enrollment_replace(&enroll);

        let keys = Arc::new(ControllableDeleteKeyStore::new());
        let pending = test_pending(
            "claude-session-001",
            b"{\"source_session_id\":\"claude-session-001\"}",
        );
        {
            let spool = ArchiveSpool::open(&spool_dir, "org_1", keys.as_ref()).unwrap();
            spool.persist_pending(&pending).unwrap();
        }

        let archive_url =
            spawn_http(|_raw| raw_response(403, "Forbidden", r#"{"reason":"enrollment_invalid"}"#))
                .await;
        let ingest_url = spawn_http(|_raw| {
            raw_response(
                202,
                "Accepted",
                r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
            )
        })
        .await;

        let first_cfg = load_archive_run_config(&paths, "org_1", archive_url.clone(), keys.clone())
            .unwrap()
            .unwrap();
        assert_eq!(first_cfg.policy, ArchivePolicy::Enrolled);
        let first = run_with_servers(
            home.path(),
            state.path(),
            ingest_url.clone(),
            Some(first_cfg),
        )
        .await;
        assert!(first.archive.as_ref().unwrap().halted);
        assert!(!first.archive.as_ref().unwrap().purged);
        assert_eq!(first.archive.as_ref().unwrap().captured, 0);
        assert!(cleanup_obligation_exists(&spool_dir));
        assert!(keys.load("org_1").unwrap().is_some());
        assert_eq!(
            ArchiveEnrollmentRecord::load(&enroll).unwrap(),
            ArchivePolicy::Enrolled
        );

        keys.allow_delete();
        let archive_hits = Arc::new(Mutex::new(0u32));
        let unavailable = spawn_http({
            let archive_hits = Arc::clone(&archive_hits);
            move |_raw| {
                *archive_hits.lock().unwrap() += 1;
                raw_response(
                    503,
                    "Service Unavailable",
                    r#"{"reason":"archive unavailable"}"#,
                )
            }
        })
        .await;
        let recovered_cfg =
            load_archive_run_config(&paths, "org_1", unavailable.clone(), keys.clone())
                .unwrap()
                .expect("marker keeps Archive on the embedder cycle");
        assert_eq!(recovered_cfg.policy, ArchivePolicy::Revoked);
        let recovered = run_with_servers(
            home.path(),
            state.path(),
            ingest_url.clone(),
            Some(recovered_cfg),
        )
        .await;
        assert!(!recovered.archive.as_ref().unwrap().purged);
        assert_eq!(recovered.archive.as_ref().unwrap().captured, 0);
        assert_eq!(*archive_hits.lock().unwrap(), 0);
        assert!(cleanup_obligation_exists(&spool_dir));
        assert_eq!(
            ArchiveEnrollmentRecord::load(&enroll).unwrap(),
            ArchivePolicy::Enrolled
        );
        assert!(keys.load("org_1").unwrap().is_none());

        let later_cfg = load_archive_run_config(&paths, "org_1", unavailable, keys.clone())
            .unwrap()
            .expect("cleanup obligation still loads Archive work");
        assert_eq!(later_cfg.policy, ArchivePolicy::Revoked);
        let later = run_with_servers(home.path(), state.path(), ingest_url, Some(later_cfg)).await;
        assert_eq!(later.archive.as_ref().unwrap().captured, 0);
        assert!(keys.load("org_1").unwrap().is_none());
        assert!(cleanup_obligation_exists(&spool_dir));
        assert_eq!(
            ArchiveEnrollmentRecord::load(&enroll).unwrap(),
            ArchivePolicy::Enrolled
        );
    }

    #[test]
    fn unreadable_enrollment_with_marker_still_loads_cleanup() {
        let state = tempfile::TempDir::new().unwrap();
        let paths = Paths::at(state.path().to_path_buf());
        paths.ensure().unwrap();
        let enroll = paths.archive_enrollment_file("org_1");
        let spool_dir = paths.archive_spool_dir("org_1");
        let keys = Arc::new(MemoryKeyStore::new());
        let _ = ArchiveSpool::open(&spool_dir, "org_1", keys.as_ref()).unwrap();
        std::fs::write(&enroll, b"{not-json").unwrap();
        std::fs::write(ArchiveSpool::durable_cleanup_marker_path(&spool_dir), b"").unwrap();
        let cfg = load_archive_run_config(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            keys.clone(),
        )
        .unwrap()
        .expect("marker keeps cleanup on the loader");
        assert_eq!(cfg.policy, ArchivePolicy::Revoked);
        assert!(keys.load("org_1").unwrap().is_some());
    }

    #[test]
    fn unreadable_enrollment_without_marker_fails_loud() {
        let state = tempfile::TempDir::new().unwrap();
        let paths = Paths::at(state.path().to_path_buf());
        paths.ensure().unwrap();
        std::fs::write(paths.archive_enrollment_file("org_1"), b"{not-json").unwrap();
        let err = load_archive_run_config(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            Arc::new(MemoryKeyStore::new()),
        )
        .err()
        .expect("unreadable enrollment must not look inactive");
        assert!(err.to_string().contains("load archive enrollment"));
    }

    #[test]
    fn unknown_policy_status_fails_loud_and_explicit_inactive_stays_inactive() {
        let state = tempfile::TempDir::new().unwrap();
        let paths = Paths::at(state.path().to_path_buf());
        paths.ensure().unwrap();
        std::fs::write(
            paths.archive_enrollment_file("org_1"),
            br#"{"status":"enrolle"}"#,
        )
        .unwrap();
        let err = match load_archive_run_config(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            Arc::new(MemoryKeyStore::new()),
        ) {
            Err(err) => err,
            Ok(_) => panic!("truncated status must not look inactive"),
        };
        assert!(err.to_string().contains("load archive enrollment"));
        let (config, load_error) = prepare_serialized_archive(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            Arc::new(MemoryKeyStore::new()),
        );
        assert!(config.is_none());
        assert!(
            load_error
                .as_deref()
                .is_some_and(|err| err.contains("load archive enrollment")),
            "truncated policy must stay fail-loud: {load_error:?}"
        );
        std::fs::write(
            paths.archive_enrollment_file("org_1"),
            br#"{"status":"inactive"}"#,
        )
        .unwrap();
        assert!(load_archive_run_config(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            Arc::new(MemoryKeyStore::new()),
        )
        .unwrap()
        .is_none());
    }

    #[tokio::test]
    async fn unreadable_enrollment_without_marker_still_runs_fact_sync() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        write_home_transcripts(home.path());
        struct RestoreStateDir(Option<std::ffi::OsString>);
        impl Drop for RestoreStateDir {
            fn drop(&mut self) {
                match &self.0 {
                    Some(value) => std::env::set_var("TRACE_FLOW_STATE_DIR", value),
                    None => std::env::remove_var("TRACE_FLOW_STATE_DIR"),
                }
            }
        }
        let _restore = RestoreStateDir(std::env::var_os("TRACE_FLOW_STATE_DIR"));
        std::env::set_var("TRACE_FLOW_STATE_DIR", state.path());
        let paths = Paths::resolve().expect("TRACE_FLOW_STATE_DIR seam");
        paths.ensure().unwrap();
        std::fs::write(paths.archive_enrollment_file("org_1"), b"{not-json").unwrap();

        let fact_posts = Arc::new(Mutex::new(0u32));
        let ingest_url = spawn_http({
            let fact_posts = Arc::clone(&fact_posts);
            move |_raw| {
                *fact_posts.lock().unwrap() += 1;
                raw_response(
                    202,
                    "Accepted",
                    r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
                )
            }
        })
        .await;

        let (archive, load_error) = prepare_serialized_archive(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            Arc::new(MemoryKeyStore::new()),
        );
        assert!(archive.is_none());
        assert!(
            load_error
                .as_deref()
                .is_some_and(|err| err.contains("load archive enrollment")),
            "Archive diagnostics must stay fail-loud: {load_error:?}"
        );

        let outcome = run_with_servers(home.path(), state.path(), ingest_url, archive).await;
        let advanced: u32 = outcome
            .reports
            .iter()
            .map(|(_, report)| report.advanced)
            .sum();
        assert!(
            advanced >= 1,
            "optional Archive setup failure must not block fact sync"
        );
        assert!(*fact_posts.lock().unwrap() >= 1);
        assert!(outcome.archive.is_none());
    }
}
