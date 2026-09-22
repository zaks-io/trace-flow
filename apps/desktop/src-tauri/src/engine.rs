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
use tokio::sync::mpsc;

use crate::settings::{Settings, SettingsFile};
use crate::state::{AppStateBus, ConnectionState, SourceCounts, SyncStatus};

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
                    EngineCommand::StartSyncing | EngineCommand::SyncNow => {
                        settings.syncing = true;
                        // Persist the authorization before the (possibly long) pass so a quit
                        // mid-backfill still comes back syncing.
                        persist(&settings_file, &settings);
                        run_authorized_cycle(&bus, &mut settings).await;
                    }
                }
                persist(&settings_file, &settings);
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
    let org_id = conn.org_id;
    let cycle_source_homes = source_homes.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_cycle_blocking(
            org_id,
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

fn run_cycle_blocking(
    org_id: String,
    credential: String,
    ingest_url: String,
    home: std::path::PathBuf,
    source_homes: SourceHomes,
    window: Window,
    now_ms: i64,
) -> CycleOutcome {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
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
            for (_source, report) in &outcome.reports {
                advanced += report.advanced;
                failed += report.failed;
                if first_error.is_none() {
                    first_error = report.first_error.clone();
                }
            }
            CycleOutcome {
                advanced,
                failed,
                first_error,
                setup_error: None,
            }
        }
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
        Ok(Some(conn)) => publish_connection(bus, &conn),
        Ok(None) => publish_disconnected(bus),
        Err(err) => tracing::warn!(error = %err, "failed to read connection state"),
    }
}

fn publish_connection(bus: &AppStateBus, connection: &Connection) {
    let next = ConnectionState::Connected {
        org_id: connection.org_id.clone(),
        collector_id: connection.collector_id.clone(),
    };
    bus.update(|state| state.connection = next);
}

fn publish_disconnected(bus: &AppStateBus) {
    bus.update(|state| state.connection = ConnectionState::Disconnected);
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
