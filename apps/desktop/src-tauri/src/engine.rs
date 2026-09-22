// SPDX-License-Identifier: Apache-2.0
// Trace Flow Desktop: the background sync engine.

//! The desktop's sync loop.
//!
//! `collector-sync` is deliberately headless: it gives the embedder discovery, assembly, the cursor
//! store, and a per-cycle drive loop, but the long-running watcher + drive loop "are seams the embedder
//! wires up" (unlike otto-sync's `spawn_orchestrator`). This module is that seam for the desktop — a
//! single tokio task driven by a command channel and a periodic tick. Each cycle calls the *same*
//! [`collector_embedder::sync::run`] the CLI calls, so redaction, cursor advance-only-on-2xx, and
//! batching are identical across both embedders.
//!
//! **First-egress gate:** on a fresh install the engine starts `paused`. Nothing is
//! read for upload and nothing is POSTed until the user explicitly authorizes it — either
//! `StartSyncing` (resume + one-time backfill) or `SyncNow` (resume + one incremental cycle).
//! Detecting sources (file counts) is read-only and does not require resuming.
//!
//! That authorization is persisted in [`SettingsFile`] and honoured on relaunch: an app that was
//! syncing when it quit (or was restarted by login autostart) comes back syncing and runs a cycle at
//! once. Before this, every relaunch silently reset to paused and weeks of transcripts went unsynced.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use collector_embedder::connection::{Connection, Paths};
use collector_embedder::keychain;
use collector_embedder::sources::SourceHomes;
use collector_embedder::sync::{self, Window};
use collector_embedder::{
    ArchiveEnrollmentRequest, ArchiveHistoryChoice, ArchiveSource, ArchiveSourceChoice,
};
use tokio::sync::mpsc;

use crate::archive_scheduler::{self, ArchiveSchedulerHandle};
use crate::settings::{ArchiveRequest, Settings, SettingsFile};
use crate::state::{
    AppStateBus, ArchiveConnectionIdentity, ArchiveMenuState, ConnectionState, SourceCounts,
    SyncStatus,
};

/// How often the engine runs an incremental cycle while resumed.
const TICK: Duration = Duration::from_secs(5 * 60);

/// The default backfill window the first "Start syncing" click triggers.
const FIRST_BACKFILL: &str = "7d";

/// Commands the UI (tray menu or window) sends the engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineCommand {
    /// "Start syncing": authorize egress and run a pass immediately, then stay resumed in incremental
    /// watch mode. The first pass to reach ingest is the one-time `7d` history backfill (recorded in
    /// settings); every later pass is incremental.
    StartSyncing,
    /// "Sync now": the same as `StartSyncing`, offered from the tray while already syncing. It
    /// unpauses first, so unlike the old run-now path it never silently no-ops on a paused engine.
    /// (Connecting, if not yet connected, happens in the command layer before this is sent, since the
    /// device flow needs a browser + loopback listener.)
    SyncNow,
    /// Resume the loop without forcing a backfill.
    Resume,
    /// Stop all egress; the loop stays alive but does no work until resumed.
    Pause,
    /// Authorize one Archive Source through the saved Collector Credential.
    EnrollArchiveSource {
        connection: Option<ArchiveConnectionIdentity>,
        source: ArchiveSource,
        history_choice: ArchiveHistoryChoice,
    },
    /// Reconcile archive sources after an OS resume without changing authorization.
    WakeCapture,
}

#[derive(Clone)]
pub struct EngineHandle {
    tx: mpsc::UnboundedSender<EngineCommand>,
    archive: ArchiveSchedulerHandle,
}

impl EngineHandle {
    /// Send a command; returns false if the engine task has gone away.
    pub fn send(&self, cmd: EngineCommand) -> bool {
        let wakes_archive = matches!(
            cmd,
            EngineCommand::StartSyncing
                | EngineCommand::SyncNow
                | EngineCommand::Resume
                | EngineCommand::EnrollArchiveSource { .. }
                | EngineCommand::WakeCapture
        );
        let sent = self.tx.send(cmd).is_ok();
        if sent && wakes_archive {
            self.archive.wake();
        }
        sent
    }
}

/// Spawn the engine task and return a handle to drive it. Refreshes source counts immediately so the
/// first-run window has data before any egress.
///
/// Uses `tauri::async_runtime::spawn`, not bare `tokio::spawn`: this is called from Tauri's `setup`
/// hook, which runs on a thread with no active tokio runtime, so `tokio::spawn` would panic. Tauri's
/// runtime is initialised on demand and lives for the app, and `run_loop`'s `interval`/`select!` run
/// inside it on the tokio reactor.
pub fn spawn(bus: AppStateBus, settings_file: SettingsFile) -> EngineHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    let archive = archive_scheduler::spawn(settings_file.clone(), bus.clone());
    tauri::async_runtime::spawn(run_loop(rx, bus, settings_file, archive.clone()));
    EngineHandle { tx, archive }
}

async fn run_loop(
    mut rx: mpsc::UnboundedReceiver<EngineCommand>,
    bus: AppStateBus,
    settings_file: SettingsFile,
    archive_scheduler: ArchiveSchedulerHandle,
) {
    let mut settings = load_settings(&settings_file);
    if let Some(home) = dirs_home() {
        settings.source_homes.merge(&SourceHomes::resolve(&home));
        persist(&settings_file, &settings);
    }
    let mut ticker = tokio::time::interval(TICK);
    // The first tick fires immediately; skip it so a paused engine does nothing on startup. A
    // resumed engine runs its own catch-up cycle below instead of waiting a full tick.
    ticker.tick().await;

    bus.update(|s| {
        if settings.syncing {
            s.sync = SyncStatus::Idle;
        }
    });
    refresh_connection(&bus);
    refresh_sources(&bus, Some(&settings.source_homes));
    refresh_archive(&bus);

    if settings.syncing {
        tracing::info!("sync authorized before relaunch; resuming");
        run_authorized_cycle(&bus, &mut settings).await;
        persist(&settings_file, &settings);
    }

    loop {
        tokio::select! {
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { break };
                match cmd {
                    EngineCommand::Pause => {
                        settings.syncing = false;
                        bus.update(|s| s.sync = SyncStatus::Paused);
                    }
                    EngineCommand::Resume => {
                        settings.syncing = true;
                        set_idle(&bus);
                    }
                    EngineCommand::WakeCapture => {}
                    EngineCommand::StartSyncing | EngineCommand::SyncNow => {
                        settings.syncing = true;
                        // Persist the authorization before the (possibly long) pass so a quit
                        // mid-backfill still comes back syncing.
                        persist(&settings_file, &settings);
                        run_authorized_cycle(&bus, &mut settings).await;
                    }
                    EngineCommand::EnrollArchiveSource {
                        connection,
                        source,
                        history_choice,
                    } => {
                        enroll_archive_source(
                            &bus,
                            &settings_file,
                            &mut settings,
                            connection,
                            source,
                            history_choice,
                        ).await;
                    }
                }
                persist(&settings_file, &settings);
                archive_scheduler.wake();
            }
            _ = ticker.tick() => {
                if settings.syncing {
                    let before = settings.clone();
                    run_authorized_cycle(&bus, &mut settings).await;
                    if settings != before {
                        persist(&settings_file, &settings);
                    }
                }
            }
        }
    }
}

async fn enroll_archive_source(
    bus: &AppStateBus,
    settings_file: &SettingsFile,
    settings: &mut Settings,
    expected_connection: Option<ArchiveConnectionIdentity>,
    source: ArchiveSource,
    history_choice: ArchiveHistoryChoice,
) {
    let snapshot = bus.snapshot();
    if archive_enrollment_is_blocked(&snapshot.archive, source) {
        if snapshot.archive.pending == Some(source) {
            bus.update(|state| {
                if state.archive.pending == Some(source) {
                    state.archive.pending = None;
                }
            });
        }
        return;
    }

    let paths = match Paths::resolve() {
        Ok(paths) => paths,
        Err(err) => {
            set_archive_error(bus, format!("resolve collector paths: {err}"));
            return;
        }
    };
    let connection = match paths.load_connection() {
        Ok(Some(connection)) => connection,
        Ok(None) => {
            set_archive_error(bus, "not connected".to_string());
            return;
        }
        Err(err) => {
            set_archive_error(bus, format!("connection read failed: {err}"));
            return;
        }
    };
    let Some(expected_connection) = expected_connection else {
        set_archive_error(bus, "saved connection is unavailable".to_string());
        return;
    };
    if expected_connection.org_id != connection.org_id
        || expected_connection.collector_id != connection.collector_id
    {
        refresh_connection(bus);
        set_archive_error(bus, "connection changed; choose Archive again".to_string());
        return;
    }
    let request = match archive_request_for_connection(
        settings.archive_request.as_ref(),
        &connection.org_id,
        &connection.collector_id,
        source,
        history_choice,
        new_archive_idempotency_key,
    ) {
        Ok(request) => request,
        Err(err) => {
            set_archive_error(bus, err);
            return;
        }
    };
    settings.archive_request = Some(request.clone());
    if let Err(err) = archive_scheduler::save_settings(settings_file, settings) {
        set_archive_error(bus, format!("save archive request: {err}"));
        return;
    }

    let credential = match keychain::load(&connection.org_id) {
        Ok(Some(credential)) => credential,
        Ok(None) => {
            set_archive_error(bus, "no credential - sign in again".to_string());
            return;
        }
        Err(err) => {
            set_archive_error(bus, format!("keychain read failed: {err}"));
            return;
        }
    };
    bus.update(|state| {
        state.archive.pending = Some(source);
        state.archive.last_error = None;
    });

    let org_id = connection.org_id.clone();
    let collector_id = connection.collector_id.clone();
    let enrollment_request = ArchiveEnrollmentRequest {
        authorized_sources: vec![ArchiveSourceChoice {
            source,
            history_choice,
        }],
        idempotency_key: request.idempotency_key,
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|err| anyhow::anyhow!("build runtime: {err}"))?;
        runtime.block_on(archive_scheduler::enroll_source(
            paths,
            org_id,
            collector_id,
            credential,
            enrollment_request,
        ))
    })
    .await;

    match result {
        Ok(Ok(enrolled)) => {
            let run_immediately = apply_enrollment_success(settings, enrolled);
            persist(settings_file, settings);
            refresh_archive(bus);
            clear_archive_error(bus);
            bus.update(|state| state.archive.pending = None);
            if run_immediately {
                run_authorized_cycle(bus, settings).await;
            }
        }
        Ok(Err(err)) => {
            refresh_archive(bus);
            set_archive_command_error(bus, err);
        }
        Err(err) => set_archive_error(bus, format!("archive enrollment task crashed: {err}")),
    }
}

fn archive_enrollment_is_blocked(state: &ArchiveMenuState, source: ArchiveSource) -> bool {
    state.pending.is_some_and(|pending| pending != source)
        || state
            .sources
            .iter()
            .any(|(authorized, _)| *authorized == source)
}

fn archive_request_for_connection(
    pending: Option<&ArchiveRequest>,
    org_id: &str,
    collector_id: &str,
    source: ArchiveSource,
    history_choice: ArchiveHistoryChoice,
    create_id: impl FnOnce() -> Result<String, String>,
) -> Result<ArchiveRequest, String> {
    if let Some(pending) = pending.filter(|pending| {
        pending.org_id == org_id
            && pending.collector_id == collector_id
            && pending.source == source
            && pending.history_choice == history_choice
    }) {
        return Ok(pending.clone());
    }
    Ok(ArchiveRequest {
        org_id: org_id.to_string(),
        collector_id: collector_id.to_string(),
        source,
        history_choice,
        idempotency_key: create_id()?,
    })
}

fn apply_enrollment_success(settings: &mut Settings, enrolled: bool) -> bool {
    settings.archive_request = None;
    enrolled && settings.syncing
}

fn new_archive_idempotency_key() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "create archive request id failed".to_string())?;
    let value = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("archive-enroll:{value}"))
}

fn set_archive_error(bus: &AppStateBus, error: String) {
    tracing::warn!(error = %error, "archive enrollment failed");
    publish_archive_error(bus, error);
}

fn set_archive_command_error(bus: &AppStateBus, error: anyhow::Error) {
    tracing::warn!(error = ?error, "archive enrollment failed");
    publish_archive_error(bus, error.to_string());
}

fn publish_archive_error(bus: &AppStateBus, error: String) {
    bus.update(|state| {
        state.archive.pending = None;
        state.archive.last_error = Some(error);
    });
}

fn clear_archive_error(bus: &AppStateBus) {
    bus.update(|state| state.archive.last_error = None);
}

/// One authorized pass. Until the one-time history backfill has actually reached ingest, every pass
/// (a click, a tick, a relaunch catch-up) uses the wider `FIRST_BACKFILL` window, so a first backfill
/// that failed (network down, then a relaunch) is retried rather than quietly replaced by an
/// incremental pass that would leave the older sessions unsynced.
async fn run_authorized_cycle(bus: &AppStateBus, settings: &mut Settings) {
    let window = window_for_authorized_cycle(settings);
    if let Some(outcome) = run_cycle(bus, window, settings.source_homes.clone()).await {
        apply_authorized_cycle(settings, &outcome);
    }
}

fn window_for_authorized_cycle(settings: &Settings) -> Window {
    if settings.backfilled {
        Window::Incremental
    } else {
        sync::window_from_since(FIRST_BACKFILL).unwrap_or(Window::Incremental)
    }
}

/// True when parsed-fact ingest completed. Optional Archive setup or upload failures stay visible
/// but do not hold the one-time backfill watermark.
fn fact_cycle_reached_ingest(outcome: &CycleOutcome) -> bool {
    outcome.setup_error.is_none() && outcome.first_error.is_none()
}

fn apply_authorized_cycle(settings: &mut Settings, outcome: &CycleOutcome) -> Window {
    let window = window_for_authorized_cycle(settings);
    if fact_cycle_reached_ingest(outcome) {
        settings.backfilled = true;
    }
    window
}

fn sync_status_from_outcome(outcome: &CycleOutcome) -> SyncStatus {
    match (&outcome.setup_error, &outcome.first_error) {
        (Some(err), _) => SyncStatus::Error {
            message: err.clone(),
        },
        (None, Some(err)) if outcome.advanced == 0 => SyncStatus::Error {
            message: err.clone(),
        },
        _ => SyncStatus::Idle,
    }
}

/// Unreadable settings (a corrupt file) fall back to the paused defaults, but loudly: the error lands
/// in the tray's recent-errors list, and the engine stays `Paused` so the tray offers "Start syncing",
/// the click that actually recovers.
fn load_settings(file: &SettingsFile) -> Settings {
    match file.load() {
        Ok(settings) => settings,
        Err(err) => {
            tracing::error!(error = %err, "settings unreadable; starting paused, start syncing again");
            Settings::default()
        }
    }
}

/// A failed write must not stop the current process from syncing; it only means the next relaunch may
/// start paused, so log it where the tray's error list will surface it.
fn persist(file: &SettingsFile, settings: &Settings) {
    if let Err(error) = archive_scheduler::save_settings(file, settings) {
        tracing::error!(error = %error, "failed to save settings");
    }
}

/// The Send-safe outcome of a cycle, lifted out of the (non-Send) sync work so the command loop's
/// future stays `Send`.
struct CycleOutcome {
    advanced: u32,
    failed: u32,
    first_error: Option<String>,
    /// A setup failure (bad client config, broken cursor DB) — distinct from per-session ingest errors.
    setup_error: Option<String>,
}

/// Run one sync pass over all sources, mirroring the result into the state bus. A failed cycle records
/// a stable error class (never a secret) and leaves the engine resumed so the next tick retries.
///
/// The sync engine (`collector-sync`) is deliberately single-task and **not `Send`** — its cycle holds
/// a rusqlite cursor connection across awaits, and `SyncTuning` overlaps upload latency on one task
/// rather than across threads (see the crate's `IngestClient`/`SyncTuning` notes). So the cycle runs on
/// a dedicated blocking thread with its own current-thread runtime — exactly like the CLI's
/// `#[tokio::main]` block-on — and only its `Send` outcome crosses back. This keeps the command loop
/// spawnable on the multi-threaded Tauri runtime without widening the shared crate's contract.
/// Returns the cycle outcome when a pass ran. `None` means the engine skipped (not connected,
/// missing credential) or the blocking task panicked — those must not retire the backfill window.
async fn run_cycle(
    bus: &AppStateBus,
    window: Window,
    source_homes: SourceHomes,
) -> Option<CycleOutcome> {
    let conn = match Paths::resolve().and_then(|p| p.load_connection()) {
        Ok(Some(conn)) => conn,
        Ok(None) => {
            tracing::warn!("sync skipped: not connected");
            publish_disconnected(bus);
            return None;
        }
        Err(err) => {
            tracing::error!(error = %err, "sync skipped: connection read failed");
            bus.update(|s| {
                s.sync = SyncStatus::Error {
                    message: "connection read failed - sign in again".to_string(),
                }
            });
            return None;
        }
    };

    let ingest_url = match conn.sync_ingest_url() {
        Ok(url) => url,
        Err(err) => {
            tracing::warn!(error = %err, "sync skipped: connection missing ingest URL");
            publish_connection(bus, &conn);
            bus.update(|s| {
                s.sync = SyncStatus::Error {
                    message: "connection missing ingest URL - sign in again".to_string(),
                };
            });
            return None;
        }
    };

    publish_connection(bus, &conn);

    let credential = match keychain::load(&conn.org_id) {
        Ok(Some(secret)) => secret,
        Ok(None) => {
            tracing::warn!("sync skipped: no Collector Credential in keychain");
            bus.update(|s| {
                s.sync = SyncStatus::Error {
                    message: "no credential - sign in again".to_string(),
                }
            });
            return None;
        }
        Err(err) => {
            tracing::error!(error = %err, "sync skipped: keychain read failed");
            bus.update(|s| {
                s.sync = SyncStatus::Error {
                    message: "keychain read failed - sign in again".to_string(),
                }
            });
            return None;
        }
    };

    let Some(home) = dirs_home() else {
        tracing::error!("sync skipped: no home directory");
        return None;
    };

    bus.update(|s| s.sync = SyncStatus::Syncing);

    let now_ms = now_ms();
    let cycle_source_homes = source_homes.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_cycle_blocking(
            ArchiveConnectionIdentity {
                org_id: conn.org_id,
                collector_id: conn.collector_id,
            },
            credential,
            ingest_url,
            home,
            cycle_source_homes,
            window,
            now_ms,
        )
    })
    .await;

    let outcome = match result {
        Ok(outcome) => {
            let first_error = outcome.first_error.as_deref().unwrap_or("");
            let setup_error = outcome.setup_error.as_deref().unwrap_or("");
            if outcome.first_error.is_some() || outcome.setup_error.is_some() {
                tracing::warn!(
                    advanced = outcome.advanced,
                    failed = outcome.failed,
                    first_error = %first_error,
                    setup_error = %setup_error,
                    "sync cycle failed"
                );
            } else {
                tracing::info!(
                    advanced = outcome.advanced,
                    failed = outcome.failed,
                    "sync cycle finished"
                );
            }
            bus.update(|s| {
                s.last_sync_at = Some(SystemTime::now());
                s.sync = sync_status_from_outcome(&outcome);
            });
            Some(outcome)
        }
        Err(err) => {
            tracing::error!(error = %err, "sync task panicked");
            bus.update(|s| {
                s.sync = SyncStatus::Error {
                    message: "sync task crashed".to_string(),
                }
            });
            None
        }
    };

    refresh_sources(bus, Some(&source_homes));
    outcome
}

/// The non-`Send` half: build a local current-thread runtime and drive one [`sync::run`] on it.
fn run_cycle_blocking(
    connection: ArchiveConnectionIdentity,
    credential: String,
    ingest_url: String,
    home: std::path::PathBuf,
    source_homes: SourceHomes,
    window: Window,
    now_ms: i64,
) -> CycleOutcome {
    let org_id = connection.org_id;
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            return CycleOutcome {
                advanced: 0,
                failed: 0,
                first_error: None,
                setup_error: Some(format!("build runtime: {err}")),
            };
        }
    };
    let result = runtime.block_on(sync::run_detailed(sync::RunConfig {
        ingest_url,
        credential,
        org_id: &org_id,
        home: &home,
        source_homes: Some(&source_homes),
        window,
        replay: false,
        now_ms,
        batch_id_prefix: "desktop",
        state_dir: None,
    }));

    match result {
        Ok(outcome) => {
            let mut advanced = 0u32;
            let mut failed = 0u32;
            let mut first_error = None;
            for (_source, r) in &outcome.reports {
                advanced += r.advanced;
                failed += r.failed;
                if first_error.is_none() {
                    first_error = r.first_error.clone();
                }
            }
            CycleOutcome {
                advanced,
                failed,
                first_error,
                setup_error: None,
            }
        }
        // Setup failure (bad client config, broken cursor DB). The Display is a class, not a secret.
        Err(err) => CycleOutcome {
            advanced: 0,
            failed: 0,
            first_error: None,
            setup_error: Some(err.to_string()),
        },
    }
}

fn set_idle(bus: &AppStateBus) {
    bus.update(|s| {
        if matches!(s.sync, SyncStatus::Paused) {
            s.sync = SyncStatus::Idle;
        }
    });
}

/// Reflect the on-disk connection into the bus (read-only; no egress).
pub fn refresh_connection(bus: &AppStateBus) {
    match Paths::resolve().and_then(|p| p.load_connection()) {
        Ok(Some(conn)) => {
            if publish_connection(bus, &conn) {
                refresh_archive(bus);
            }
        }
        Ok(None) => publish_disconnected(bus),
        Err(err) => tracing::warn!(error = %err, "failed to read connection state"),
    }
}

fn publish_connection(bus: &AppStateBus, connection: &Connection) -> bool {
    let next = ConnectionState::Connected {
        org_id: connection.org_id.clone(),
        collector_id: connection.collector_id.clone(),
    };
    let mut changed = false;
    bus.update(|state| {
        changed = state.connection != next;
        if changed {
            state.archive = ArchiveMenuState::default();
        }
        state.connection = next;
    });
    changed
}

fn publish_disconnected(bus: &AppStateBus) {
    bus.update(|state| {
        if !matches!(state.connection, ConnectionState::Disconnected) {
            state.archive = ArchiveMenuState::default();
        }
        state.connection = ConnectionState::Disconnected;
    });
}

/// Reflect the local Archive policy into the menu without network access.
pub fn refresh_archive(bus: &AppStateBus) {
    let result = Paths::resolve().and_then(|paths| {
        let Some(connection) = paths.load_connection()? else {
            return Ok(ArchiveMenuState::default());
        };
        let record = archive_scheduler::load_policy(&paths, &connection.org_id)?;
        archive_menu_state_for_connection(record, &connection.collector_id)
    });
    match result {
        Ok(archive) => publish_archive_refresh(bus, archive),
        Err(err) => set_archive_error(bus, format!("load archive enrollment: {err}")),
    }
}

fn publish_archive_refresh(bus: &AppStateBus, archive: ArchiveMenuState) {
    bus.update(|state| {
        let pending = state.archive.pending;
        let last_error = state.archive.last_error.clone();
        state.archive = ArchiveMenuState {
            pending,
            last_error,
            ..archive
        };
    });
}

pub(crate) fn publish_archive_record(
    bus: &AppStateBus,
    record: collector_embedder::ArchiveEnrollmentRecord,
    collector_id: &str,
) {
    match archive_menu_state_for_connection(record, collector_id) {
        Ok(archive) => publish_archive_refresh(bus, archive),
        Err(error) => set_archive_error(bus, format!("load archive enrollment: {error}")),
    }
}

fn archive_menu_state_for_connection(
    record: collector_embedder::ArchiveEnrollmentRecord,
    collector_id: &str,
) -> anyhow::Result<ArchiveMenuState> {
    if record.collector_id.as_deref() != Some(collector_id) {
        return Ok(ArchiveMenuState::default());
    }
    Ok(ArchiveMenuState {
        enrolled: record.policy()?.captures(),
        reason: record.reason,
        sources: record
            .authorized_sources
            .into_iter()
            .map(|source| (source.source, source.history_choice))
            .collect(),
        pending: None,
        last_error: None,
    })
}

/// Recount local `.jsonl` files per source (read-only; no egress).
pub fn refresh_sources(bus: &AppStateBus, configured: Option<&SourceHomes>) {
    let Some(home) = dirs_home() else { return };
    let resolved;
    let homes = match configured {
        Some(homes) => homes,
        None => {
            resolved = SourceHomes::resolve(&home);
            &resolved
        }
    };
    let detected = collector_embedder::sources::detect_configured(homes, &home);
    let mut counts = SourceCounts::default();
    for d in detected {
        match d.source {
            collector_contracts::AgentSource::Claude => counts.claude_files = d.file_count as u32,
            collector_contracts::AgentSource::Codex => counts.codex_files = d.file_count as u32,
            collector_contracts::AgentSource::Cursor => {}
        }
    }
    bus.update(|s| s.sources = counts);
}

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod archive_request_tests {
    use super::*;
    use collector_embedder::sync::ArchivePolicy;
    use tempfile::TempDir;

    fn pending_request() -> ArchiveRequest {
        ArchiveRequest {
            org_id: "org_1".to_string(),
            collector_id: "collector_1".to_string(),
            source: ArchiveSource::Claude,
            history_choice: ArchiveHistoryChoice::AllHistory,
            idempotency_key: "archive-enroll:original".to_string(),
        }
    }

    #[test]
    fn queued_marker_allows_its_command_and_blocks_another_source() {
        let mut state = ArchiveMenuState {
            pending: Some(ArchiveSource::Claude),
            ..ArchiveMenuState::default()
        };

        assert!(!archive_enrollment_is_blocked(
            &state,
            ArchiveSource::Claude
        ));
        assert!(archive_enrollment_is_blocked(&state, ArchiveSource::Codex));

        state.sources = vec![(ArchiveSource::Claude, ArchiveHistoryChoice::AllHistory)];
        assert!(archive_enrollment_is_blocked(&state, ArchiveSource::Claude));
    }

    #[test]
    fn terminal_record_replaces_sources_before_reporting_failure() {
        let bus = AppStateBus::new();
        bus.update(|state| {
            state.archive.enrolled = true;
            state.archive.sources = vec![(ArchiveSource::Claude, ArchiveHistoryChoice::AllHistory)];
            state.archive.pending = Some(ArchiveSource::Codex);
        });
        let record = collector_embedder::ArchiveEnrollmentRecord {
            status: ArchivePolicy::Revoked.as_str().to_string(),
            collector_id: Some("collector_1".to_string()),
            authorized_sources: Vec::new(),
            reason: Some("revoked".to_string()),
        };

        publish_archive_record(&bus, record, "collector_1");
        publish_archive_error(&bus, "collector credential was revoked".to_string());

        let archive = bus.snapshot().archive;
        assert!(!archive.enrolled);
        assert_eq!(archive.reason.as_deref(), Some("revoked"));
        assert!(archive.sources.is_empty());
        assert_eq!(archive.pending, None);
        assert_eq!(
            archive.last_error.as_deref(),
            Some("collector credential was revoked")
        );
    }

    async fn assert_discarded_authorized_command_pending(
        pending: ArchiveSource,
        expected_pending: Option<ArchiveSource>,
    ) {
        let bus = AppStateBus::new();
        bus.update(|state| {
            state.archive.sources = vec![(ArchiveSource::Claude, ArchiveHistoryChoice::AllHistory)];
            state.archive.pending = Some(pending);
            state.archive.last_error = Some("keep this error".to_string());
        });
        let settings_dir = TempDir::new().unwrap();
        let settings_file = SettingsFile::at(settings_dir.path());
        let mut settings = Settings {
            syncing: true,
            backfilled: true,
            archive_request: Some(pending_request()),
            ..Default::default()
        };
        let expected_settings = settings.clone();

        enroll_archive_source(
            &bus,
            &settings_file,
            &mut settings,
            None,
            ArchiveSource::Claude,
            ArchiveHistoryChoice::AllHistory,
        )
        .await;

        let archive = bus.snapshot().archive;
        assert_eq!(archive.pending, expected_pending);
        assert_eq!(
            archive.sources,
            vec![(ArchiveSource::Claude, ArchiveHistoryChoice::AllHistory)]
        );
        assert_eq!(archive.last_error.as_deref(), Some("keep this error"));
        assert_eq!(settings, expected_settings);
        assert!(!settings_dir.path().join("settings.json").exists());
    }

    #[tokio::test]
    async fn discarded_authorized_command_clears_its_matching_pending_marker() {
        assert_discarded_authorized_command_pending(ArchiveSource::Claude, None).await;
    }

    #[tokio::test]
    async fn discarded_command_preserves_another_sources_pending_marker() {
        assert_discarded_authorized_command_pending(
            ArchiveSource::Codex,
            Some(ArchiveSource::Codex),
        )
        .await;
    }

    #[test]
    fn retry_reuses_the_request_only_for_the_same_saved_connection() {
        let pending = pending_request();
        let retry = archive_request_for_connection(
            Some(&pending),
            "org_1",
            "collector_1",
            ArchiveSource::Claude,
            ArchiveHistoryChoice::AllHistory,
            || panic!("same connection retry must not mint another key"),
        )
        .unwrap();
        assert_eq!(retry, pending);

        let replacement = archive_request_for_connection(
            Some(&pending),
            "org_1",
            "collector_2",
            ArchiveSource::Claude,
            ArchiveHistoryChoice::AllHistory,
            || Ok("archive-enroll:replacement".to_string()),
        )
        .unwrap();
        assert_eq!(replacement.collector_id, "collector_2");
        assert_eq!(replacement.idempotency_key, "archive-enroll:replacement");
    }

    #[test]
    fn enrollment_success_preserves_pause_and_backfill_choices() {
        for syncing in [false, true] {
            let mut settings = Settings {
                syncing,
                backfilled: true,
                archive_request: Some(pending_request()),
                ..Default::default()
            };
            let run_immediately = apply_enrollment_success(&mut settings, true);
            assert_eq!(run_immediately, syncing);
            assert_eq!(settings.syncing, syncing);
            assert!(settings.backfilled);
            assert!(settings.archive_request.is_none());
        }

        let mut settings = Settings {
            syncing: true,
            backfilled: false,
            archive_request: Some(pending_request()),
            ..Default::default()
        };
        assert!(!apply_enrollment_success(&mut settings, false));
        assert!(settings.syncing);
        assert!(settings.archive_request.is_none());
    }
}
