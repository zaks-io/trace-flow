// SPDX-License-Identifier: Apache-2.0

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use collector_embedder::connection::Paths;
use collector_embedder::keychain;
use collector_embedder::sources::SourceHomes;
use collector_embedder::sync::{self, ArchiveRunConfig};
use collector_embedder::{ArchiveUploadResponse, PreparedArchiveUpload, UploadOutcome};
use notify::event::{AccessKind, AccessMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;

use crate::settings::SettingsFile;
use crate::state::AppStateBus;

const RECONCILE_INTERVAL: Duration = Duration::from_secs(5 * 60);
const RETRY_MIN: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(5 * 60);

#[derive(Clone)]
pub struct ArchiveSchedulerHandle {
    wake: SchedulerWake,
}

impl ArchiveSchedulerHandle {
    pub fn wake(&self) {
        self.wake.reconcile();
    }
}

#[derive(Clone)]
struct SchedulerWake {
    tx: mpsc::Sender<()>,
    intent: Arc<Mutex<CaptureIntent>>,
}

#[derive(Default)]
struct CaptureIntent {
    capture: bool,
    reconcile: bool,
    changed_paths: HashSet<PathBuf>,
}

impl SchedulerWake {
    fn capture(&self) {
        self.intent.lock().expect("archive capture intent").capture = true;
        let _ = self.tx.try_send(());
    }

    fn reconcile(&self) {
        let mut intent = self.intent.lock().expect("archive capture intent");
        intent.capture = true;
        intent.reconcile = true;
        drop(intent);
        let _ = self.tx.try_send(());
    }

    fn changed(&self, paths: Vec<PathBuf>) {
        let mut intent = self.intent.lock().expect("archive capture intent");
        intent.capture = true;
        intent.changed_paths.extend(paths);
        drop(intent);
        let _ = self.tx.try_send(());
    }

    fn take_intent(&self) -> CaptureIntent {
        std::mem::take(&mut *self.intent.lock().expect("archive capture intent"))
    }

    fn restore_intent(&self, restored: CaptureIntent) {
        let mut intent = self.intent.lock().expect("archive capture intent");
        intent.capture |= restored.capture;
        intent.reconcile |= restored.reconcile;
        intent.changed_paths.extend(restored.changed_paths);
    }

    fn drain(&self) {
        let _ = self.tx.try_send(());
    }
}

struct UploadResult {
    org_id: String,
    prepared: PreparedArchiveUpload,
    response: ArchiveUploadResponse,
}

struct LocalArchive {
    org_id: String,
    credential: Option<String>,
    homes: SourceHomes,
    config: ArchiveRunConfig,
}

pub fn spawn(settings_file: SettingsFile, bus: AppStateBus) -> ArchiveSchedulerHandle {
    let (wake_tx, wake_rx) = mpsc::channel(1);
    let wake = SchedulerWake {
        tx: wake_tx,
        intent: Arc::new(Mutex::new(CaptureIntent::default())),
    };
    tauri::async_runtime::spawn(run(wake_rx, wake.clone(), settings_file, bus));
    wake.reconcile();
    ArchiveSchedulerHandle { wake }
}

async fn run(
    mut wake_rx: mpsc::Receiver<()>,
    wake: SchedulerWake,
    settings_file: SettingsFile,
    bus: AppStateBus,
) {
    let mut watcher: Option<RecommendedWatcher> = None;
    let mut watched_roots = HashSet::new();
    let (upload_tx, mut upload_rx) = mpsc::channel(1);
    let mut upload_in_flight = false;
    let mut retry_delay = RETRY_MIN;
    let mut retry_at = tokio::time::Instant::now();
    let mut retry_scheduled = false;
    let mut failed_uploads = HashSet::new();
    let mut reconcile = tokio::time::interval(RECONCILE_INTERVAL);
    reconcile.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            signal = wake_rx.recv() => {
                if signal.is_none() {
                    break;
                }
                let intent = wake.take_intent();
                let Some(local) = load_local_archive(&settings_file, &bus) else {
                    wake.restore_intent(intent);
                    continue;
                };
                if intent.capture {
                    let current_roots = watch_targets(&local.homes);
                    if watcher.is_none() || current_roots != watched_roots {
                        let (next_watcher, watched) =
                            start_watcher(&local.homes, wake.clone(), bus.clone());
                        watcher = next_watcher;
                        watched_roots = watched;
                    }
                    if capture(&local, &bus, intent.reconcile, intent.changed_paths).await {
                        wake.capture();
                    }
                }
                if !upload_in_flight && tokio::time::Instant::now() >= retry_at {
                    match start_upload(local, &failed_uploads, upload_tx.clone(), &bus).await {
                        UploadStart::Started => upload_in_flight = true,
                        UploadStart::Empty if !failed_uploads.is_empty() => {
                            failed_uploads.clear();
                            retry_at = tokio::time::Instant::now() + jittered(retry_delay);
                            retry_scheduled = true;
                            retry_delay = (retry_delay * 2).min(RETRY_MAX);
                        }
                        UploadStart::Empty => {}
                        UploadStart::Failed => {
                            retry_at = tokio::time::Instant::now() + jittered(retry_delay);
                            retry_scheduled = true;
                            retry_delay = (retry_delay * 2).min(RETRY_MAX);
                        }
                    }
                }
            }
            _ = reconcile.tick() => {
                wake.reconcile();
            }
            Some(result) = upload_rx.recv() => {
                upload_in_flight = false;
                let upload_id = result.prepared.id();
                match apply_upload_result(&settings_file, result, &bus).await {
                    Ok(UploadOutcome::Advanced) => {
                        retry_delay = RETRY_MIN;
                        retry_at = tokio::time::Instant::now();
                        wake.drain();
                    }
                    Ok(UploadOutcome::Blocked) => {
                        retry_at = tokio::time::Instant::now();
                        wake.drain();
                    }
                    Ok(UploadOutcome::Frozen | UploadOutcome::Halt(_)) => {
                        retry_at = tokio::time::Instant::now() + jittered(retry_delay);
                        retry_scheduled = true;
                        retry_delay = (retry_delay * 2).min(RETRY_MAX);
                    }
                    Ok(UploadOutcome::Purged) => {}
                    Err(error) => {
                        publish_error(&bus, error);
                        failed_uploads.insert(upload_id);
                        retry_at = tokio::time::Instant::now();
                        wake.drain();
                    }
                }
            }
            _ = tokio::time::sleep_until(retry_at), if retry_scheduled => {
                retry_scheduled = false;
                wake.drain();
            }
        }
    }
    drop(watcher);
}

fn load_local_archive(settings_file: &SettingsFile, bus: &AppStateBus) -> Option<LocalArchive> {
    let mut settings = match settings_file.load() {
        Ok(settings) if settings.syncing => settings,
        Ok(_) => return None,
        Err(error) => {
            publish_error(bus, format!("archive settings: {error}"));
            return None;
        }
    };
    if let Some(home) = dirs_home() {
        settings.source_homes.merge(&SourceHomes::resolve(&home));
    }
    let paths = match Paths::resolve() {
        Ok(paths) => paths,
        Err(error) => {
            publish_error(bus, format!("archive paths: {error}"));
            return None;
        }
    };
    let connection = match paths.load_connection() {
        Ok(Some(connection)) => connection,
        Ok(None) => return None,
        Err(error) => {
            publish_error(bus, format!("archive connection: {error}"));
            return None;
        }
    };
    let credential = match keychain::load(&connection.org_id) {
        Ok(credential) => credential,
        Err(error) => {
            publish_error(bus, format!("archive keychain: {error}"));
            return None;
        }
    };
    let remembered_denial = settings.archive_policy_denial.as_ref().filter(|denial| {
        denial.org_id == connection.org_id && denial.collector_id == connection.collector_id
    });
    let (config, error) = match remembered_denial {
        Some(denial) => sync::prepare_desktop_confirmed_archive(
            &paths,
            &connection.org_id,
            denial.enrollment.clone(),
        ),
        None => sync::prepare_desktop_serialized_archive(&paths, &connection.org_id),
    };
    if let Some(error) = error {
        publish_error(bus, error);
    }
    config.map(|config| LocalArchive {
        org_id: connection.org_id,
        credential,
        homes: settings.source_homes,
        config,
    })
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

async fn capture(
    local: &LocalArchive,
    bus: &AppStateBus,
    reconcile: bool,
    changed_paths: HashSet<PathBuf>,
) -> bool {
    let org_id = local.org_id.clone();
    let homes = local.homes.clone();
    let config = local.config.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        if reconcile {
            sync::capture_archive_local(&config, &org_id, &homes, now_ms())
        } else {
            sync::capture_archive_local_incremental(
                &config,
                &org_id,
                &homes,
                now_ms(),
                &changed_paths,
            )
        }
    })
    .await
    {
        Ok(report) if report.first_error.is_none() => return report.captured > 0,
        Ok(report) => publish_error(
            bus,
            report
                .first_error
                .unwrap_or_else(|| "archive capture failed".to_string()),
        ),
        Err(_) => publish_error(bus, "archive capture task crashed".to_string()),
    }
    false
}

async fn start_upload(
    local: LocalArchive,
    excluded: &HashSet<String>,
    upload_tx: mpsc::Sender<UploadResult>,
    bus: &AppStateBus,
) -> UploadStart {
    let org_id = local.org_id.clone();
    let config = local.config.clone();
    let excluded = excluded.clone();
    let prepared = match tauri::async_runtime::spawn_blocking(move || {
        sync::prepare_archive_upload(&config, &org_id, &excluded)
    })
    .await
    {
        Ok(Ok(Some(prepared))) => prepared,
        Ok(Ok(None)) => return UploadStart::Empty,
        Ok(Err(error)) => {
            publish_error(bus, error.to_string());
            return UploadStart::Failed;
        }
        Err(_) => {
            publish_error(bus, "archive upload preparation crashed".to_string());
            return UploadStart::Failed;
        }
    };
    let Some(credential) = local.credential else {
        publish_error(bus, "no credential - sign in again".to_string());
        return UploadStart::Failed;
    };
    tauri::async_runtime::spawn(async move {
        let response =
            sync::send_archive_upload(local.config.archive_url, credential, &prepared).await;
        let _ = upload_tx
            .send(UploadResult {
                org_id: local.org_id,
                prepared,
                response,
            })
            .await;
    });
    UploadStart::Started
}

enum UploadStart {
    Started,
    Empty,
    Failed,
}

async fn apply_upload_result(
    settings_file: &SettingsFile,
    result: UploadResult,
    bus: &AppStateBus,
) -> Result<UploadOutcome, String> {
    let Some(local) = load_local_archive(settings_file, bus) else {
        return Err("archive state changed before acknowledgement".to_string());
    };
    if local.org_id != result.org_id {
        return Err("archive connection changed before acknowledgement".to_string());
    }
    let config = local.config.clone();
    tauri::async_runtime::spawn_blocking(move || {
        sync::apply_archive_upload(&config, &result.org_id, &result.prepared, result.response)
            .map_err(str::to_string)
    })
    .await
    .map_err(|_| "archive acknowledgement task crashed".to_string())?
}

fn start_watcher(
    homes: &SourceHomes,
    wake: SchedulerWake,
    bus: AppStateBus,
) -> (Option<RecommendedWatcher>, HashSet<PathBuf>) {
    let event_bus = bus.clone();
    let mut watcher =
        match notify::recommended_watcher(move |event: notify::Result<notify::Event>| match event {
            Ok(event) if event_can_change_source(event.kind) => wake.changed(event.paths),
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(error = %error, "archive watcher event failed");
                publish_error(&event_bus, "archive watcher unavailable".to_string());
            }
        }) {
            Ok(watcher) => watcher,
            Err(error) => {
                tracing::warn!(error = %error, "archive watcher unavailable");
                publish_error(&bus, "archive watcher unavailable".to_string());
                return (None, HashSet::new());
            }
        };
    let mut watched = HashSet::new();
    for root in watch_targets(homes) {
        match watcher.watch(&root, RecursiveMode::Recursive) {
            Ok(()) => {
                watched.insert(root);
            }
            Err(error) => {
                tracing::warn!(error = %error, "archive root watcher unavailable");
                publish_error(&bus, "archive watcher unavailable".to_string());
            }
        }
    }
    (Some(watcher), watched)
}

fn event_can_change_source(kind: EventKind) -> bool {
    match kind {
        EventKind::Access(AccessKind::Read | AccessKind::Open(_)) => false,
        EventKind::Access(AccessKind::Close(mode)) => mode == AccessMode::Write,
        EventKind::Access(AccessKind::Any | AccessKind::Other) => true,
        _ => true,
    }
}

fn watch_targets(homes: &SourceHomes) -> HashSet<PathBuf> {
    let mut targets = HashSet::new();
    for home in &homes.claude_config_dirs {
        add_watch_targets(&mut targets, home, &["projects"]);
    }
    for home in &homes.codex_homes {
        add_watch_targets(&mut targets, home, &["sessions", "archived_sessions"]);
    }
    targets
}

fn add_watch_targets(targets: &mut HashSet<PathBuf>, home: &Path, children: &[&str]) {
    let roots = children
        .iter()
        .map(|child| home.join(child))
        .collect::<Vec<_>>();
    if roots.iter().any(|root| !root.exists()) && home.exists() {
        targets.insert(home.to_path_buf());
    } else {
        for root in roots.into_iter().filter(|root| root.exists()) {
            targets.insert(root);
        }
    }
}

fn publish_error(bus: &AppStateBus, error: String) {
    tracing::warn!(error = %error, "archive scheduler failed");
    bus.update(|state| state.archive.last_error = Some(error));
}

fn jittered(base: Duration) -> Duration {
    let mut byte = [0u8; 1];
    let _ = getrandom::fill(&mut byte);
    let percent = 75 + u64::from(byte[0]) * 50 / 255;
    Duration::from_millis((base.as_millis() as u64).saturating_mul(percent) / 100)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_intent_survives_a_full_wake_channel() {
        let (tx, mut rx) = mpsc::channel(1);
        let wake = SchedulerWake {
            tx,
            intent: Arc::new(Mutex::new(CaptureIntent::default())),
        };

        wake.drain();
        wake.capture();

        assert_eq!(rx.try_recv(), Ok(()));
        assert!(wake.take_intent().capture);
    }

    #[test]
    fn read_only_watcher_events_do_not_schedule_capture() {
        assert!(!event_can_change_source(EventKind::Access(
            AccessKind::Open(AccessMode::Read,)
        )));
        assert!(!event_can_change_source(EventKind::Access(
            AccessKind::Read
        )));
        assert!(!event_can_change_source(EventKind::Access(
            AccessKind::Close(AccessMode::Read,)
        )));
        assert!(event_can_change_source(EventKind::Access(
            AccessKind::Close(AccessMode::Write,)
        )));
        assert!(event_can_change_source(EventKind::Modify(
            notify::event::ModifyKind::Any,
        )));
    }

    #[test]
    fn drain_wake_does_not_consume_changed_paths() {
        let (tx, mut rx) = mpsc::channel(1);
        let wake = SchedulerWake {
            tx,
            intent: Arc::new(Mutex::new(CaptureIntent::default())),
        };
        let changed = PathBuf::from("/agent/session.jsonl");

        wake.drain();
        wake.changed(vec![changed.clone()]);

        assert_eq!(rx.try_recv(), Ok(()));
        let intent = wake.take_intent();
        assert!(intent.capture);
        assert_eq!(intent.changed_paths, HashSet::from([changed]));
    }

    #[test]
    fn missing_transcript_root_watches_existing_agent_home() {
        let temp = tempfile::tempdir().unwrap();
        let claude = temp.path().join(".claude");
        std::fs::create_dir(&claude).unwrap();
        let homes = SourceHomes {
            claude_config_dirs: vec![claude.clone()],
            codex_homes: Vec::new(),
        };

        assert_eq!(watch_targets(&homes), HashSet::from([claude]));
    }
}
