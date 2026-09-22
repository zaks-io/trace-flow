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
//! Fact sync walks each Source once, narrows to in-window files, and reads each needed transcript
//! once for parsed-fact assembly. Cursor stays facts-only. Desktop Archive capture has a separate
//! filesystem watcher and local spool owner so a slow Archive upload cannot block durable capture.
//!
//! The window is the 24h active-session grace for `sync`, measured back from the last complete pass
//! recorded in the cursor store (or from now on the very first pass), or a `HistoryPreset` for
//! `import`/`--since`. A pass that finishes with no discovery, assembly, or ingest failures records
//! its start time as the new watermark, so time the collector spent not running is rescanned, never
//! skipped. A skipped filesystem error holds the prior watermark so unread files cannot age out.
//! Batch ids are minted per POST from a process counter seeded by the wall clock so they are unique
//! within a run without needing `Date.now()` at the cursor seam.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use collector_api_client::{CollectorApiClient, CollectorApiClientConfig};
use collector_archive_sync::{
    apply_archive_upload_response, capture_archive_snapshots, finish_terminal_cleanup,
    prepare_archive_spool, prepare_next_archive_upload_excluding, send_prepared_archive_upload,
    ArchiveAuthorizedSource, ArchiveClient, ArchiveClientConfig, ArchiveClientError,
    ArchiveCycleReport, ArchiveEnrollmentRecord, ArchiveHistoryGeneration, ArchiveHistoryPlan,
    ArchiveSyncError, ArchiveUploadResponse, OsKeyStore, PreparedArchiveUpload, UploadOutcome,
    ARCHIVE_HISTORY_STATE_VERSION,
};

pub use collector_archive_sync::{
    cleanup_obligation_exists, ArchiveForkEvent, ArchiveKeyStore, ArchivePolicy, ArchiveSpool,
    MemoryKeyStore,
};
use collector_contracts::AgentSource;
use collector_sync::{
    assemble_cursor_units, run_sync_cycle, BatchMeta, CursorStore, GitRemoteCache, HistoryPreset,
    ImportWindow, Orchestrator, SyncUnit, Trigger,
};

use crate::archive_history::{
    prepare_configured as prepare_archive_history,
    prepare_configured_incremental as prepare_archive_history_incremental,
};
use crate::connection::Paths;
use crate::fact_sources::FactSources;
use crate::sources::{cursor_db_path, ingestable_sources, SourceHomes};

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
    /// WalkDir or metadata errors skipped while scanning this Source. Count only — no paths.
    pub discovery_errors: u32,
    /// True when a cycle-fatal error (bad credential, too-old client, rate limit) stopped the pass.
    pub aborted_early: bool,
    /// The first ingest error class of the pass, surfaced so a failed sync says *why* (no secrets).
    pub first_error: Option<String>,
}

impl SourceReport {
    /// A pass is complete only when every configured scan and upload finished with no discovery,
    /// assembly, transport, or cycle-fatal failure.
    pub fn is_complete(&self) -> bool {
        self.failed == 0 && !self.aborted_early && self.discovery_errors == 0
    }
}

/// Archive inputs that stay off the fact `IngestClient` path.
#[derive(Clone)]
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
    /// Resolved transcript homes. Desktop persists this list because GUI launches may not inherit
    /// the shell environment that selected a non-default agent home.
    pub source_homes: Option<&'a SourceHomes>,
    pub window: Window,
    /// Explicitly resend facts in the selected history window without deleting local cursors.
    pub replay: bool,
    /// `now` in epoch ms, injected so the window math is testable and the cursor seam stays clock-free.
    pub now_ms: i64,
    /// A short embedder tag (e.g. `"cli"`, `"desktop"`) that prefixes the per-POST batch id, so a
    /// batch id reads as `cli-<n>` / `desktop-<n>` for audit. Not security-relevant.
    pub batch_id_prefix: &'a str,
    /// Present only when local Archive enrollment is not inactive. CLI leaves this `None`.
    /// Test seam for the state directory. Production embedders leave this `None` and use [`Paths`].
    pub state_dir: Option<&'a Path>,
}

/// Outcome of one serialized Desktop/CLI cycle, including Archive stats for tests.
#[derive(Debug, Clone)]
pub struct SyncRunOutcome {
    pub reports: Vec<(AgentSource, SourceReport)>,
    pub discovery_passes: usize,
    pub files_read: usize,
}

/// Load Archive run inputs from the non-secret enrollment file. Missing/inactive means no spool.
pub fn load_archive_run_config(
    paths: &Paths,
    org_id: &str,
    archive_url: String,
    key_store: Arc<dyn ArchiveKeyStore>,
) -> Result<Option<ArchiveRunConfig>> {
    let enrollment_path = paths.archive_enrollment_file(org_id);
    let cleanup_required = archive_cleanup_required(paths, org_id);
    let enrollment = match ArchiveEnrollmentRecord::load_record(&enrollment_path) {
        Ok(enrollment) => enrollment,
        Err(_) if cleanup_required => ArchiveEnrollmentRecord::from_policy(ArchivePolicy::Revoked),
        Err(err) => {
            return Err(err).context("load archive enrollment");
        }
    };
    archive_run_config_from_enrollment(paths, org_id, archive_url, key_store, enrollment)
}

fn archive_run_config_from_enrollment(
    paths: &Paths,
    org_id: &str,
    archive_url: String,
    key_store: Arc<dyn ArchiveKeyStore>,
    enrollment: ArchiveEnrollmentRecord,
) -> Result<Option<ArchiveRunConfig>> {
    let spool_dir = paths.archive_spool_dir(org_id);
    let cleanup_required = archive_cleanup_required(paths, org_id);
    if cleanup_required {
        return Ok(Some(ArchiveRunConfig {
            archive_url,
            spool_dir,
            enrollment_path: paths.archive_enrollment_file(org_id),
            key_store,
            policy: ArchivePolicy::Revoked,
            authorized_sources: Vec::new(),
        }));
    }
    let policy = enrollment.policy().context("load archive enrollment")?;
    if policy == ArchivePolicy::Inactive {
        return Ok(None);
    }
    if !policy.purges() {
        prepare_archive_spool(
            &paths.legacy_archive_spool_dir(org_id),
            &spool_dir,
            org_id,
            key_store.as_ref(),
        )
        .context("prepare archive spool migration")?;
    }
    Ok(Some(ArchiveRunConfig {
        archive_url,
        spool_dir,
        enrollment_path: paths.archive_enrollment_file(org_id),
        key_store,
        policy,
        authorized_sources: enrollment.authorized_sources,
    }))
}

fn archive_cleanup_required(paths: &Paths, org_id: &str) -> bool {
    let active = paths.archive_spool_dir(org_id);
    cleanup_obligation_exists(&active)
        || cleanup_obligation_exists(&paths.legacy_archive_spool_dir(org_id))
        || migration_staging_dir(&active).is_some_and(|root| cleanup_obligation_exists(&root))
}

pub fn prepare_confirmed_archive(
    paths: &Paths,
    org_id: &str,
    archive_url: String,
    key_store: Arc<dyn ArchiveKeyStore>,
    enrollment: ArchiveEnrollmentRecord,
) -> (Option<ArchiveRunConfig>, Option<String>) {
    let result =
        archive_run_config_from_enrollment(paths, org_id, archive_url, key_store, enrollment);
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
    let resolved_source_homes;
    let source_homes = match cfg.source_homes {
        Some(homes) => homes,
        None => {
            resolved_source_homes = SourceHomes::standard(cfg.home);
            &resolved_source_homes
        }
    };
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

    let mut discovery_passes = 0usize;
    let mut files_read = 0usize;
    let mut reports = Vec::new();
    for source in ingestable_sources() {
        let mut report = SourceReport::default();
        let roots = source_homes.roots(source);
        store.set_replay_facts(cfg.replay);
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
        let aborted_early = report.aborted_early;
        reports.push((source, report));
        if aborted_early {
            break;
        }
    }

    let complete = reports.iter().all(|(_, report)| report.is_complete());
    if complete {
        store.mark_parser_version(PARSER_VERSION)?;
        // The pass started at `now_ms`; anything modified after that is caught by the next pass's
        // grace window. A pass with discovery, assembly, or ingest failures keeps the old watermark
        // so unread or failed files stay in the next incremental window.
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

#[cfg(test)]
fn ingest_denial_reason(first_error: &Option<String>) -> Option<&str> {
    first_error.as_deref()?.strip_prefix("unauthorized: ")
}

#[cfg(test)]
fn is_unauthorized(first_error: &Option<String>) -> bool {
    ingest_denial_reason(first_error).is_some()
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

/// Capture source bytes into the durable spool without constructing a client or waiting on HTTP.
pub fn capture_archive_local(
    archive: &ArchiveRunConfig,
    org_id: &str,
    source_homes: &SourceHomes,
    now_ms: i64,
) -> ArchiveCycleReport {
    capture_archive_local_inner(archive, org_id, source_homes, now_ms, None)
}

/// Capture file growth without rehashing every completed source. Startup, resume, and periodic
/// reconciliation use [`capture_archive_local`] to verify equal-length source contents.
pub fn capture_archive_local_incremental(
    archive: &ArchiveRunConfig,
    org_id: &str,
    source_homes: &SourceHomes,
    now_ms: i64,
    changed_paths: &HashSet<PathBuf>,
) -> ArchiveCycleReport {
    capture_archive_local_inner(archive, org_id, source_homes, now_ms, Some(changed_paths))
}

fn capture_archive_local_inner(
    archive: &ArchiveRunConfig,
    org_id: &str,
    source_homes: &SourceHomes,
    now_ms: i64,
    changed_paths: Option<&HashSet<PathBuf>>,
) -> ArchiveCycleReport {
    if archive.policy.purges()
        || cleanup_obligation_exists(&archive.spool_dir)
        || legacy_spool_dir(&archive.spool_dir)
            .as_ref()
            .is_some_and(|root| cleanup_obligation_exists(root))
    {
        return match finish_all_terminal_cleanup(archive, org_id) {
            Ok(()) => ArchiveCycleReport {
                purged: true,
                ..ArchiveCycleReport::default()
            },
            Err(error) => archive_error_report(error.class()),
        };
    }
    let mut spool = match open_spool_for_policy(archive, org_id) {
        Ok(Some(spool)) => spool,
        Ok(None) => return ArchiveCycleReport::default(),
        Err(class) => return archive_error_report(class),
    };
    spool.set_enrollment_path(archive.enrollment_path.clone());
    let history = match changed_paths {
        Some(paths) => prepare_archive_history_incremental(
            source_homes,
            &spool,
            &archive.authorized_sources,
            now_ms,
            paths,
        ),
        None => prepare_archive_history(source_homes, &spool, &archive.authorized_sources, now_ms),
    };
    let mut report = capture_archive_snapshots(
        &mut spool,
        archive.key_store.as_ref(),
        &history.snapshots,
        archive.policy,
        &history.plan,
        now_ms,
        None,
    );
    append_history_errors(&mut report, history.errors);
    report
}

/// Select one immutable persisted upload. Network code can own this value without holding the spool.
pub fn prepare_archive_upload(
    archive: &ArchiveRunConfig,
    org_id: &str,
    excluded: &HashSet<String>,
) -> Result<Option<PreparedArchiveUpload>, &'static str> {
    let Some(spool) = open_spool_for_policy(archive, org_id)? else {
        return Ok(None);
    };
    let plan = persisted_archive_plan(&spool, &archive.authorized_sources)?;
    prepare_next_archive_upload_excluding(&spool, &plan, archive.policy, excluded)
}

fn persisted_archive_plan(
    spool: &ArchiveSpool,
    authorizations: &[ArchiveAuthorizedSource],
) -> Result<ArchiveHistoryPlan, &'static str> {
    let mut states = Vec::with_capacity(authorizations.len());
    for authorization in authorizations {
        let state = spool
            .history_state(authorization.source)
            .map_err(|error| error.class())?
            .ok_or("archive_history_missing")?;
        let expected = ArchiveHistoryGeneration {
            source: authorization.source,
            history_choice: authorization.history_choice,
            authorized_at: authorization.authorized_at,
        };
        if state.version != ARCHIVE_HISTORY_STATE_VERSION || state.generation != expected {
            return Err("archive_history_generation_mismatch");
        }
        states.push(state);
    }
    Ok(ArchiveHistoryPlan::new(states))
}

/// Apply a completed request on the spool owner after rechecking its persisted identity.
pub fn apply_archive_upload(
    archive: &ArchiveRunConfig,
    org_id: &str,
    prepared: &PreparedArchiveUpload,
    response: ArchiveUploadResponse,
) -> Result<UploadOutcome, &'static str> {
    let Some(mut spool) = open_spool_for_policy(archive, org_id)? else {
        return Err("archive_state");
    };
    spool.set_enrollment_path(archive.enrollment_path.clone());
    let outcome =
        apply_archive_upload_response(&mut spool, archive.key_store.as_ref(), prepared, response)?;
    if outcome == UploadOutcome::Purged {
        finish_all_terminal_cleanup(archive, org_id).map_err(|error| error.class())?;
    }
    Ok(outcome)
}

pub async fn send_archive_upload(
    archive_url: String,
    credential: String,
    prepared: &PreparedArchiveUpload,
) -> ArchiveUploadResponse {
    let client = match ArchiveClient::new(ArchiveClientConfig::new(archive_url, credential)) {
        Ok(client) => client,
        Err(error) => return Err(ArchiveClientError::Transport(error)),
    };
    send_prepared_archive_upload(&client, prepared, None).await
}

fn append_history_errors(report: &mut ArchiveCycleReport, errors: Vec<String>) {
    for error in errors {
        report.failed += 1;
        if report.first_error.is_none() {
            report.first_error = Some(error);
        }
    }
}

fn archive_error_report(class: &'static str) -> ArchiveCycleReport {
    ArchiveCycleReport {
        failed: 1,
        first_error: Some(class.to_string()),
        ..ArchiveCycleReport::default()
    }
}

fn finish_all_terminal_cleanup(
    archive: &ArchiveRunConfig,
    org_id: &str,
) -> collector_archive_sync::ArchiveSyncResult<()> {
    let mut first_error = None;
    let mut roots = vec![archive.spool_dir.clone()];
    if let Some(legacy) = legacy_spool_dir(&archive.spool_dir) {
        roots.push(legacy);
    }
    if let Some(staging) = migration_staging_dir(&archive.spool_dir) {
        roots.push(staging);
    }
    for root in roots {
        if let Err(error) = finish_terminal_cleanup(
            &root,
            org_id,
            archive.key_store.as_ref(),
            Some(&archive.enrollment_path),
        ) {
            first_error.get_or_insert(error);
        }
    }
    for key_reference in [org_id.to_string(), format!("{org_id}:archive-v2")] {
        let removed = archive
            .key_store
            .delete(&key_reference)
            .and_then(|()| archive.key_store.load(&key_reference));
        match removed {
            Ok(None) => {}
            Ok(Some(_)) => {
                first_error.get_or_insert(ArchiveSyncError::KeyUnavailable);
            }
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn migration_staging_dir(active: &Path) -> Option<PathBuf> {
    let name = active.file_name()?.to_string_lossy();
    Some(active.parent()?.join(format!(".{name}.migration")))
}

fn legacy_spool_dir(active: &Path) -> Option<PathBuf> {
    let file_name = active.file_name()?.to_str()?;
    let suffix = file_name.strip_prefix("archive-spool-v2-")?;
    Some(active.with_file_name(format!("archive-spool-{suffix}")))
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
    let units = assemble_cursor_units(&db, &paths.scratch_dir(), store, window, cfg.replay)
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
        cleanup_obligation_exists, ArchiveAcknowledgement, ArchiveEnrollmentRecord,
        ArchiveHistoryChoice, ArchiveKeyStore, ArchiveSpool, ArchiveSpoolKey, ArchiveSyncError,
        ArchiveSyncResult, ArchiveUploader, PendingArchiveRequest,
    };
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::Notify;

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
            capture_authorization: None,
            predecessor_part_id: None,
            body: body.to_vec(),
        }
    }

    #[derive(Default)]
    struct NoAccessKeyStore {
        accesses: AtomicUsize,
    }

    impl NoAccessKeyStore {
        fn accesses(&self) -> usize {
            self.accesses.load(Ordering::SeqCst)
        }

        fn reject<T>(&self) -> ArchiveSyncResult<T> {
            self.accesses.fetch_add(1, Ordering::SeqCst);
            Err(ArchiveSyncError::KeyUnavailable)
        }
    }

    impl ArchiveKeyStore for NoAccessKeyStore {
        fn load(&self, _org_id: &str) -> ArchiveSyncResult<Option<ArchiveSpoolKey>> {
            self.reject()
        }

        fn store(&self, _org_id: &str, _key: &ArchiveSpoolKey) -> ArchiveSyncResult<()> {
            self.reject()
        }

        fn delete(&self, _org_id: &str) -> ArchiveSyncResult<()> {
            self.reject()
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

    #[test]
    fn inactive_and_invalid_enrollment_never_access_keys_or_prepare_a_spool() {
        let dir = tempfile::TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let keys = Arc::new(NoAccessKeyStore::default());

        assert!(load_archive_run_config(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            keys.clone(),
        )
        .unwrap()
        .is_none());
        assert_eq!(keys.accesses(), 0);
        assert!(!paths.archive_spool_dir("org_1").exists());

        std::fs::write(paths.archive_enrollment_file("org_1"), b"{not-json").unwrap();
        let error = match load_archive_run_config(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            keys.clone(),
        ) {
            Err(error) => error,
            Ok(_) => panic!("invalid enrollment must fail"),
        };
        assert!(error.to_string().contains("load archive enrollment"));
        assert_eq!(keys.accesses(), 0);
        assert!(!paths.archive_spool_dir("org_1").exists());

        let (config, error) = prepare_confirmed_archive(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            keys.clone(),
            ArchiveEnrollmentRecord::from_policy(ArchivePolicy::Inactive),
        );
        assert!(config.is_none());
        assert!(error.is_none());
        let (config, error) = prepare_confirmed_archive(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            keys.clone(),
            ArchiveEnrollmentRecord {
                status: "enrolle".to_string(),
                collector_id: None,
                authorized_sources: Vec::new(),
                reason: None,
            },
        );
        assert!(config.is_none());
        assert!(error
            .as_deref()
            .is_some_and(|error| error.contains("load archive enrollment")));
        assert_eq!(keys.accesses(), 0);
        assert!(!paths.archive_spool_dir("org_1").exists());
    }

    #[test]
    fn legacy_cleanup_obligation_bypasses_invalid_enrollment_without_migration() {
        let dir = tempfile::TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let keys = Arc::new(NoAccessKeyStore::default());
        let legacy = paths.legacy_archive_spool_dir("org_1");
        std::fs::write(
            ArchiveSpool::durable_cleanup_marker_path(&legacy),
            b"cleanup required",
        )
        .unwrap();
        std::fs::write(paths.archive_enrollment_file("org_1"), b"{not-json").unwrap();

        let config = load_archive_run_config(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            keys.clone(),
        )
        .unwrap()
        .expect("legacy cleanup must stay scheduled");

        assert_eq!(config.policy, ArchivePolicy::Revoked);
        assert_eq!(keys.accesses(), 0);
        assert!(!paths.archive_spool_dir("org_1").exists());
        assert!(cleanup_obligation_exists(&legacy));
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
            loop {
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
        let source = value
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| {
                if session.starts_with("codex") {
                    "codex"
                } else {
                    "claude"
                }
            });
        let part = value
            .get("checkpoint")
            .and_then(|checkpoint| checkpoint.get("source_transcript_part_id"))
            .and_then(|v| v.as_str());
        let captured_byte_offset = value
            .get("checkpoint")
            .and_then(|checkpoint| checkpoint.get("last_complete_byte_offset"))
            .and_then(|v| v.as_u64());
        let captured_prefix_sha256 = value
            .get("checkpoint")
            .and_then(|checkpoint| checkpoint.get("complete_prefix_sha256"))
            .and_then(|v| v.as_str());
        let appended_records = value
            .get("observations")
            .and_then(|v| v.as_array())
            .map_or(0, |observations| observations.len() as u64);
        let response = serde_json::json!({
            "status": "acknowledged",
            "source": source,
            "source_session_id": session,
            "source_transcript_part_id": part,
            "record_count": count,
            "appended_records": appended_records,
            "appended_checkpoint": true,
            "request_sha256": collector_archive::sha256(body).to_string(),
            "captured_byte_offset": captured_byte_offset,
            "captured_prefix_sha256": captured_prefix_sha256,
            "generation": 1,
            "chain_head": collector_archive::sha256(b"test archive chain").to_string(),
            "manifest_key": "test-manifest",
        });
        raw_response(200, "OK", &serde_json::to_string(&response).unwrap())
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

    struct TestRunOutcome {
        reports: Vec<(AgentSource, SourceReport)>,
        discovery_passes: usize,
        files_read: usize,
        archive: Option<ArchiveCycleReport>,
    }

    async fn run_with_servers(
        home: &Path,
        state: &Path,
        ingest_url: String,
        archive: Option<ArchiveRunConfig>,
    ) -> TestRunOutcome {
        let now_ms = 1_779_840_000_000;
        let mut archive_report = archive.as_ref().map(|config| {
            capture_archive_local(config, "org_1", &SourceHomes::standard(home), now_ms)
        });
        if let (Some(config), Some(report)) = (&archive, &mut archive_report) {
            if !report.purged && config.policy.uploads() {
                let mut attempted = HashSet::new();
                loop {
                    let prepared = match prepare_archive_upload(config, "org_1", &attempted) {
                        Ok(Some(prepared)) => prepared,
                        Ok(None) => break,
                        Err(class) => {
                            report.failed += 1;
                            report.first_error.get_or_insert(class.to_string());
                            break;
                        }
                    };
                    let response = send_archive_upload(
                        config.archive_url.clone(),
                        "tfc_secret".to_string(),
                        &prepared,
                    )
                    .await;
                    match apply_archive_upload(config, "org_1", &prepared, response) {
                        Ok(UploadOutcome::Advanced) => report.uploaded += 1,
                        Ok(UploadOutcome::Blocked) => {
                            report.blocked += 1;
                            attempted.insert(prepared.id());
                        }
                        Ok(UploadOutcome::Frozen) => {
                            report.frozen = true;
                            break;
                        }
                        Ok(UploadOutcome::Purged) => {
                            report.purged = true;
                            break;
                        }
                        Ok(UploadOutcome::Halt(class)) => {
                            report.halted = true;
                            report.failed += 1;
                            report.first_error.get_or_insert(class.to_string());
                            break;
                        }
                        Err(class) => {
                            report.failed += 1;
                            report.first_error.get_or_insert(class.to_string());
                            attempted.insert(prepared.id());
                        }
                    }
                }
            }
        }
        if let (Some(config), Some(report)) = (&archive, &mut archive_report) {
            if !report.purged && !report.halted && !report.frozen {
                report.history =
                    capture_archive_local(config, "org_1", &SourceHomes::standard(home), now_ms)
                        .history;
            }
        }
        let facts = run_detailed(RunConfig {
            ingest_url,
            credential: "tfc_secret".to_string(),
            org_id: "org_1",
            home,
            source_homes: None,
            window: Window::Incremental,
            replay: false,
            now_ms,
            batch_id_prefix: "test",
            state_dir: Some(state),
        })
        .await
        .unwrap();
        TestRunOutcome {
            reports: facts.reports,
            discovery_passes: facts.discovery_passes,
            files_read: facts.files_read,
            archive: archive_report,
        }
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
            source_homes: None,
            window: Window::Incremental,
            replay,
            now_ms,
            batch_id_prefix: "test",
            state_dir: Some(state),
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn independent_capture_and_fact_sync_both_ingest_sources() {
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
    async fn cycle_fatal_ingest_error_stops_before_later_sources() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        write_home_transcripts(home.path());
        let hits = Arc::new(Mutex::new(0u32));
        let ingest_url = spawn_http({
            let hits = Arc::clone(&hits);
            move |_raw| {
                *hits.lock().unwrap() += 1;
                raw_response(401, "Unauthorized", r#"{"reason":"credential_revoked"}"#)
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

        assert_eq!(*hits.lock().unwrap(), 1);
        assert_eq!(outcome.reports.len(), 1);
        assert_eq!(outcome.reports[0].0, AgentSource::Claude);
        assert!(outcome.reports[0].1.aborted_early);
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

    #[cfg(unix)]
    #[tokio::test]
    async fn unreadable_archive_subtree_is_not_reported_as_successful() {
        use std::os::unix::fs::PermissionsExt;

        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        write_home_transcripts(home.path());
        let locked = home.path().join(".codex").join("sessions").join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::write(locked.join("hidden.jsonl"), CODEX).unwrap();
        struct RestorePerms(std::path::PathBuf);
        impl Drop for RestorePerms {
            fn drop(&mut self) {
                let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
            }
        }
        let restore = RestorePerms(locked.clone());
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read_dir(&locked).is_ok() {
            let uid = std::process::Command::new("id")
                .arg("-u")
                .output()
                .ok()
                .and_then(|out| String::from_utf8(out.stdout).ok());
            if uid.as_deref().map(str::trim) == Some("0") {
                return;
            }
            panic!("chmod 000 did not deny listing on a non-root process");
        }

        let ingest_url = spawn_http(|_raw| {
            raw_response(
                202,
                "Accepted",
                r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
            )
        })
        .await;
        let archive_url = spawn_http(|raw| archive_ack(&request_body(&raw))).await;

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
        let _ = std::fs::set_permissions(&restore.0, std::fs::Permissions::from_mode(0o755));
        drop(restore);

        let archive = outcome.archive.as_ref().unwrap();
        assert!(archive.failed >= 1);
        assert_eq!(
            archive.first_error.as_deref(),
            Some(collector_sync::DISCOVERY_INCOMPLETE)
        );
        assert!(!archive.first_error.as_deref().unwrap_or("").contains('/'));
        let claude = outcome
            .reports
            .iter()
            .find(|(source, _)| *source == AgentSource::Claude)
            .map(|(_, report)| report)
            .unwrap();
        assert!(claude.is_complete());
        assert_eq!(claude.discovery_errors, 0);
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

    #[cfg(unix)]
    #[tokio::test]
    async fn discovery_errors_hold_the_watermark_so_later_passes_still_see_older_files() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{Duration, UNIX_EPOCH};

        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        let claude_dir = home.path().join(".claude/projects/p1");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(claude_dir.join("visible.jsonl"), CLAUDE).unwrap();

        let ingest_url = spawn_http(|_raw| {
            raw_response(
                202,
                "Accepted",
                r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
            )
        })
        .await;

        let t0 = 1_779_840_000_000;
        let first = run_fact_sync(home.path(), state.path(), ingest_url.clone(), false, t0).await;
        assert!(first.reports.iter().all(|(_, report)| report.is_complete()));
        assert_eq!(last_complete_sync_at_ms(state.path()), Some(t0));

        let locked = claude_dir.join("locked");
        std::fs::create_dir(&locked).unwrap();
        let hidden = locked.join("hidden.jsonl");
        std::fs::write(&hidden, CLAUDE).unwrap();
        let hidden_mtime_ms = t0 + 2 * 60 * 60 * 1000;
        std::fs::File::open(&hidden)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_millis(hidden_mtime_ms as u64))
            .unwrap();
        struct RestorePerms(std::path::PathBuf);
        impl Drop for RestorePerms {
            fn drop(&mut self) {
                let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
            }
        }
        let restore = RestorePerms(locked.clone());
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read_dir(&locked).is_ok() {
            let uid = std::process::Command::new("id")
                .arg("-u")
                .output()
                .ok()
                .and_then(|out| String::from_utf8(out.stdout).ok());
            if uid.as_deref().map(str::trim) == Some("0") {
                return;
            }
            panic!("chmod 000 did not deny listing on a non-root process");
        }

        let t_later = t0 + 48 * 60 * 60 * 1000;
        let blocked = run_fact_sync(
            home.path(),
            state.path(),
            ingest_url.clone(),
            false,
            t_later,
        )
        .await;
        let claude = blocked
            .reports
            .iter()
            .find(|(source, _)| *source == AgentSource::Claude)
            .unwrap()
            .1
            .clone();
        assert!(claude.discovery_errors >= 1);
        assert!(!claude.is_complete());
        assert_eq!(
            claude.first_error.as_deref(),
            Some(collector_sync::DISCOVERY_INCOMPLETE)
        );
        assert!(!claude.first_error.as_deref().unwrap_or("").contains('/'));
        assert!(!claude
            .first_error
            .as_deref()
            .unwrap_or("")
            .contains("hidden"));
        assert_eq!(last_complete_sync_at_ms(state.path()), Some(t0));
        assert!(cursor_store(state.path())
            .get(AgentSource::Claude, hidden.to_str().unwrap())
            .unwrap()
            .is_none());

        std::fs::set_permissions(&restore.0, std::fs::Permissions::from_mode(0o755)).unwrap();
        drop(restore);

        // If the blocked pass had advanced the watermark to t_later, resume_incremental would cut
        // at t_later - 24h (t0 + 24h) and drop hidden (mtime t0 + 2h). Holding t0 keeps it in scope.
        let recovered = run_fact_sync(home.path(), state.path(), ingest_url, false, t_later).await;
        let claude = recovered
            .reports
            .iter()
            .find(|(source, _)| *source == AgentSource::Claude)
            .unwrap()
            .1
            .clone();
        assert_eq!(claude.discovery_errors, 0);
        assert_eq!(claude.selected, 1);
        assert_eq!(claude.advanced, 1);
        assert!(cursor_store(state.path())
            .get(AgentSource::Claude, hidden.to_str().unwrap())
            .unwrap()
            .is_some());
        assert_eq!(last_complete_sync_at_ms(state.path()), Some(t_later));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unreadable_root_ancestor_holds_the_watermark_so_later_passes_still_see_older_files() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{Duration, UNIX_EPOCH};

        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        let claude_dir = home.path().join(".claude/projects/p1");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(claude_dir.join("visible.jsonl"), CLAUDE).unwrap();

        let ingest_url = spawn_http(|_raw| {
            raw_response(
                202,
                "Accepted",
                r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
            )
        })
        .await;

        let t0 = 1_779_840_000_000;
        let first = run_fact_sync(home.path(), state.path(), ingest_url.clone(), false, t0).await;
        assert!(first.reports.iter().all(|(_, report)| report.is_complete()));
        assert_eq!(last_complete_sync_at_ms(state.path()), Some(t0));

        let delayed = claude_dir.join("delayed.jsonl");
        std::fs::write(&delayed, CLAUDE).unwrap();
        let delayed_mtime_ms = t0 + 2 * 60 * 60 * 1000;
        std::fs::File::open(&delayed)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_millis(delayed_mtime_ms as u64))
            .unwrap();

        struct RestorePerms(std::path::PathBuf);
        impl Drop for RestorePerms {
            fn drop(&mut self) {
                let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
            }
        }
        let ancestor = home.path().join(".claude");
        let restore = RestorePerms(ancestor.clone());
        std::fs::set_permissions(&ancestor, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read_dir(&ancestor).is_ok() {
            let uid = std::process::Command::new("id")
                .arg("-u")
                .output()
                .ok()
                .and_then(|out| String::from_utf8(out.stdout).ok());
            if uid.as_deref().map(str::trim) == Some("0") {
                return;
            }
            panic!("chmod 000 did not deny listing on a non-root process");
        }

        let t_later = t0 + 48 * 60 * 60 * 1000;
        let blocked = run_fact_sync(
            home.path(),
            state.path(),
            ingest_url.clone(),
            false,
            t_later,
        )
        .await;
        let claude = blocked
            .reports
            .iter()
            .find(|(source, _)| *source == AgentSource::Claude)
            .unwrap()
            .1
            .clone();
        assert!(claude.discovery_errors >= 1);
        assert!(!claude.is_complete());
        assert_eq!(
            claude.first_error.as_deref(),
            Some(collector_sync::DISCOVERY_INCOMPLETE)
        );
        assert!(!claude.first_error.as_deref().unwrap_or("").contains('/'));
        assert_eq!(last_complete_sync_at_ms(state.path()), Some(t0));

        std::fs::set_permissions(&restore.0, std::fs::Permissions::from_mode(0o755)).unwrap();
        drop(restore);

        // If the blocked pass had treated the unreadable ancestor as a missing root, the watermark
        // would have advanced to t_later and resume_incremental would drop delayed (mtime t0+2h).
        let recovered = run_fact_sync(home.path(), state.path(), ingest_url, false, t_later).await;
        let claude = recovered
            .reports
            .iter()
            .find(|(source, _)| *source == AgentSource::Claude)
            .unwrap()
            .1
            .clone();
        assert_eq!(claude.discovery_errors, 0);
        assert_eq!(claude.selected, 1);
        assert_eq!(claude.advanced, 1);
        assert!(cursor_store(state.path())
            .get(AgentSource::Claude, delayed.to_str().unwrap())
            .unwrap()
            .is_some());
        assert_eq!(last_complete_sync_at_ms(state.path()), Some(t_later));
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

    #[tokio::test]
    async fn policy_refresh_freeze_preserves_source_authorization_metadata() {
        let state = tempfile::TempDir::new().unwrap();
        let paths = Paths::at(state.path().to_path_buf());
        let enrollment_path = paths.archive_enrollment_file("org_1");
        let original = ArchiveEnrollmentRecord {
            status: ArchivePolicy::Enrolled.as_str().to_string(),
            collector_id: Some("collector".to_string()),
            authorized_sources: vec![authorization(ArchiveSource::Claude)],
            reason: None,
        };
        original.save_record(&enrollment_path).unwrap();
        let endpoint =
            spawn_http(|_| raw_response(401, "Unauthorized", r#"{"reason":"expired"}"#)).await;
        crate::archive_policy::refresh_archive_policy(
            &paths,
            "org_1",
            "collector",
            endpoint,
            "tfc_secret",
        )
        .await
        .unwrap();
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
    async fn fact_denial_leaves_archive_policy_to_scheduler() {
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
        assert!(keys.load("org_1").unwrap().is_some());
        assert!(spool_dir.exists());
        assert_eq!(
            ArchiveEnrollmentRecord::load(&enrollment_path).unwrap(),
            ArchivePolicy::Enrolled
        );
    }

    #[tokio::test]
    async fn fact_denial_preserves_frozen_archive_until_policy_refresh() {
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
        assert!(keys.load("org_1").unwrap().is_some());
        assert!(spool_dir.exists());
        assert_eq!(
            ArchiveEnrollmentRecord::load(&enrollment_path).unwrap(),
            ArchivePolicy::Frozen
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
        let legacy_spool_dir = paths.legacy_archive_spool_dir("org_1");
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
            let spool = ArchiveSpool::open(&legacy_spool_dir, "org_1", keys.as_ref()).unwrap();
            spool.persist_pending(&pending).unwrap();
        }
        prepare_archive_spool(&legacy_spool_dir, &spool_dir, "org_1", keys.as_ref()).unwrap();

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
        let legacy_spool_dir = paths.legacy_archive_spool_dir("org_1");
        let keys = Arc::new(MemoryKeyStore::new());
        let _ = ArchiveSpool::open(&legacy_spool_dir, "org_1", keys.as_ref()).unwrap();
        prepare_archive_spool(&legacy_spool_dir, &spool_dir, "org_1", keys.as_ref()).unwrap();
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

    #[test]
    fn explicit_revocation_removes_active_and_preserved_legacy_spools() {
        let state = tempfile::TempDir::new().unwrap();
        let paths = Paths::at(state.path().to_path_buf());
        paths.ensure().unwrap();
        let keys = Arc::new(MemoryKeyStore::new());
        let org_id = "org_legacy_cleanup";
        let legacy = paths.legacy_archive_spool_dir(org_id);
        let active = paths.archive_spool_dir(org_id);
        ArchiveSpool::open(&legacy, org_id, keys.as_ref()).unwrap();
        prepare_archive_spool(&legacy, &active, org_id, keys.as_ref()).unwrap();
        let staging = migration_staging_dir(&active).unwrap();
        std::fs::create_dir(&staging).unwrap();
        std::fs::copy(
            active.join("archive-format.json"),
            staging.join("archive-format.json"),
        )
        .unwrap();
        let config = ArchiveRunConfig {
            archive_url: "https://archive.example".to_string(),
            spool_dir: active.clone(),
            enrollment_path: paths.archive_enrollment_file(org_id),
            key_store: keys.clone(),
            policy: ArchivePolicy::Revoked,
            authorized_sources: Vec::new(),
        };

        let report =
            capture_archive_local(&config, org_id, &SourceHomes::standard(state.path()), 1);

        assert!(report.purged);
        assert!(!legacy.exists());
        assert!(!active.exists());
        assert!(!staging.exists());
        assert!(keys.load(org_id).unwrap().is_none());
        assert!(keys
            .load(&format!("{org_id}:archive-v2"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn upload_preparation_fails_closed_without_persisted_history_state() {
        let state = tempfile::TempDir::new().unwrap();
        let keys = Arc::new(MemoryKeyStore::new());
        let spool_dir = state.path().join("archive-spool-org_1");
        ArchiveSpool::open(&spool_dir, "org_1", keys.as_ref()).unwrap();
        let config = ArchiveRunConfig {
            archive_url: "https://archive.example".to_string(),
            spool_dir,
            enrollment_path: state.path().join("archive-enrollment-org_1.json"),
            key_store: keys,
            policy: ArchivePolicy::Enrolled,
            authorized_sources: vec![authorization(ArchiveSource::Codex)],
        };

        assert!(matches!(
            prepare_archive_upload(&config, "org_1", &HashSet::new()),
            Err("archive_history_missing")
        ));
    }

    struct StalledUploader {
        started: Notify,
        release: Notify,
    }

    impl ArchiveUploader for StalledUploader {
        async fn upload(
            &self,
            _source: ArchiveSource,
            _body: &[u8],
            _cancel: Option<&tokio_util::sync::CancellationToken>,
        ) -> Result<ArchiveAcknowledgement, ArchiveClientError> {
            self.started.notify_one();
            self.release.notified().await;
            Err(ArchiveClientError::Unavailable {
                reason: "test_stall_released".to_string(),
            })
        }
    }

    #[tokio::test]
    async fn local_capture_continues_while_an_upload_is_stalled() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        let path = home.path().join(".codex/sessions/session.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"stalled\",\"timestamp\":\"2026-01-01T00:00:00Z\"}}\n",
        )
        .unwrap();
        let keys = Arc::new(MemoryKeyStore::new());
        let config = ArchiveRunConfig {
            archive_url: "https://archive.example".to_string(),
            spool_dir: state.path().join("archive-spool-v2-org_1"),
            enrollment_path: state.path().join("archive-enrollment-org_1.json"),
            key_store: keys,
            policy: ArchivePolicy::Enrolled,
            authorized_sources: vec![authorization(ArchiveSource::Codex)],
        };
        let homes = SourceHomes::standard(home.path());
        let first = capture_archive_local(&config, "org_1", &homes, 10);
        assert!(first.captured > 0);
        let prepared = prepare_archive_upload(&config, "org_1", &HashSet::new())
            .unwrap()
            .unwrap();
        let uploader = Arc::new(StalledUploader {
            started: Notify::new(),
            release: Notify::new(),
        });
        let upload = {
            let uploader = uploader.clone();
            tokio::spawn(async move {
                send_prepared_archive_upload(uploader.as_ref(), &prepared, None).await
            })
        };
        uploader.started.notified().await;

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        use std::io::Write;
        file.write_all(b"{\"type\":\"event_msg\",\"payload\":{\"id\":\"while-stalled\"}}\n")
            .unwrap();
        file.sync_all().unwrap();
        let second = capture_archive_local(&config, "org_1", &homes, 12);

        assert!(second.captured > 0);
        assert!(!upload.is_finished());
        uploader.release.notify_one();
        assert!(upload.await.unwrap().is_err());
    }
}
