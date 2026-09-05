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
//! **First-egress gate (TRA-115 AC #2):** on a fresh install the engine starts `paused`. Nothing is
//! read for upload and nothing is POSTed until the user explicitly authorizes it — either
//! `StartSyncing` (resume + one-time backfill) or `SyncNow` (resume + one incremental cycle).
//! Detecting sources (file counts) is read-only and does not require resuming.
//!
//! That authorization is persisted in [`SettingsFile`] and honoured on relaunch: an app that was
//! syncing when it quit (or was restarted by login autostart) comes back syncing and runs a cycle at
//! once. Before this, every relaunch silently reset to paused and weeks of transcripts went unsynced.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use collector_embedder::connection::Paths;
use collector_embedder::keychain;
use collector_embedder::sync::{self, ArchiveKeyStore, Window};
use tokio::sync::mpsc;

use crate::settings::{Settings, SettingsFile};
use crate::state::{AppStateBus, ConnectionState, SourceCounts, SyncStatus};

/// How often the engine runs an incremental cycle while resumed.
const TICK: Duration = Duration::from_secs(5 * 60);

/// The default backfill window the first "Start syncing" click triggers.
const FIRST_BACKFILL: &str = "7d";

/// Commands the UI (tray menu or window) sends the engine.
#[derive(Debug, Clone)]
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
                    let before = settings;
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
    if let Some(outcome) = run_cycle(bus, window).await {
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
async fn run_cycle(bus: &AppStateBus, window: Window) -> Option<CycleOutcome> {
    let conn = match Paths::resolve().and_then(|p| p.load_connection()) {
        Ok(Some(conn)) => conn,
        Ok(None) => {
            tracing::warn!("sync skipped: not connected");
            bus.update(|s| s.connection = ConnectionState::Disconnected);
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
            bus.update(|s| {
                s.connection = ConnectionState::Connected {
                    org_id: conn.org_id.clone(),
                };
                s.sync = SyncStatus::Error {
                    message: "connection missing ingest URL - sign in again".to_string(),
                };
            });
            return None;
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
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        run_cycle_blocking(
            org_id,
            credential,
            ingest_url,
            home,
            window,
            now_ms,
            CycleIsolation::production(),
        )
    })
    .await;

    let outcome = match outcome {
        Ok(outcome) => {
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
                s.archive_error = outcome.archive_setup_error.clone();
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
    outcome
}

/// Test isolation for collector state and Archive inputs. Production leaves both `None`.
struct CycleIsolation {
    state_dir: Option<std::path::PathBuf>,
    archive: Option<(String, Arc<dyn ArchiveKeyStore>)>,
}

impl CycleIsolation {
    fn production() -> Self {
        Self {
            state_dir: None,
            archive: None,
        }
    }
}

/// Load Archive inputs for this serialized cycle. Inactive enrollment stays `None` so no spool or
/// key is created. Frozen/grace/revoked keep the existing local archive state without a second task.
/// Cleanup markers keep Archive on the cycle even when enrollment is unreadable. Parse failures
/// without a marker stay fail-loud in the error string but do not abort parsed-fact sync.
fn cycle_archive_config(
    org_id: &str,
    state_dir: Option<&std::path::Path>,
    archive: Option<(String, Arc<dyn ArchiveKeyStore>)>,
) -> (Option<sync::ArchiveRunConfig>, Option<String>) {
    let paths = match state_dir {
        Some(dir) => Paths::at(dir.to_path_buf()),
        None => match Paths::resolve() {
            Ok(paths) => paths,
            Err(err) => return (None, Some(format!("resolve collector paths: {err}"))),
        },
    };
    let _ = paths.ensure();
    match archive {
        Some((url, keys)) => sync::prepare_serialized_archive(&paths, org_id, url, keys),
        None => sync::prepare_desktop_serialized_archive(&paths, org_id),
    }
}

/// The non-`Send` half: build a local current-thread runtime and drive one [`sync::run`] on it.
fn run_cycle_blocking(
    org_id: String,
    credential: String,
    ingest_url: String,
    home: std::path::PathBuf,
    window: Window,
    now_ms: i64,
    isolation: CycleIsolation,
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
                archive_setup_error: None,
            };
        }
    };

    let (archive, mut archive_setup_error) =
        cycle_archive_config(&org_id, isolation.state_dir.as_deref(), isolation.archive);
    let result = runtime.block_on(sync::run_detailed(sync::RunConfig {
        ingest_url,
        credential,
        org_id: &org_id,
        home: &home,
        window,
        now_ms,
        batch_id_prefix: "desktop",
        archive,
        state_dir: isolation.state_dir.as_deref(),
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
            if let Some(archive) = &outcome.archive {
                failed += archive.failed;
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
            }
        }
        // Setup failure (bad client config, broken cursor DB). The Display is a class, not a secret.
        Err(err) => CycleOutcome {
            advanced: 0,
            failed: 0,
            first_error: None,
            setup_error: Some(err.to_string()),
            archive_setup_error: None,
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
        std::fs::write(
            paths.archive_enrollment_file(org_id),
            format!(r#"{{"status":"{status}"}}"#),
        )
        .unwrap();
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
            "org_1".to_string(),
            "tfc_secret".to_string(),
            format!("http://{addr}"),
            home.path().to_path_buf(),
            Window::Incremental,
            1_779_840_000_000,
            CycleIsolation {
                state_dir: Some(state.path().to_path_buf()),
                archive: None,
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
            "org_1".to_string(),
            "tfc_secret".to_string(),
            format!("http://{addr}"),
            home.path().to_path_buf(),
            Window::Incremental,
            1_779_840_000_000,
            CycleIsolation {
                state_dir: Some(state.path().to_path_buf()),
                archive: None,
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
        };
        file.save(&settings).unwrap();

        let mut windows = Vec::new();
        for cycle in 1..=3 {
            let window = window_for_authorized_cycle(&settings);
            let outcome = run_cycle_blocking(
                "org_1".to_string(),
                "tfc_secret".to_string(),
                format!("http://{addr}"),
                home.path().to_path_buf(),
                window,
                1_779_840_000_000,
                CycleIsolation {
                    state_dir: Some(state.path().to_path_buf()),
                    archive: Some((archive_url.clone(), keys.clone())),
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
                matches!(sync_status_from_outcome(&outcome), SyncStatus::Idle),
                "cycle {cycle}: archive-only transport failure must not stop fact sync"
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
            },
            CycleOutcome {
                advanced: 0,
                failed: 0,
                first_error: None,
                setup_error: None,
                archive_setup_error: archive_diag.clone(),
            },
            CycleOutcome {
                advanced: 0,
                failed: 0,
                first_error: None,
                setup_error: None,
                archive_setup_error: archive_diag,
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
                matches!(sync_status_from_outcome(&outcome), SyncStatus::Idle),
                "archive-only failure must not stop fact sync"
            );
            assert!(
                outcome
                    .archive_setup_error
                    .as_deref()
                    .is_some_and(|message| message.contains("load archive enrollment")),
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
        };
        let fatal = CycleOutcome {
            advanced: 0,
            failed: 0,
            first_error: None,
            setup_error: Some("open cursor store".to_string()),
            archive_setup_error: None,
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
