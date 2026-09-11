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

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use collector_embedder::connection::{Connection, Paths};
use collector_embedder::keychain;
use collector_embedder::sync::{self, ArchiveKeyStore, Window};
use collector_embedder::{
    archive_policy, defaults, ArchiveEnrollmentRequest, ArchiveHistoryChoice, ArchiveSource,
    ArchiveSourceChoice, ArchiveTarget, ArchiveTargetError,
};
use tokio::sync::mpsc;

use crate::settings::{
    ArchivePolicyDenial, ArchiveRepairState, ArchiveRequest, Settings, SettingsFile,
};
use crate::state::{
    AppStateBus, ArchiveConnectionIdentity, ArchiveMenuState, ConnectionState, SourceCounts,
    SyncStatus,
};

/// How often the engine runs an incremental cycle while resumed.
const TICK: Duration = Duration::from_secs(5 * 60);

/// The default backfill window the first "Start syncing" click triggers.
const FIRST_BACKFILL: &str = "7d";

#[derive(Default)]
struct ArchivePolicyMemory {
    unpersisted_denial: Option<(
        ArchiveConnectionIdentity,
        collector_embedder::ArchiveEnrollmentRecord,
    )>,
}

impl ArchivePolicyMemory {
    fn from_settings(settings: &Settings) -> Self {
        Self {
            unpersisted_denial: settings.archive_policy_denial.as_ref().map(|denial| {
                (
                    ArchiveConnectionIdentity {
                        org_id: denial.org_id.clone(),
                        collector_id: denial.collector_id.clone(),
                    },
                    denial.enrollment.clone(),
                )
            }),
        }
    }

    fn denial_for(
        &self,
        connection: &ArchiveConnectionIdentity,
    ) -> Option<collector_embedder::ArchiveEnrollmentRecord> {
        self.unpersisted_denial
            .as_ref()
            .filter(|(remembered, _)| remembered == connection)
            .map(|(_, record)| record.clone())
    }

    fn observe_refresh(
        &mut self,
        connection: &ArchiveConnectionIdentity,
        observation: Option<&ArchivePolicyObservation>,
    ) {
        let Some(observation) = observation else {
            return;
        };
        let is_denial = observation
            .confirmed
            .policy()
            .is_ok_and(|policy| !policy.captures());
        if is_denial && !observation.persisted {
            self.unpersisted_denial = Some((connection.clone(), observation.confirmed.clone()));
        } else if observation.persisted {
            self.clear(connection);
        }
    }

    fn update_settings(&self, settings: &mut Settings) {
        settings.archive_policy_denial =
            self.unpersisted_denial
                .as_ref()
                .map(|(connection, enrollment)| ArchivePolicyDenial {
                    org_id: connection.org_id.clone(),
                    collector_id: connection.collector_id.clone(),
                    enrollment: enrollment.clone(),
                });
    }

    fn clear(&mut self, connection: &ArchiveConnectionIdentity) {
        if self
            .unpersisted_denial
            .as_ref()
            .is_some_and(|(remembered, _)| remembered == connection)
        {
            self.unpersisted_denial = None;
        }
    }
}

struct ArchivePolicyObservation {
    confirmed: collector_embedder::ArchiveEnrollmentRecord,
    persisted: bool,
}

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
}

#[derive(Clone)]
pub struct EngineHandle {
    tx: mpsc::UnboundedSender<EngineCommand>,
}

impl EngineHandle {
    /// Send a command; returns false if the engine task has gone away.
    pub fn send(&self, cmd: EngineCommand) -> bool {
        self.tx.send(cmd).is_ok()
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
    tauri::async_runtime::spawn(run_loop(rx, bus, settings_file));
    EngineHandle { tx }
}

async fn run_loop(
    mut rx: mpsc::UnboundedReceiver<EngineCommand>,
    bus: AppStateBus,
    settings_file: SettingsFile,
) {
    let mut settings = load_settings(&settings_file);
    let mut archive_policy_memory = ArchivePolicyMemory::from_settings(&settings);
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
    refresh_sources(&bus);
    refresh_archive(&bus);
    publish_archive_repairs(&bus, &settings);

    if settings.syncing {
        tracing::info!("sync authorized before relaunch; resuming");
        run_authorized_cycle(&bus, &mut settings, &mut archive_policy_memory).await;
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
                    EngineCommand::StartSyncing | EngineCommand::SyncNow => {
                        settings.syncing = true;
                        // Persist the authorization before the (possibly long) pass so a quit
                        // mid-backfill still comes back syncing.
                        persist(&settings_file, &settings);
                        run_authorized_cycle(&bus, &mut settings, &mut archive_policy_memory).await;
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
                            &mut archive_policy_memory,
                            connection,
                            source,
                            history_choice,
                        ).await;
                    }
                }
                persist(&settings_file, &settings);
            }
            _ = ticker.tick() => {
                if settings.syncing {
                    let before = settings.clone();
                    run_authorized_cycle(&bus, &mut settings, &mut archive_policy_memory).await;
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
    archive_policy_memory: &mut ArchivePolicyMemory,
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
    if let Err(err) = settings_file.save(settings) {
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
        runtime.block_on(archive_policy::enroll_archive_source(
            &paths,
            &org_id,
            &collector_id,
            defaults::archive_url(),
            &credential,
            &enrollment_request,
        ))
    })
    .await;

    match result {
        Ok(Ok(enrolled)) => {
            archive_policy_memory.clear(&ArchiveConnectionIdentity {
                org_id: connection.org_id.clone(),
                collector_id: connection.collector_id.clone(),
            });
            archive_policy_memory.update_settings(settings);
            let run_immediately = apply_enrollment_success(settings, enrolled);
            persist(settings_file, settings);
            refresh_archive(bus);
            publish_archive_recovery(bus, settings);
            bus.update(|state| state.archive.pending = None);
            if run_immediately {
                run_authorized_cycle(bus, settings, archive_policy_memory).await;
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

fn clear_archive_repair_error(bus: &AppStateBus) {
    bus.update(|state| {
        if state.archive.last_error.as_deref().is_some_and(|error| {
            error == "Claude archive needs repair" || error == "Codex archive needs repair"
        }) {
            state.archive.last_error = None;
        }
    });
}

/// One authorized pass. Until the one-time history backfill has actually reached ingest, every pass
/// (a click, a tick, a relaunch catch-up) uses the wider `FIRST_BACKFILL` window, so a first backfill
/// that failed (network down, then a relaunch) is retried rather than quietly replaced by an
/// incremental pass that would leave the older sessions unsynced.
async fn run_authorized_cycle(
    bus: &AppStateBus,
    settings: &mut Settings,
    archive_policy_memory: &mut ArchivePolicyMemory,
) {
    let window = window_for_authorized_cycle(settings);
    if let Some(outcome) = run_cycle(bus, window, archive_policy_memory).await {
        apply_authorized_cycle(settings, &outcome);
        reconcile_archive_repairs(settings, &outcome);
        update_archive_error_after_cycle(bus, settings, &outcome);
    }
    archive_policy_memory.update_settings(settings);
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
    match (
        &outcome.setup_error,
        &outcome.archive_setup_error,
        &outcome.first_error,
    ) {
        (Some(err), _, _) => SyncStatus::Error {
            message: err.clone(),
        },
        (None, Some(err), _) => SyncStatus::Error {
            message: err.clone(),
        },
        (None, None, Some(err)) if outcome.advanced == 0 => SyncStatus::Error {
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
    if let Err(err) = file.save(settings) {
        tracing::error!(error = %err, "failed to save settings");
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
    /// Optional Archive enrollment/load or upload failure. Visible in status and retried next cycle,
    /// but must not block fact backfill.
    archive_setup_error: Option<String>,
    archive_connection: Option<ArchiveConnectionIdentity>,
    archive_target_errors: Vec<ArchiveTargetError>,
    archive_validated_targets: Vec<ArchiveTarget>,
    archive_recovered: bool,
}

fn archive_repair_message(error: &ArchiveTargetError) -> Option<String> {
    match error.error_class.as_str() {
        "archive_historical_prefix_changed" | "archive_historical_prefix_shortened" => {
            let source = match error.source {
                ArchiveSource::Claude => "Claude",
                ArchiveSource::Codex => "Codex",
            };
            Some(format!("{source} archive needs repair"))
        }
        _ => None,
    }
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
    archive_policy_memory: &mut ArchivePolicyMemory,
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

    let archive_connection = ArchiveConnectionIdentity {
        org_id: conn.org_id.clone(),
        collector_id: conn.collector_id.clone(),
    };
    let remembered_denial = archive_policy_memory.denial_for(&archive_connection);
    let memory_connection = archive_connection.clone();
    publish_connection(bus, &conn);

    let credential = match keychain::load(&archive_connection.org_id) {
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
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_cycle_blocking_with_policy_memory(
            archive_connection,
            credential,
            ingest_url,
            home,
            window,
            now_ms,
            CycleIsolation::production(remembered_denial),
        )
    })
    .await;

    let outcome = match result {
        Ok((outcome, observation)) => {
            archive_policy_memory.observe_refresh(&memory_connection, observation.as_ref());
            let first_error = outcome.first_error.as_deref().unwrap_or("");
            let setup_error = outcome.setup_error.as_deref().unwrap_or("");
            let archive_setup_error = outcome.archive_setup_error.as_deref().unwrap_or("");
            if outcome.first_error.is_some()
                || outcome.setup_error.is_some()
                || outcome.archive_setup_error.is_some()
            {
                tracing::warn!(
                    advanced = outcome.advanced,
                    failed = outcome.failed,
                    first_error = %first_error,
                    setup_error = %setup_error,
                    archive_setup_error = %archive_setup_error,
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

    refresh_sources(bus);
    refresh_archive(bus);
    outcome
}

fn reconcile_archive_repairs(settings: &mut Settings, outcome: &CycleOutcome) {
    let Some(connection) = &outcome.archive_connection else {
        return;
    };
    if settings.archive_repairs.as_ref().is_some_and(|repairs| {
        repairs.org_id != connection.org_id || repairs.collector_id != connection.collector_id
    }) {
        settings.archive_repairs = None;
    }

    let actionable: Vec<_> = outcome
        .archive_target_errors
        .iter()
        .filter(|error| archive_repair_message(error).is_some())
        .cloned()
        .collect();
    if settings.archive_repairs.is_none() && !actionable.is_empty() {
        settings.archive_repairs = Some(ArchiveRepairState {
            org_id: connection.org_id.clone(),
            collector_id: connection.collector_id.clone(),
            targets: Vec::new(),
        });
    }
    let Some(repairs) = settings.archive_repairs.as_mut() else {
        return;
    };

    repairs.targets.retain(|error| {
        !outcome.archive_validated_targets.iter().any(|target| {
            error.source == target.source
                && error.source_session_id == target.source_session_id
                && error.source_transcript_part_id == target.source_transcript_part_id
        })
    });
    for error in actionable {
        repairs.targets.retain(|existing| {
            existing.source != error.source
                || existing.source_session_id != error.source_session_id
                || existing.source_transcript_part_id != error.source_transcript_part_id
        });
        repairs.targets.push(error);
    }
    if repairs.targets.is_empty() {
        settings.archive_repairs = None;
    }
}

fn publish_archive_repairs(bus: &AppStateBus, settings: &Settings) -> bool {
    let mut published = false;
    bus.update(|state| {
        state.archive_repairs = settings.archive_repairs.clone();
        if let Some(message) =
            repair_message_for_connection(state.archive_repairs.as_ref(), &state.connection)
        {
            state.archive.last_error = Some(message);
            published = true;
        }
    });
    published
}

fn repair_message_for_connection(
    repairs: Option<&ArchiveRepairState>,
    connection: &ConnectionState,
) -> Option<String> {
    let connection = connection.archive_identity();
    repairs
        .as_ref()
        .filter(|repairs| {
            connection.as_ref().is_some_and(|connection| {
                repairs.org_id == connection.org_id
                    && repairs.collector_id == connection.collector_id
            })
        })
        .and_then(|repairs| repairs.targets.iter().find_map(archive_repair_message))
}

fn publish_archive_recovery(bus: &AppStateBus, settings: &Settings) {
    if !publish_archive_repairs(bus, settings) {
        clear_archive_error(bus);
    }
}

fn update_archive_error_after_cycle(
    bus: &AppStateBus,
    settings: &Settings,
    outcome: &CycleOutcome,
) {
    if !publish_archive_repairs(bus, settings) {
        if !outcome.archive_validated_targets.is_empty() {
            clear_archive_repair_error(bus);
        }
        if outcome.archive_recovered {
            clear_archive_error(bus);
        }
    }
}

/// Test isolation for collector state and Archive inputs. Production resolves both paths itself and
/// may carry a denial restored from desktop settings.
struct CycleIsolation {
    state_dir: Option<std::path::PathBuf>,
    archive: Option<(String, Arc<dyn ArchiveKeyStore>)>,
    remembered_denial: Option<collector_embedder::ArchiveEnrollmentRecord>,
}

impl CycleIsolation {
    fn production(remembered_denial: Option<collector_embedder::ArchiveEnrollmentRecord>) -> Self {
        Self {
            state_dir: None,
            archive: None,
            remembered_denial,
        }
    }
}

/// Load Archive inputs for this serialized cycle. Inactive enrollment stays `None` so no spool or
/// key is created. Frozen/grace/revoked keep the existing local archive state without a second task.
/// Cleanup markers keep Archive on the cycle even when enrollment is unreadable. Parse failures
/// without a marker stay fail-loud in the error string but do not abort parsed-fact sync.
fn cycle_archive_config(
    paths: &Paths,
    org_id: &str,
    collector_id: &str,
    archive: Option<(String, Arc<dyn ArchiveKeyStore>)>,
    confirmed: Option<collector_embedder::ArchiveEnrollmentRecord>,
) -> (Option<sync::ArchiveRunConfig>, Option<String>) {
    if !sync::cleanup_obligation_exists(&paths.archive_spool_dir(org_id)) {
        let loaded = confirmed
            .is_none()
            .then(|| archive_policy::load_archive_policy(paths, org_id).ok())
            .flatten();
        if let Some(record) = confirmed.as_ref().or(loaded.as_ref()) {
            if record.policy().is_ok_and(|policy| policy.captures())
                && record.collector_id.as_deref() != Some(collector_id)
            {
                return (None, None);
            }
        }
    }
    match (archive, confirmed) {
        (Some((url, keys)), Some(record)) => {
            sync::prepare_confirmed_archive(paths, org_id, url, keys, record)
        }
        (None, Some(record)) => sync::prepare_desktop_confirmed_archive(paths, org_id, record),
        (Some((url, keys)), None) => sync::prepare_serialized_archive(paths, org_id, url, keys),
        (None, None) => sync::prepare_desktop_serialized_archive(paths, org_id),
    }
}

/// The non-`Send` half: build a local current-thread runtime and drive one [`sync::run`] on it.
#[cfg(test)]
fn run_cycle_blocking(
    connection: ArchiveConnectionIdentity,
    credential: String,
    ingest_url: String,
    home: std::path::PathBuf,
    window: Window,
    now_ms: i64,
    isolation: CycleIsolation,
) -> CycleOutcome {
    run_cycle_blocking_with_policy_memory(
        connection, credential, ingest_url, home, window, now_ms, isolation,
    )
    .0
}

fn run_cycle_blocking_with_policy_memory(
    connection: ArchiveConnectionIdentity,
    credential: String,
    ingest_url: String,
    home: std::path::PathBuf,
    window: Window,
    now_ms: i64,
    isolation: CycleIsolation,
) -> (CycleOutcome, Option<ArchivePolicyObservation>) {
    let archive_connection = Some(connection.clone());
    let ArchiveConnectionIdentity {
        org_id,
        collector_id,
    } = connection;
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            return (
                CycleOutcome {
                    advanced: 0,
                    failed: 0,
                    first_error: None,
                    setup_error: Some(format!("build runtime: {err}")),
                    archive_setup_error: None,
                    archive_connection,
                    archive_target_errors: Vec::new(),
                    archive_validated_targets: Vec::new(),
                    archive_recovered: false,
                },
                None,
            );
        }
    };

    let CycleIsolation {
        state_dir,
        archive: archive_input,
        remembered_denial,
    } = isolation;
    let paths = match state_dir.as_deref() {
        Some(dir) => Ok(Paths::at(dir.to_path_buf())),
        None => Paths::resolve().map_err(|err| format!("resolve collector paths: {err}")),
    };
    let mut archive_setup_error = match &paths {
        Ok(paths) => paths
            .ensure()
            .err()
            .map(|err| format!("prepare collector paths: {err}")),
        Err(err) => Some(err.clone()),
    };

    let should_refresh_policy = state_dir.is_none() || archive_input.is_some();
    let mut archive_recovered = false;
    let mut confirmed_archive_policy = remembered_denial;
    let mut archive_policy_observation = None;
    if archive_setup_error.is_none() && should_refresh_policy {
        let archive_url = archive_input
            .as_ref()
            .map(|(url, _)| url.clone())
            .unwrap_or_else(defaults::archive_url);
        if let Ok(paths) = &paths {
            match runtime.block_on(archive_policy::refresh_archive_policy(
                paths,
                &org_id,
                &collector_id,
                archive_url,
                &credential,
            )) {
                Ok(refreshed) => {
                    archive_recovered = refreshed.persisted;
                    if let Some(confirmed) = refreshed.confirmed {
                        archive_policy_observation = Some(ArchivePolicyObservation {
                            confirmed: confirmed.clone(),
                            persisted: refreshed.persisted,
                        });
                        // An allowed response cannot lift a restart-safe denial until its normal
                        // enrollment marker is durable.
                        if refreshed.persisted
                            || confirmed_archive_policy.is_none()
                            || !confirmed.policy().is_ok_and(|policy| policy.captures())
                        {
                            confirmed_archive_policy = Some(confirmed);
                        }
                    }
                    if let Some(error) = refreshed.persistence_error {
                        archive_setup_error = Some(error);
                    }
                }
                Err(err) => archive_setup_error = Some(err.to_string()),
            }
        }
    }

    let (archive, enrollment_error) = match &paths {
        Ok(paths) => cycle_archive_config(
            paths,
            &org_id,
            &collector_id,
            archive_input,
            confirmed_archive_policy,
        ),
        Err(_) => (None, None),
    };
    if archive_setup_error.is_none() {
        archive_setup_error = enrollment_error;
    }
    let result = runtime.block_on(sync::run_detailed(sync::RunConfig {
        ingest_url,
        credential,
        org_id: &org_id,
        home: &home,
        window,
        replay: false,
        now_ms,
        batch_id_prefix: "desktop",
        archive,
        state_dir: state_dir.as_deref(),
    }));

    let outcome = match result {
        Ok(outcome) => {
            let mut advanced = 0u32;
            let mut failed = 0u32;
            let mut first_error = None;
            let mut archive_target_errors = Vec::new();
            let mut archive_validated_targets = Vec::new();
            for (_source, r) in &outcome.reports {
                advanced += r.advanced;
                failed += r.failed;
                if first_error.is_none() {
                    first_error = r.first_error.clone();
                }
            }
            if let Some(archive) = &outcome.archive {
                tracing::info!(history = ?archive.history, "archive history progress");
                for error in &archive.target_errors {
                    tracing::warn!(
                        error_class = %error.error_class,
                        source = error.source.as_str(),
                        source_session_id = %error.source_session_id,
                        source_transcript_part_id = %error.source_transcript_part_id,
                        "archive target failed"
                    );
                    archive_target_errors.push(error.clone());
                }
                archive_validated_targets.extend(archive.validated_targets.iter().cloned());
                failed += archive.failed;
                archive_recovered |= archive.first_error.is_none()
                    && (archive.uploaded > 0 || archive.captured > 0 || archive.purged);
                if archive_setup_error.is_none() {
                    archive_setup_error = archive.first_error.clone();
                }
            }
            CycleOutcome {
                advanced,
                failed,
                first_error,
                setup_error: None,
                archive_setup_error,
                archive_connection,
                archive_target_errors,
                archive_validated_targets,
                archive_recovered,
            }
        }
        // Setup failure (bad client config, broken cursor DB). The Display is a class, not a secret.
        Err(err) => CycleOutcome {
            advanced: 0,
            failed: 0,
            first_error: None,
            setup_error: Some(err.to_string()),
            archive_setup_error: None,
            archive_connection,
            archive_target_errors: Vec::new(),
            archive_validated_targets: Vec::new(),
            archive_recovered,
        },
    };
    (outcome, archive_policy_observation)
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
        if changed {
            if let Some(message) =
                repair_message_for_connection(state.archive_repairs.as_ref(), &state.connection)
            {
                state.archive.last_error = Some(message);
            }
        }
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
        let record =
            collector_embedder::archive_policy::load_archive_policy(&paths, &connection.org_id)?;
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
pub fn refresh_sources(bus: &AppStateBus) {
    let Some(home) = dirs_home() else { return };
    let detected = collector_embedder::sources::detect(&home);
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
mod archive_engine_tests {
    use super::*;
    use collector_embedder::sync::{
        self, cleanup_obligation_exists, ArchiveKeyStore, ArchivePolicy, ArchiveSpool,
        MemoryKeyStore,
    };
    use std::sync::Arc;
    use tempfile::TempDir;

    fn enrollment(paths: &Paths, org_id: &str, status: &str) {
        let authorized_sources = if status == "enrolled" {
            r#"[{"source":"claude","historyChoice":"all_history","authorizedAt":1770000000001}]"#
        } else {
            "[]"
        };
        std::fs::write(
            paths.archive_enrollment_file(org_id),
            format!(
                r#"{{"status":"{status}","collectorId":"collector_1","authorizedSources":{authorized_sources}}}"#
            ),
        )
        .unwrap();
    }

    fn saved_connection(org_id: &str, collector_id: &str) -> Connection {
        Connection {
            org_id: org_id.to_string(),
            collector_id: collector_id.to_string(),
            convex_url: "https://example.convex.cloud".to_string(),
            ingest_url: "https://ingest.example".to_string(),
            expires_at: 1_800_000_000_000,
        }
    }

    fn archive_identity(org_id: &str, collector_id: &str) -> ArchiveConnectionIdentity {
        ArchiveConnectionIdentity {
            org_id: org_id.to_string(),
            collector_id: collector_id.to_string(),
        }
    }

    #[test]
    fn collector_change_resets_menu_and_rejects_prior_collector_consent() {
        let bus = AppStateBus::new();
        let old = saved_connection("org_1", "collector_old");
        let replacement = saved_connection("org_1", "collector_new");
        publish_connection(&bus, &old);
        bus.update(|state| {
            state.archive.enrolled = true;
            state.archive.sources = vec![(ArchiveSource::Claude, ArchiveHistoryChoice::AllHistory)];
            state.archive.pending = Some(ArchiveSource::Codex);
            state.archive.last_error = Some("old error".to_string());
        });

        assert!(publish_connection(&bus, &replacement));
        assert_eq!(bus.snapshot().archive, ArchiveMenuState::default());

        let old_policy = collector_embedder::ArchiveEnrollmentRecord {
            status: ArchivePolicy::Enrolled.as_str().to_string(),
            collector_id: Some("collector_old".to_string()),
            authorized_sources: vec![collector_embedder::ArchiveAuthorizedSource {
                source: ArchiveSource::Claude,
                history_choice: ArchiveHistoryChoice::AllHistory,
                authorized_at: 1_770_000_000_001,
            }],
            reason: None,
        };
        assert_eq!(
            archive_menu_state_for_connection(old_policy, "collector_new").unwrap(),
            ArchiveMenuState::default()
        );
    }

    #[test]
    fn collector_change_does_not_run_archive_with_prior_collector_consent() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let policy_path = paths.archive_enrollment_file("org_1");
        let policy = collector_embedder::ArchiveEnrollmentRecord {
            status: ArchivePolicy::Enrolled.as_str().to_string(),
            collector_id: Some("collector_old".to_string()),
            authorized_sources: vec![collector_embedder::ArchiveAuthorizedSource {
                source: ArchiveSource::Claude,
                history_choice: ArchiveHistoryChoice::AllHistory,
                authorized_at: 1_770_000_000_001,
            }],
            reason: None,
        };
        policy.save_record(&policy_path).unwrap();
        let before = std::fs::read(&policy_path).unwrap();

        let (config, error) = cycle_archive_config(
            &paths,
            "org_1",
            "collector_new",
            Some((
                "https://archive.example".to_string(),
                Arc::new(MemoryKeyStore::new()),
            )),
            None,
        );

        assert!(config.is_none());
        assert_eq!(error, None);
        assert_eq!(std::fs::read(policy_path).unwrap(), before);
        assert!(!paths.archive_spool_dir("org_1").exists());
    }

    #[test]
    fn confirmed_denial_overrides_stale_enrolled_marker_for_the_current_cycle() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        enrollment(&paths, "org_1", "enrolled");
        let inactive = collector_embedder::ArchiveEnrollmentRecord {
            status: ArchivePolicy::Inactive.as_str().to_string(),
            collector_id: Some("collector_1".to_string()),
            authorized_sources: Vec::new(),
            reason: Some("not_activated".to_string()),
        };

        let (config, error) = cycle_archive_config(
            &paths,
            "org_1",
            "collector_1",
            Some((
                "https://archive.example".to_string(),
                Arc::new(MemoryKeyStore::new()),
            )),
            Some(inactive),
        );

        assert!(config.is_none());
        assert_eq!(error, None);
        assert_eq!(
            collector_embedder::ArchiveEnrollmentRecord::load(
                &paths.archive_enrollment_file("org_1")
            )
            .unwrap(),
            ArchivePolicy::Enrolled
        );
    }

    #[test]
    fn unpersisted_denial_survives_restart_and_a_later_refresh_failure() {
        let state = TempDir::new().unwrap();
        let paths = Paths::at(state.path().to_path_buf());
        paths.ensure().unwrap();
        enrollment(&paths, "org_1", "enrolled");
        let settings_file = SettingsFile::at(state.path());
        let mut settings = Settings::default();
        let connection = archive_identity("org_1", "collector_1");
        let inactive = collector_embedder::ArchiveEnrollmentRecord {
            status: ArchivePolicy::Inactive.as_str().to_string(),
            collector_id: Some("collector_1".to_string()),
            authorized_sources: Vec::new(),
            reason: Some("not_activated".to_string()),
        };
        let mut memory = ArchivePolicyMemory::default();
        let failed_persistence = ArchivePolicyObservation {
            confirmed: inactive.clone(),
            persisted: false,
        };

        memory.observe_refresh(&connection, Some(&failed_persistence));
        assert_eq!(
            memory.denial_for(&connection).unwrap().policy().unwrap(),
            ArchivePolicy::Inactive
        );
        memory.update_settings(&mut settings);
        settings_file.save(&settings).unwrap();
        let (first_config, first_error) = cycle_archive_config(
            &paths,
            "org_1",
            "collector_1",
            Some((
                "https://archive.example".to_string(),
                Arc::new(MemoryKeyStore::new()),
            )),
            Some(inactive),
        );
        assert!(first_config.is_none());
        assert_eq!(first_error, None);

        drop(memory);
        drop(settings);
        let mut restarted_settings = settings_file.load().unwrap();
        let mut restarted_memory = ArchivePolicyMemory::from_settings(&restarted_settings);
        restarted_memory.observe_refresh(&connection, None);
        let (second_config, second_error) = cycle_archive_config(
            &paths,
            "org_1",
            "collector_1",
            Some((
                "https://archive.example".to_string(),
                Arc::new(MemoryKeyStore::new()),
            )),
            restarted_memory.denial_for(&connection),
        );
        assert!(second_config.is_none());
        assert_eq!(second_error, None);
        assert_eq!(
            collector_embedder::ArchiveEnrollmentRecord::load(
                &paths.archive_enrollment_file("org_1")
            )
            .unwrap(),
            ArchivePolicy::Enrolled
        );

        let allowed = ArchivePolicyObservation {
            confirmed: collector_embedder::ArchiveEnrollmentRecord {
                status: ArchivePolicy::Enrolled.as_str().to_string(),
                collector_id: Some("collector_1".to_string()),
                authorized_sources: vec![collector_embedder::ArchiveAuthorizedSource {
                    source: ArchiveSource::Claude,
                    history_choice: ArchiveHistoryChoice::AllHistory,
                    authorized_at: 1_770_000_000_001,
                }],
                reason: None,
            },
            persisted: true,
        };
        restarted_memory.observe_refresh(&connection, Some(&allowed));
        restarted_memory.update_settings(&mut restarted_settings);
        settings_file.save(&restarted_settings).unwrap();

        let recovered_settings = settings_file.load().unwrap();
        assert!(recovered_settings.archive_policy_denial.is_none());
        let recovered_memory = ArchivePolicyMemory::from_settings(&recovered_settings);
        let (recovered_config, recovered_error) = cycle_archive_config(
            &paths,
            "org_1",
            "collector_1",
            Some((
                "https://archive.example".to_string(),
                Arc::new(MemoryKeyStore::new()),
            )),
            recovered_memory.denial_for(&connection),
        );
        assert_eq!(recovered_config.unwrap().policy, ArchivePolicy::Enrolled);
        assert_eq!(recovered_error, None);
    }

    #[test]
    fn durably_persisted_enrollment_clears_remembered_denial() {
        let state = TempDir::new().unwrap();
        let paths = Paths::at(state.path().to_path_buf());
        paths.ensure().unwrap();
        enrollment(&paths, "org_1", "enrolled");
        let connection = archive_identity("org_1", "collector_1");
        let mut memory = ArchivePolicyMemory {
            unpersisted_denial: Some((
                connection.clone(),
                collector_embedder::ArchiveEnrollmentRecord {
                    status: ArchivePolicy::Inactive.as_str().to_string(),
                    collector_id: Some("collector_1".to_string()),
                    authorized_sources: Vec::new(),
                    reason: Some("not_activated".to_string()),
                },
            )),
        };
        let enrolled = collector_embedder::ArchiveEnrollmentRecord {
            status: ArchivePolicy::Enrolled.as_str().to_string(),
            collector_id: Some("collector_1".to_string()),
            authorized_sources: vec![collector_embedder::ArchiveAuthorizedSource {
                source: ArchiveSource::Claude,
                history_choice: ArchiveHistoryChoice::AllHistory,
                authorized_at: 1_770_000_000_001,
            }],
            reason: None,
        };
        let mut recovered = ArchivePolicyObservation {
            confirmed: enrolled,
            persisted: false,
        };

        memory.observe_refresh(&connection, Some(&recovered));
        assert!(memory.denial_for(&connection).is_some());
        recovered.persisted = true;
        memory.observe_refresh(&connection, Some(&recovered));
        assert!(memory.denial_for(&connection).is_none());
        let (config, error) = cycle_archive_config(
            &paths,
            "org_1",
            "collector_1",
            Some((
                "https://archive.example".to_string(),
                Arc::new(MemoryKeyStore::new()),
            )),
            memory.denial_for(&connection),
        );
        assert_eq!(config.unwrap().policy, ArchivePolicy::Enrolled);
        assert_eq!(error, None);
    }

    #[test]
    fn confirmed_revocation_drives_cleanup_when_the_enrollment_marker_is_stale() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        enrollment(&paths, "org_1", "enrolled");
        let revoked = collector_embedder::ArchiveEnrollmentRecord {
            status: ArchivePolicy::Revoked.as_str().to_string(),
            collector_id: Some("collector_1".to_string()),
            authorized_sources: Vec::new(),
            reason: Some("credential_revoked".to_string()),
        };

        let (config, error) = cycle_archive_config(
            &paths,
            "org_1",
            "collector_1",
            Some((
                "https://archive.example".to_string(),
                Arc::new(MemoryKeyStore::new()),
            )),
            Some(revoked),
        );

        assert_eq!(config.unwrap().policy, ArchivePolicy::Revoked);
        assert_eq!(error, None);
    }

    fn cycle_outcome(
        errors: Vec<ArchiveTargetError>,
        validated_targets: Vec<ArchiveTarget>,
    ) -> CycleOutcome {
        CycleOutcome {
            advanced: 1,
            failed: errors.len() as u32,
            first_error: None,
            setup_error: None,
            archive_setup_error: None,
            archive_connection: Some(archive_identity("org_1", "collector_1")),
            archive_target_errors: errors,
            archive_validated_targets: validated_targets,
            archive_recovered: false,
        }
    }

    fn target_error(
        error_class: &str,
        source: ArchiveSource,
        session: &str,
        part: &str,
    ) -> ArchiveTargetError {
        ArchiveTargetError {
            error_class: error_class.to_string(),
            source,
            source_session_id: session.to_string(),
            source_transcript_part_id: part.to_string(),
        }
    }

    fn validated_target(source: ArchiveSource, session: &str, part: &str) -> ArchiveTarget {
        ArchiveTarget {
            source,
            source_session_id: session.to_string(),
            source_transcript_part_id: part.to_string(),
        }
    }

    fn connected_bus() -> AppStateBus {
        let bus = AppStateBus::new();
        publish_connection(&bus, &saved_connection("org_1", "collector_1"));
        bus
    }

    #[test]
    fn reconnect_restores_scoped_repair_without_running_a_cycle() {
        let bus = connected_bus();
        let mut settings = Settings::default();
        let error = target_error(
            "archive_historical_prefix_changed",
            ArchiveSource::Codex,
            "private-session",
            "codex:part:primary",
        );
        reconcile_archive_repairs(&mut settings, &cycle_outcome(vec![error], Vec::new()));
        publish_archive_repairs(&bus, &settings);

        publish_disconnected(&bus);
        assert_eq!(bus.snapshot().archive.last_error, None);
        publish_connection(&bus, &saved_connection("org_1", "collector_1"));
        publish_archive_refresh(&bus, ArchiveMenuState::default());
        assert_eq!(
            bus.snapshot().archive.last_error.as_deref(),
            Some("Codex archive needs repair")
        );
        assert_eq!(bus.snapshot().sync, SyncStatus::Paused);

        publish_archive_error(&bus, "service unavailable".to_string());
        assert!(!publish_connection(
            &bus,
            &saved_connection("org_1", "collector_1")
        ));
        assert_eq!(
            bus.snapshot().archive.last_error.as_deref(),
            Some("service unavailable")
        );

        publish_connection(&bus, &saved_connection("org_2", "collector_1"));
        assert_eq!(bus.snapshot().archive.last_error, None);
        publish_connection(&bus, &saved_connection("org_1", "collector_2"));
        assert_eq!(bus.snapshot().archive.last_error, None);
        publish_connection(&bus, &saved_connection("org_1", "collector_1"));
        assert_eq!(
            bus.snapshot().archive.last_error.as_deref(),
            Some("Codex archive needs repair")
        );

        let serialized = serde_json::to_value(bus.snapshot()).unwrap();
        assert!(serialized.get("archive_repairs").is_none());
        assert!(!serialized.to_string().contains("private-session"));

        let recovered = cycle_outcome(
            Vec::new(),
            vec![validated_target(
                ArchiveSource::Codex,
                "private-session",
                "codex:part:primary",
            )],
        );
        reconcile_archive_repairs(&mut settings, &recovered);
        update_archive_error_after_cycle(&bus, &settings, &recovered);
        publish_disconnected(&bus);
        publish_connection(&bus, &saved_connection("org_1", "collector_1"));
        assert_eq!(bus.snapshot().archive.last_error, None);
        assert!(bus.snapshot().archive_repairs.is_none());
    }

    #[test]
    fn successful_enrollment_clears_failed_enrollment_error_but_preserves_repair() {
        let bus = connected_bus();
        let mut settings = Settings::default();
        publish_archive_error(&bus, "service unavailable".to_string());
        publish_archive_recovery(&bus, &settings);
        assert_eq!(bus.snapshot().archive.last_error, None);

        let error = target_error(
            "archive_historical_prefix_changed",
            ArchiveSource::Codex,
            "codex-1",
            "codex:part:primary",
        );
        reconcile_archive_repairs(&mut settings, &cycle_outcome(vec![error], Vec::new()));
        publish_archive_error(&bus, "service unavailable".to_string());
        publish_archive_recovery(&bus, &settings);
        assert_eq!(
            bus.snapshot().archive.last_error.as_deref(),
            Some("Codex archive needs repair")
        );
    }

    #[test]
    fn confirmed_policy_recovery_clears_transient_error_but_unconfirmed_cycle_does_not() {
        let bus = connected_bus();
        let settings = Settings::default();
        publish_archive_error(&bus, "archive unavailable".to_string());
        let mut outcome = cycle_outcome(Vec::new(), Vec::new());
        update_archive_error_after_cycle(&bus, &settings, &outcome);
        assert_eq!(
            bus.snapshot().archive.last_error.as_deref(),
            Some("archive unavailable")
        );

        outcome.archive_recovered = true;
        update_archive_error_after_cycle(&bus, &settings, &outcome);
        assert_eq!(bus.snapshot().archive.last_error, None);
    }

    #[test]
    fn missing_repair_target_stays_actionable_across_cycles_and_restart() {
        let bus = connected_bus();
        let mut settings = Settings::default();
        let error = target_error(
            "archive_historical_prefix_changed",
            ArchiveSource::Codex,
            "internal-session-id",
            "codex:part:primary",
        );
        reconcile_archive_repairs(&mut settings, &cycle_outcome(vec![error], Vec::new()));
        publish_archive_repairs(&bus, &settings);
        assert_eq!(
            bus.snapshot().archive.last_error.as_deref(),
            Some("Codex archive needs repair")
        );

        reconcile_archive_repairs(&mut settings, &cycle_outcome(Vec::new(), Vec::new()));
        let dir = TempDir::new().unwrap();
        let file = SettingsFile::at(dir.path());
        file.save(&settings).unwrap();
        let restored = file.load().unwrap();
        publish_archive_repairs(&bus, &restored);
        assert_eq!(
            bus.snapshot().archive.last_error.as_deref(),
            Some("Codex archive needs repair")
        );
    }

    #[test]
    fn actionable_target_is_retained_after_an_unrelated_target_error() {
        let bus = connected_bus();
        let mut settings = Settings::default();
        let errors = vec![
            target_error(
                "archive_io",
                ArchiveSource::Claude,
                "claude-1",
                "claude:part:parent",
            ),
            target_error(
                "archive_historical_prefix_shortened",
                ArchiveSource::Codex,
                "codex-1",
                "codex:part:primary",
            ),
        ];
        reconcile_archive_repairs(&mut settings, &cycle_outcome(errors, Vec::new()));
        publish_archive_repairs(&bus, &settings);
        assert_eq!(
            bus.snapshot().archive.last_error.as_deref(),
            Some("Codex archive needs repair")
        );
        assert_eq!(settings.archive_repairs.unwrap().targets.len(), 1);
    }

    #[test]
    fn another_target_success_does_not_clear_repair() {
        let bus = connected_bus();
        let mut settings = Settings::default();
        let error = target_error(
            "archive_historical_prefix_changed",
            ArchiveSource::Codex,
            "codex-1",
            "codex:part:primary",
        );
        reconcile_archive_repairs(&mut settings, &cycle_outcome(vec![error], Vec::new()));
        reconcile_archive_repairs(
            &mut settings,
            &cycle_outcome(
                Vec::new(),
                vec![validated_target(
                    ArchiveSource::Claude,
                    "claude-1",
                    "claude:part:parent",
                )],
            ),
        );
        publish_archive_repairs(&bus, &settings);
        assert_eq!(
            bus.snapshot().archive.last_error.as_deref(),
            Some("Codex archive needs repair")
        );
    }

    #[test]
    fn exact_target_validation_clears_repair() {
        let bus = connected_bus();
        let mut settings = Settings::default();
        let error = target_error(
            "archive_historical_prefix_changed",
            ArchiveSource::Codex,
            "codex-1",
            "codex:part:primary",
        );
        let target = validated_target(ArchiveSource::Codex, "codex-1", "codex:part:primary");
        reconcile_archive_repairs(
            &mut settings,
            &cycle_outcome(vec![error], vec![target.clone()]),
        );
        publish_archive_repairs(&bus, &settings);
        assert_eq!(
            bus.snapshot().archive.last_error.as_deref(),
            Some("Codex archive needs repair")
        );
        let recovered = cycle_outcome(Vec::new(), vec![target]);
        reconcile_archive_repairs(&mut settings, &recovered);
        update_archive_error_after_cycle(&bus, &settings, &recovered);
        assert_eq!(bus.snapshot().archive.last_error, None);
        assert!(settings.archive_repairs.is_none());
    }

    #[test]
    fn terminal_policy_refreshes_sources_before_reporting_enrollment_failure() {
        let bus = AppStateBus::new();
        bus.update(|state| {
            state.archive.enrolled = true;
            state.archive.sources = vec![(ArchiveSource::Claude, ArchiveHistoryChoice::AllHistory)];
            state.archive.pending = Some(ArchiveSource::Codex);
        });

        publish_archive_refresh(
            &bus,
            ArchiveMenuState {
                enrolled: false,
                reason: Some("revoked".to_string()),
                ..ArchiveMenuState::default()
            },
        );
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

    #[test]
    fn missing_enrollment_keeps_archive_out_of_the_serialized_cycle() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let cfg = sync::load_archive_run_config(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            Arc::new(MemoryKeyStore::new()),
        )
        .unwrap();
        assert!(cfg.is_none());
    }

    #[test]
    fn grace_enrollment_stays_on_the_same_cycle_without_a_second_task() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        enrollment(&paths, "org_1", "grace");
        let cfg = sync::load_archive_run_config(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            Arc::new(MemoryKeyStore::new()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(cfg.policy, ArchivePolicy::Grace);
        assert!(!cfg.spool_dir.exists());
    }

    #[test]
    fn revoked_enrollment_is_wired_into_the_same_cycle() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        enrollment(&paths, "org_1", "revoked");
        let cfg = sync::load_archive_run_config(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            Arc::new(MemoryKeyStore::new()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(cfg.policy, ArchivePolicy::Revoked);
        assert_eq!(cfg.spool_dir, paths.archive_spool_dir("org_1"));
    }

    #[test]
    fn unreadable_policy_with_cleanup_marker_stays_on_the_serialized_cycle() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let enroll = paths.archive_enrollment_file("org_1");
        let spool = paths.archive_spool_dir("org_1");
        let keys = Arc::new(MemoryKeyStore::new());
        let _ = ArchiveSpool::open(&spool, "org_1", keys.as_ref()).unwrap();
        std::fs::write(&enroll, b"{not-json").unwrap();
        std::fs::write(ArchiveSpool::durable_cleanup_marker_path(&spool), b"").unwrap();
        let cfg = sync::load_archive_run_config(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            keys.clone(),
        )
        .unwrap()
        .expect("Desktop must keep Archive work when cleanup-required remains");
        assert_eq!(cfg.policy, ArchivePolicy::Revoked);
        assert!(cleanup_obligation_exists(&spool));
        assert!(keys.load("org_1").unwrap().is_some());
    }

    #[test]
    fn unreadable_policy_without_marker_fails_loud() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        std::fs::write(paths.archive_enrollment_file("org_1"), b"{not-json").unwrap();
        let err = sync::load_archive_run_config(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            Arc::new(MemoryKeyStore::new()),
        )
        .err()
        .expect("Desktop must not drop an unreadable enrollment as inactive");
        assert!(err.to_string().contains("load archive enrollment"));
    }

    #[test]
    fn truncated_policy_status_fails_loud_and_explicit_inactive_stays_inactive() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        enrollment(&paths, "org_1", "enrolle");
        let err = match sync::load_archive_run_config(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            Arc::new(MemoryKeyStore::new()),
        ) {
            Err(err) => err,
            Ok(_) => panic!("truncated status must not look inactive"),
        };
        assert!(err.to_string().contains("load archive enrollment"));
        let (config, load_error) = sync::prepare_serialized_archive(
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
        enrollment(&paths, "org_1", "inactive");
        assert!(sync::load_archive_run_config(
            &paths,
            "org_1",
            "https://archive.example".to_string(),
            Arc::new(MemoryKeyStore::new()),
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn unreadable_policy_without_marker_still_runs_fact_sync() {
        const CLAUDE: &[u8] =
            include_bytes!("../../../../packages/collector-archive/tests/fixtures/claude.jsonl");
        let home = TempDir::new().unwrap();
        let state = TempDir::new().unwrap();
        let claude_dir = home.path().join(".claude").join("projects").join("p1");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(claude_dir.join("claude-session-001.jsonl"), CLAUDE).unwrap();

        let paths = Paths::at(state.path().to_path_buf());
        paths.ensure().unwrap();
        std::fs::write(paths.archive_enrollment_file("org_1"), b"{not-json").unwrap();

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let fact_posts = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let posts = fact_posts.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(8) {
                let Ok(mut stream) = stream else {
                    continue;
                };
                let mut buf = [0u8; 4096];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                posts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let body = r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#;
                let response = format!(
                    "HTTP/1.1 202 Accepted\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = std::io::Write::write_all(&mut stream, response.as_bytes());
            }
        });

        let outcome = run_cycle_blocking(
            archive_identity("org_1", "collector_1"),
            "tfc_secret".to_string(),
            format!("http://{addr}"),
            home.path().to_path_buf(),
            Window::Incremental,
            1_779_840_000_000,
            CycleIsolation {
                state_dir: Some(state.path().to_path_buf()),
                archive: None,
                remembered_denial: None,
            },
        );

        assert!(
            outcome
                .archive_setup_error
                .as_deref()
                .is_some_and(|err| err.contains("load archive enrollment")),
            "Archive diagnostics must stay fail-loud: {:?}",
            outcome.archive_setup_error
        );
        assert!(outcome.setup_error.is_none());
        assert!(
            outcome.advanced >= 1,
            "corrupt Archive policy must not abort fact sync: advanced={}",
            outcome.advanced
        );
        assert!(fact_posts.load(std::sync::atomic::Ordering::SeqCst) >= 1);
        assert!(fact_cycle_reached_ingest(&outcome));
    }

    #[test]
    fn truncated_policy_without_marker_still_runs_fact_sync_and_backfill() {
        const CLAUDE: &[u8] =
            include_bytes!("../../../../packages/collector-archive/tests/fixtures/claude.jsonl");
        let home = TempDir::new().unwrap();
        let state = TempDir::new().unwrap();
        let claude_dir = home.path().join(".claude").join("projects").join("p1");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(claude_dir.join("claude-session-001.jsonl"), CLAUDE).unwrap();

        let paths = Paths::at(state.path().to_path_buf());
        paths.ensure().unwrap();
        enrollment(&paths, "org_1", "enrolle");

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let fact_posts = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let posts = fact_posts.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(8) {
                let Ok(mut stream) = stream else {
                    continue;
                };
                let mut buf = [0u8; 4096];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                posts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let body = r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#;
                let response = format!(
                    "HTTP/1.1 202 Accepted\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = std::io::Write::write_all(&mut stream, response.as_bytes());
            }
        });

        let outcome = run_cycle_blocking(
            archive_identity("org_1", "collector_1"),
            "tfc_secret".to_string(),
            format!("http://{addr}"),
            home.path().to_path_buf(),
            Window::Incremental,
            1_779_840_000_000,
            CycleIsolation {
                state_dir: Some(state.path().to_path_buf()),
                archive: None,
                remembered_denial: None,
            },
        );

        assert!(
            outcome
                .archive_setup_error
                .as_deref()
                .is_some_and(|err| err.contains("load archive enrollment")),
            "truncated policy must stay fail-loud: {:?}",
            outcome.archive_setup_error
        );
        assert!(outcome.setup_error.is_none());
        assert!(outcome.advanced >= 1);
        assert!(fact_posts.load(std::sync::atomic::Ordering::SeqCst) >= 1);
        assert!(fact_cycle_reached_ingest(&outcome));

        let mut settings = Settings {
            syncing: true,
            backfilled: false,
            archive_request: None,
            archive_policy_denial: None,
            archive_repairs: None,
        };
        match (
            apply_authorized_cycle(&mut settings, &outcome),
            sync::window_from_since("7d").unwrap(),
        ) {
            (Window::History(actual), Window::History(expected)) => assert_eq!(actual, expected),
            _ => panic!("first truncated-policy cycle must still use FIRST_BACKFILL"),
        }
        assert!(settings.backfilled);
        assert!(matches!(
            window_for_authorized_cycle(&settings),
            Window::Incremental
        ));
    }

    #[test]
    fn policy_refresh_persists_consent_before_the_serialized_archive_cycle() {
        let home = TempDir::new().unwrap();
        let state = TempDir::new().unwrap();
        let paths = Paths::at(state.path().to_path_buf());
        paths.ensure().unwrap();
        let keys: Arc<dyn ArchiveKeyStore> = Arc::new(MemoryKeyStore::new());

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let read = std::io::Read::read(&mut stream, &mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
            assert!(request.starts_with("get /v1/archive/policy "));
            assert!(request.contains("x-trace-flow-collector-secret: tfc_secret"));

            let body = r#"{"enrolled":true,"authorizedSources":[{"source":"claude","historyChoice":"all_history","authorizedAt":1770000000001}],"reason":null}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            std::io::Write::write_all(&mut stream, response.as_bytes()).unwrap();
        });

        let outcome = run_cycle_blocking(
            archive_identity("org_1", "collector_1"),
            "tfc_secret".to_string(),
            "http://127.0.0.1:1".to_string(),
            home.path().to_path_buf(),
            Window::Incremental,
            1_779_840_000_000,
            CycleIsolation {
                state_dir: Some(state.path().to_path_buf()),
                archive: Some((format!("http://{addr}"), keys.clone())),
                remembered_denial: None,
            },
        );
        server.join().unwrap();

        assert!(outcome.archive_setup_error.is_none());
        let marker = std::fs::read_to_string(paths.archive_enrollment_file("org_1")).unwrap();
        let marker_json: serde_json::Value = serde_json::from_str(&marker).unwrap();
        assert_eq!(marker_json["status"], "enrolled");
        assert_eq!(marker_json["authorizedSources"][0]["source"], "claude");
        assert_eq!(
            marker_json["authorizedSources"][0]["historyChoice"],
            "all_history"
        );
        assert_eq!(
            marker_json["authorizedSources"][0]["authorizedAt"],
            1_770_000_000_001_i64
        );
        assert!(!marker.contains("tfc_secret"));
        assert!(keys.load("org_1").unwrap().is_some());
    }

    #[test]
    fn denial_only_marker_keeps_unavailability_nonfatal_while_facts_sync() {
        const CLAUDE: &[u8] =
            include_bytes!("../../../../packages/collector-archive/tests/fixtures/claude.jsonl");
        let home = TempDir::new().unwrap();
        let state = TempDir::new().unwrap();
        let claude_dir = home.path().join(".claude").join("projects").join("p1");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(claude_dir.join("claude-session-001.jsonl"), CLAUDE).unwrap();
        let paths = Paths::at(state.path().to_path_buf());
        paths.ensure().unwrap();
        enrollment(&paths, "org_1", "grace");
        let marker = std::fs::read(paths.archive_enrollment_file("org_1")).unwrap();

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let fact_posts = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let posts = fact_posts.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(8) {
                let Ok(mut stream) = stream else {
                    continue;
                };
                let mut buf = [0u8; 4096];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                posts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let body = r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#;
                let response = format!(
                    "HTTP/1.1 202 Accepted\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = std::io::Write::write_all(&mut stream, response.as_bytes());
            }
        });

        let outcome = run_cycle_blocking(
            archive_identity("org_1", "collector_1"),
            "tfc_secret".to_string(),
            format!("http://{addr}"),
            home.path().to_path_buf(),
            Window::Incremental,
            1_779_840_000_000,
            CycleIsolation {
                state_dir: Some(state.path().to_path_buf()),
                archive: Some((
                    "http://127.0.0.1:1".to_string(),
                    Arc::new(MemoryKeyStore::new()),
                )),
                remembered_denial: None,
            },
        );

        assert!(outcome.archive_setup_error.is_none());
        assert!(matches!(
            sync_status_from_outcome(&outcome),
            SyncStatus::Idle
        ));
        assert!(outcome.advanced >= 1);
        assert!(fact_posts.load(std::sync::atomic::Ordering::SeqCst) >= 1);
        assert!(fact_cycle_reached_ingest(&outcome));
        assert_eq!(
            std::fs::read(paths.archive_enrollment_file("org_1")).unwrap(),
            marker
        );
    }

    #[test]
    fn deleting_marker_drives_cleanup_without_an_existing_spool() {
        let home = TempDir::new().unwrap();
        let state = TempDir::new().unwrap();
        let paths = Paths::at(state.path().to_path_buf());
        paths.ensure().unwrap();
        let spool_dir = paths.archive_spool_dir("org_1");
        let durable_marker = ArchiveSpool::durable_cleanup_marker_path(&spool_dir);
        let keys: Arc<dyn ArchiveKeyStore> = Arc::new(MemoryKeyStore::new());

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = std::io::Read::read(&mut stream, &mut request).unwrap();
            let body = r#"{"enrolled":false,"authorizedSources":[],"reason":"deleting"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            std::io::Write::write_all(&mut stream, response.as_bytes()).unwrap();
        });

        let outcome = run_cycle_blocking(
            archive_identity("org_1", "collector_1"),
            "tfc_secret".to_string(),
            "http://127.0.0.1:1".to_string(),
            home.path().to_path_buf(),
            Window::Incremental,
            1_779_840_000_000,
            CycleIsolation {
                state_dir: Some(state.path().to_path_buf()),
                archive: Some((format!("http://{addr}"), keys.clone())),
                remembered_denial: None,
            },
        );
        server.join().unwrap();

        assert!(outcome.archive_setup_error.is_none());
        assert!(matches!(
            sync_status_from_outcome(&outcome),
            SyncStatus::Idle
        ));
        let enrollment: serde_json::Value =
            serde_json::from_slice(&std::fs::read(paths.archive_enrollment_file("org_1")).unwrap())
                .unwrap();
        assert_eq!(enrollment["status"], "revoked");
        assert!(!spool_dir.exists());
        assert!(!durable_marker.exists());
        assert!(keys.load("org_1").unwrap().is_none());
    }

    #[test]
    fn archive_offline_does_not_hold_fact_backfill_and_retries_archive() {
        const CLAUDE: &[u8] =
            include_bytes!("../../../../packages/collector-archive/tests/fixtures/claude.jsonl");
        let home = TempDir::new().unwrap();
        let state = TempDir::new().unwrap();
        let settings_dir = TempDir::new().unwrap();
        let claude_dir = home.path().join(".claude").join("projects").join("p1");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(claude_dir.join("claude-session-001.jsonl"), CLAUDE).unwrap();

        let paths = Paths::at(state.path().to_path_buf());
        paths.ensure().unwrap();
        enrollment(&paths, "org_1", "enrolled");
        let keys: Arc<dyn ArchiveKeyStore> = Arc::new(MemoryKeyStore::new());
        let archive_url = "http://127.0.0.1:1".to_string();

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let fact_posts = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let posts = fact_posts.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(8) {
                let Ok(mut stream) = stream else {
                    continue;
                };
                let mut buf = [0u8; 4096];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                posts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let body = r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#;
                let response = format!(
                    "HTTP/1.1 202 Accepted\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = std::io::Write::write_all(&mut stream, response.as_bytes());
            }
        });

        let file = SettingsFile::at(settings_dir.path());
        let mut settings = Settings {
            syncing: true,
            backfilled: false,
            archive_request: None,
            archive_policy_denial: None,
            archive_repairs: None,
        };
        file.save(&settings).unwrap();

        let mut windows = Vec::new();
        for cycle in 1..=3 {
            let window = window_for_authorized_cycle(&settings);
            let outcome = run_cycle_blocking(
                archive_identity("org_1", "collector_1"),
                "tfc_secret".to_string(),
                format!("http://{addr}"),
                home.path().to_path_buf(),
                window,
                1_779_840_000_000,
                CycleIsolation {
                    state_dir: Some(state.path().to_path_buf()),
                    archive: Some((archive_url.clone(), keys.clone())),
                    remembered_denial: None,
                },
            );

            assert!(
                outcome.first_error.is_none(),
                "cycle {cycle}: Archive transport must not fold into fact first_error: {:?}",
                outcome.first_error
            );
            assert!(
                outcome.setup_error.is_none(),
                "cycle {cycle}: {:?}",
                outcome.setup_error
            );
            assert!(
                outcome
                    .archive_setup_error
                    .as_deref()
                    .is_some_and(|err| err.contains("transport")),
                "cycle {cycle}: Archive transport must stay visible: {:?}",
                outcome.archive_setup_error
            );
            assert!(
                outcome.failed >= 1,
                "cycle {cycle}: Archive upload must keep retrying: failed={}",
                outcome.failed
            );
            assert!(
                matches!(
                    sync_status_from_outcome(&outcome),
                    SyncStatus::Error { message } if message.contains("transport")
                ),
                "cycle {cycle}: Archive diagnostic must stay visible in status"
            );
            assert!(
                fact_cycle_reached_ingest(&outcome),
                "cycle {cycle}: successful facts must complete despite Archive transport"
            );
            if cycle == 1 {
                assert!(
                    outcome.advanced >= 1,
                    "first cycle must POST facts: advanced={}",
                    outcome.advanced
                );
                assert!(fact_posts.load(std::sync::atomic::Ordering::SeqCst) >= 1);
            }

            let applied = apply_authorized_cycle(&mut settings, &outcome);
            windows.push(applied);
            persist(&file, &settings);
        }

        match (windows[0], sync::window_from_since("7d").unwrap()) {
            (Window::History(actual), Window::History(expected)) => assert_eq!(actual, expected),
            _ => panic!("cycle 1 must use FIRST_BACKFILL History(Last7Days)"),
        }
        assert!(matches!(windows[1], Window::Incremental));
        assert!(matches!(windows[2], Window::Incremental));
        assert_eq!(fact_posts.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(settings.backfilled);
        assert!(file.load().unwrap().backfilled);
        assert!(settings.syncing);
        assert!(matches!(
            window_for_authorized_cycle(&settings),
            Window::Incremental
        ));
    }

    #[test]
    fn corrupt_archive_policy_completes_fact_backfill_and_next_window_is_incremental() {
        let dir = TempDir::new().unwrap();
        let file = SettingsFile::at(dir.path());
        let mut settings = Settings {
            syncing: true,
            backfilled: false,
            archive_request: None,
            archive_policy_denial: None,
            archive_repairs: None,
        };
        file.save(&settings).unwrap();

        let archive_diag = Some("load archive enrollment".to_string());
        let cycles = [
            CycleOutcome {
                advanced: 1,
                failed: 0,
                first_error: None,
                setup_error: None,
                archive_setup_error: archive_diag.clone(),
                archive_connection: Some(archive_identity("org_1", "collector_1")),
                archive_target_errors: Vec::new(),
                archive_validated_targets: Vec::new(),
                archive_recovered: false,
            },
            CycleOutcome {
                advanced: 0,
                failed: 0,
                first_error: None,
                setup_error: None,
                archive_setup_error: archive_diag.clone(),
                archive_connection: Some(archive_identity("org_1", "collector_1")),
                archive_target_errors: Vec::new(),
                archive_validated_targets: Vec::new(),
                archive_recovered: false,
            },
            CycleOutcome {
                advanced: 0,
                failed: 0,
                first_error: None,
                setup_error: None,
                archive_setup_error: archive_diag,
                archive_connection: Some(archive_identity("org_1", "collector_1")),
                archive_target_errors: Vec::new(),
                archive_validated_targets: Vec::new(),
                archive_recovered: false,
            },
        ];
        let mut windows = Vec::new();
        let mut fact_posts = 0u32;
        for outcome in cycles {
            let window = apply_authorized_cycle(&mut settings, &outcome);
            fact_posts += outcome.advanced;
            windows.push(window);
            persist(&file, &settings);
            assert!(
                matches!(
                    sync_status_from_outcome(&outcome),
                    SyncStatus::Error { message } if message.contains("load archive enrollment")
                ),
                "Archive diagnostic must stay visible"
            );
        }

        match (windows[0], sync::window_from_since("7d").unwrap()) {
            (Window::History(actual), Window::History(expected)) => assert_eq!(actual, expected),
            _ => panic!("cycle 1 must use FIRST_BACKFILL History(Last7Days)"),
        }
        assert!(matches!(windows[1], Window::Incremental));
        assert!(matches!(windows[2], Window::Incremental));
        assert_eq!(fact_posts, 1);
        assert!(settings.backfilled);
        assert!(file.load().unwrap().backfilled);
        assert!(settings.syncing);

        let mut blocked = Settings {
            syncing: true,
            backfilled: false,
            archive_request: None,
            archive_policy_denial: None,
            archive_repairs: None,
        };
        let fatal = CycleOutcome {
            advanced: 0,
            failed: 0,
            first_error: None,
            setup_error: Some("open cursor store".to_string()),
            archive_setup_error: None,
            archive_connection: Some(archive_identity("org_1", "collector_1")),
            archive_target_errors: Vec::new(),
            archive_validated_targets: Vec::new(),
            archive_recovered: false,
        };
        match (
            apply_authorized_cycle(&mut blocked, &fatal),
            sync::window_from_since("7d").unwrap(),
        ) {
            (Window::History(actual), Window::History(expected)) => assert_eq!(actual, expected),
            _ => panic!("failed fact setup must keep FIRST_BACKFILL"),
        }
        assert!(!blocked.backfilled);
        assert!(!fact_cycle_reached_ingest(&fatal));
    }
}

#[cfg(test)]
mod archive_request_tests {
    use super::*;
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
            archive_policy_denial: None,
            archive_repairs: None,
        };
        let expected_settings = settings.clone();
        let mut archive_policy_memory = ArchivePolicyMemory::default();

        enroll_archive_source(
            &bus,
            &settings_file,
            &mut settings,
            &mut archive_policy_memory,
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
                archive_policy_denial: None,
                archive_repairs: None,
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
            archive_policy_denial: None,
            archive_repairs: None,
        };
        assert!(!apply_enrollment_success(&mut settings, false));
        assert!(settings.syncing);
        assert!(settings.archive_request.is_none());
    }
}
