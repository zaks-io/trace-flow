// SPDX-License-Identifier: MIT
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
//! **First-egress gate (TRA-115 AC #2):** the engine starts `paused`. Nothing is read for upload and
//! nothing is POSTed until the user explicitly authorizes it — either `StartSyncing` (resume + one-time
//! backfill) or `SyncNow` (resume + one incremental cycle). Detecting sources (file counts) is
//! read-only and does not require resuming.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use collector_embedder::connection::Paths;
use collector_embedder::keychain;
use collector_embedder::sync::{self, Window};
use tokio::sync::mpsc;

use crate::state::{AppStateBus, ConnectionState, SourceCounts, SyncStatus};

/// How often the engine runs an incremental cycle while resumed.
const TICK: Duration = Duration::from_secs(5 * 60);

/// The default backfill window the first "Start syncing" click triggers.
const FIRST_BACKFILL: &str = "7d";

/// Commands the UI (tray menu or window) sends the engine.
#[derive(Debug, Clone)]
pub enum EngineCommand {
    /// "Start syncing": authorize egress and run the one-time `7d` history backfill, then stay resumed
    /// in incremental watch mode. The backfill runs only once per process; a later `StartSyncing`
    /// (e.g. after a Pause) just resumes incremental watching.
    StartSyncing,
    /// "Sync now": authorize egress if needed and run one incremental cycle immediately, then stay
    /// resumed in watch mode. It unpauses first, so unlike the old run-now path it never silently
    /// no-ops on a paused engine. (Connecting, if not yet connected, happens in the command layer
    /// before this is sent, since the device flow needs a browser + loopback listener.)
    SyncNow,
    /// Resume the loop without forcing a backfill.
    Resume,
    /// Stop all egress; the loop stays alive but does no work until resumed.
    Pause,
    /// Set whether raw-transcript upload is requested on subsequent cycles.
    SetRawUpload(bool),
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
pub fn spawn(bus: AppStateBus) -> EngineHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    tauri::async_runtime::spawn(run_loop(rx, bus));
    EngineHandle { tx }
}

async fn run_loop(mut rx: mpsc::UnboundedReceiver<EngineCommand>, bus: AppStateBus) {
    let mut paused = true;
    let mut raw_upload = false;
    // Whether the one-time history backfill has run this process. `StartSyncing` does the 7d backfill
    // only on the first authorize; later StartSyncing / unpause clicks just resume incremental syncing
    // (cursors would skip already-synced files anyway, but a 7d rescan every unpause is wasteful).
    let mut has_backfilled = false;
    let mut ticker = tokio::time::interval(TICK);
    // The first tick fires immediately; skip it so a paused engine does nothing on startup.
    ticker.tick().await;

    refresh_connection(&bus);
    refresh_sources(&bus);

    loop {
        tokio::select! {
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { break };
                match cmd {
                    EngineCommand::SetRawUpload(value) => {
                        raw_upload = value;
                        bus.update(|s| s.raw_upload = value);
                    }
                    EngineCommand::Pause => {
                        paused = true;
                        bus.update(|s| s.sync = SyncStatus::Paused);
                    }
                    EngineCommand::Resume => {
                        paused = false;
                        set_idle(&bus);
                    }
                    EngineCommand::StartSyncing => {
                        paused = false;
                        let window = if has_backfilled {
                            Window::Incremental
                        } else {
                            sync::window_from_since(FIRST_BACKFILL).unwrap_or(Window::Incremental)
                        };
                        // Only retire the one-time backfill once a cycle actually reached ingest; a
                        // failed first pass keeps the wider history window so the next click retries it.
                        if run_cycle(&bus, raw_upload, window).await && !has_backfilled {
                            has_backfilled = true;
                        }
                    }
                    EngineCommand::SyncNow => {
                        paused = false;
                        let _ = run_cycle(&bus, raw_upload, Window::Incremental).await;
                    }
                }
            }
            _ = ticker.tick() => {
                if !paused {
                    let _ = run_cycle(&bus, raw_upload, Window::Incremental).await;
                }
            }
        }
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
/// Returns `true` only when the cycle actually reached the ingest worker without a setup failure or
/// panic — so a caller (the first backfill) can tell a real pass from a no-op/abort and avoid marking
/// a one-time backfill done when nothing landed.
async fn run_cycle(bus: &AppStateBus, raw_upload: bool, window: Window) -> bool {
    let conn = match Paths::resolve().and_then(|p| p.load_connection()) {
        Ok(Some(conn)) => conn,
        Ok(None) => {
            tracing::warn!("sync skipped: not connected");
            bus.update(|s| s.connection = ConnectionState::Disconnected);
            return false;
        }
        Err(err) => {
            tracing::error!(error = %err, "sync skipped: connection read failed");
            bus.update(|s| {
                s.sync = SyncStatus::Error {
                    message: "connection read failed - sign in again".to_string(),
                }
            });
            return false;
        }
    };

    let ingest_url = match conn.sync_ingest_url() {
        Ok(url) => url,
        Err(err) => {
            tracing::warn!(error = %err, "sync skipped: connection missing ingest URL");
            bus.update(|s| {
                s.connection = ConnectionState::Connected {
                    org_id: conn.org_id.clone(),
                };
                s.sync = SyncStatus::Error {
                    message: "connection missing ingest URL - sign in again".to_string(),
                };
            });
            return false;
        }
    };

    let org_id = conn.org_id.clone();
    bus.update(|s| {
        s.connection = ConnectionState::Connected {
            org_id: org_id.clone(),
        }
    });

    let credential = match keychain::load(&org_id) {
        Ok(Some(secret)) => secret,
        Ok(None) => {
            tracing::warn!("sync skipped: no Collector Credential in keychain");
            bus.update(|s| {
                s.sync = SyncStatus::Error {
                    message: "no credential - sign in again".to_string(),
                }
            });
            return false;
        }
        Err(err) => {
            tracing::error!(error = %err, "sync skipped: keychain read failed");
            bus.update(|s| {
                s.sync = SyncStatus::Error {
                    message: "keychain read failed - sign in again".to_string(),
                }
            });
            return false;
        }
    };

    let Some(home) = dirs_home() else {
        tracing::error!("sync skipped: no home directory");
        return false;
    };

    bus.update(|s| s.sync = SyncStatus::Syncing);

    let now_ms = now_ms();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        run_cycle_blocking(
            org_id, credential, ingest_url, home, window, raw_upload, now_ms,
        )
    })
    .await;

    let reached_ingest = match outcome {
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
            // Retire the one-time backfill only when the pass fully reached ingest: no setup failure
            // (bad client/cursor DB) AND no per-source transport failure. A first pass where every
            // POST failed surfaces as `first_error`, not `setup_error`, and must keep the wider
            // history window so the next attempt retries it instead of silently skipping days-old
            // sessions (whose cursors never advanced).
            let ok = outcome.setup_error.is_none() && outcome.first_error.is_none();
            bus.update(|s| {
                s.last_sync_at = Some(SystemTime::now());
                s.sync = match (&outcome.setup_error, &outcome.first_error) {
                    (Some(err), _) => SyncStatus::Error {
                        message: err.clone(),
                    },
                    (None, Some(err)) if outcome.advanced == 0 => SyncStatus::Error {
                        message: err.clone(),
                    },
                    _ => SyncStatus::Idle,
                };
            });
            ok
        }
        Err(err) => {
            tracing::error!(error = %err, "sync task panicked");
            bus.update(|s| {
                s.sync = SyncStatus::Error {
                    message: "sync task crashed".to_string(),
                }
            });
            false
        }
    };

    refresh_sources(bus);
    reached_ingest
}

/// The non-`Send` half: build a local current-thread runtime and drive one [`sync::run`] on it.
fn run_cycle_blocking(
    org_id: String,
    credential: String,
    ingest_url: String,
    home: std::path::PathBuf,
    window: Window,
    raw_upload: bool,
    now_ms: i64,
) -> CycleOutcome {
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

    let result = runtime.block_on(sync::run(sync::RunConfig {
        ingest_url,
        credential,
        org_id: &org_id,
        home: &home,
        window,
        now_ms,
        raw_upload,
        batch_id_prefix: "desktop",
    }));

    match result {
        Ok(reports) => {
            let mut advanced = 0u32;
            let mut failed = 0u32;
            let mut first_error = None;
            for (_source, r) in &reports {
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
        Ok(Some(conn)) => bus.update(|s| {
            s.connection = ConnectionState::Connected {
                org_id: conn.org_id,
            }
        }),
        Ok(None) => bus.update(|s| s.connection = ConnectionState::Disconnected),
        Err(err) => tracing::warn!(error = %err, "failed to read connection state"),
    }
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
