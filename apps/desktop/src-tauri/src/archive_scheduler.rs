// SPDX-License-Identifier: Apache-2.0

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use collector_embedder::connection::Paths;
use collector_embedder::keychain;
use collector_embedder::sources::SourceHomes;
use collector_embedder::sync::{self, ArchiveRunConfig};
use collector_embedder::{
    archive_policy, defaults, ArchiveEnrollmentRecord, ArchiveEnrollmentRequest,
    ArchiveUploadResponse, PreparedArchiveUpload, UploadOutcome,
};
use notify::event::{AccessKind, AccessMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;

use crate::settings::SettingsFile;
use crate::state::AppStateBus;

const RECONCILE_INTERVAL: Duration = Duration::from_secs(5 * 60);
const RETRY_MIN: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(5 * 60);
static SETTINGS_WRITE: Mutex<()> = Mutex::new(());

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

struct ArchiveConnection {
    org_id: String,
    collector_id: String,
    credential: String,
    paths: Paths,
}

struct PolicyOverride {
    org_id: String,
    collector_id: String,
    enrollment: ArchiveEnrollmentRecord,
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

pub async fn enroll_source(
    paths: Paths,
    org_id: String,
    collector_id: String,
    credential: String,
    request: ArchiveEnrollmentRequest,
) -> anyhow::Result<bool> {
    archive_policy::enroll_archive_source(
        &paths,
        &org_id,
        &collector_id,
        defaults::archive_url(),
        &credential,
        &request,
    )
    .await
}

pub fn load_policy(paths: &Paths, org_id: &str) -> anyhow::Result<ArchiveEnrollmentRecord> {
    archive_policy::load_archive_policy(paths, org_id)
}

pub fn save_settings(
    settings_file: &SettingsFile,
    settings: &crate::settings::Settings,
) -> crate::error::Result<()> {
    let _guard = SETTINGS_WRITE.lock().expect("desktop settings write");
    let mut next = settings.clone();
    if let Ok(current) = settings_file.load() {
        next.archive_policy_denial = current.archive_policy_denial;
    }
    settings_file.save(&next)
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
    let mut policy_override = None;
    let mut reconcile = tokio::time::interval(RECONCILE_INTERVAL);
    reconcile.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    reconcile.tick().await;

    loop {
        tokio::select! {
            signal = wake_rx.recv() => {
                if signal.is_none() {
                    break;
                }
                let intent = wake.take_intent();
                if intent.reconcile {
                    if let Some(refreshed) = refresh_policy(&settings_file, &bus).await {
                        policy_override = Some(refreshed);
                    }
                }
                let Some(local) = load_local_archive(
                    &settings_file,
                    &bus,
                    policy_override.as_ref(),
                ) else {
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
                    match start_upload(
                        &settings_file,
                        policy_override.as_ref(),
                        &failed_uploads,
                        upload_tx.clone(),
                        &bus,
                    ).await {
                        UploadStart::Started => upload_in_flight = true,
                        UploadStart::Empty if !failed_uploads.is_empty() => {
                            failed_uploads.clear();
                            retry_at = tokio::time::Instant::now() + jittered(retry_delay);
                            retry_scheduled = true;
                            retry_delay = (retry_delay * 2).min(RETRY_MAX);
                        }
                        UploadStart::Empty | UploadStart::Suspended => {}
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
                match apply_upload_result(
                    &settings_file,
                    policy_override.as_ref(),
                    result,
                    &bus,
                ).await {
                    Ok(UploadOutcome::Advanced) => {
                        retry_delay = RETRY_MIN;
                        retry_at = tokio::time::Instant::now();
                        clear_error(&bus);
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

fn load_local_archive(
    settings_file: &SettingsFile,
    bus: &AppStateBus,
    policy_override: Option<&PolicyOverride>,
) -> Option<LocalArchive> {
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
    let confirmed = policy_override
        .filter(|policy| {
            policy.org_id == connection.org_id && policy.collector_id == connection.collector_id
        })
        .map(|policy| policy.enrollment.clone())
        .or_else(|| {
            settings
                .archive_policy_denial
                .as_ref()
                .filter(|denial| {
                    denial.org_id == connection.org_id
                        && denial.collector_id == connection.collector_id
                })
                .map(|denial| denial.enrollment.clone())
        });
    let (config, error) = prepare_local_archive(
        &paths,
        &connection.org_id,
        &connection.collector_id,
        confirmed,
    );
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

async fn refresh_policy(settings_file: &SettingsFile, bus: &AppStateBus) -> Option<PolicyOverride> {
    let Some(connection) = load_archive_connection(settings_file, bus) else {
        return None;
    };
    let refreshed = archive_policy::refresh_archive_policy(
        &connection.paths,
        &connection.org_id,
        &connection.collector_id,
        defaults::archive_url(),
        &connection.credential,
    )
    .await;
    match refreshed {
        Ok(refreshed) => {
            if let Some(error) = refreshed.persistence_error.as_ref() {
                publish_error(bus, error.clone());
            }
            let Some(confirmed) = refreshed.confirmed else {
                return None;
            };
            let effective = effective_policy(
                settings_file,
                &connection.org_id,
                &connection.collector_id,
                confirmed.clone(),
                refreshed.persisted,
            );
            crate::engine::publish_archive_record(bus, effective.clone(), &connection.collector_id);
            let is_denial = confirmed.policy().is_ok_and(|policy| !policy.captures());
            if is_denial && !refreshed.persisted {
                remember_denial(
                    settings_file,
                    &connection.org_id,
                    &connection.collector_id,
                    confirmed.clone(),
                    bus,
                );
            } else if refreshed.persisted {
                clear_remembered_denial(
                    settings_file,
                    &connection.org_id,
                    &connection.collector_id,
                    bus,
                );
                clear_error(bus);
            }
            Some(PolicyOverride {
                org_id: connection.org_id,
                collector_id: connection.collector_id,
                enrollment: effective,
            })
        }
        Err(error) => {
            publish_error(bus, error.to_string());
            None
        }
    }
}

fn effective_policy(
    settings_file: &SettingsFile,
    org_id: &str,
    collector_id: &str,
    confirmed: ArchiveEnrollmentRecord,
    persisted: bool,
) -> ArchiveEnrollmentRecord {
    if persisted || !confirmed.policy().is_ok_and(|policy| policy.captures()) {
        return confirmed;
    }
    settings_file
        .load()
        .ok()
        .and_then(|settings| settings.archive_policy_denial)
        .filter(|denial| denial.org_id == org_id && denial.collector_id == collector_id)
        .map(|denial| denial.enrollment)
        .unwrap_or(confirmed)
}

fn load_archive_connection(
    settings_file: &SettingsFile,
    bus: &AppStateBus,
) -> Option<ArchiveConnection> {
    match settings_file.load() {
        Ok(settings) if settings.syncing => {}
        Ok(_) => return None,
        Err(error) => {
            publish_error(bus, format!("archive settings: {error}"));
            return None;
        }
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
        Ok(Some(credential)) => credential,
        Ok(None) => return None,
        Err(error) => {
            publish_error(bus, format!("archive keychain: {error}"));
            return None;
        }
    };
    Some(ArchiveConnection {
        org_id: connection.org_id,
        collector_id: connection.collector_id,
        credential,
        paths,
    })
}

fn remember_denial(
    settings_file: &SettingsFile,
    org_id: &str,
    collector_id: &str,
    enrollment: ArchiveEnrollmentRecord,
    bus: &AppStateBus,
) {
    let _guard = SETTINGS_WRITE.lock().expect("desktop settings write");
    let mut settings = match settings_file.load() {
        Ok(settings) => settings,
        Err(error) => {
            publish_error(bus, format!("archive settings: {error}"));
            return;
        }
    };
    settings.archive_policy_denial = Some(crate::settings::ArchivePolicyDenial {
        org_id: org_id.to_string(),
        collector_id: collector_id.to_string(),
        enrollment,
    });
    if let Err(error) = settings_file.save(&settings) {
        publish_error(bus, format!("save archive policy denial: {error}"));
    }
}

fn clear_remembered_denial(
    settings_file: &SettingsFile,
    org_id: &str,
    collector_id: &str,
    bus: &AppStateBus,
) {
    let _guard = SETTINGS_WRITE.lock().expect("desktop settings write");
    let mut settings = match settings_file.load() {
        Ok(settings) => settings,
        Err(error) => {
            publish_error(bus, format!("archive settings: {error}"));
            return;
        }
    };
    if !settings
        .archive_policy_denial
        .as_ref()
        .is_some_and(|denial| denial.org_id == org_id && denial.collector_id == collector_id)
    {
        return;
    }
    settings.archive_policy_denial = None;
    if let Err(error) = settings_file.save(&settings) {
        publish_error(bus, format!("save archive policy denial: {error}"));
    }
}

fn prepare_local_archive(
    paths: &Paths,
    org_id: &str,
    collector_id: &str,
    confirmed: Option<ArchiveEnrollmentRecord>,
) -> (Option<ArchiveRunConfig>, Option<String>) {
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
    match confirmed {
        Some(record) => sync::prepare_desktop_confirmed_archive(paths, org_id, record),
        None => sync::prepare_desktop_serialized_archive(paths, org_id),
    }
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
    settings_file: &SettingsFile,
    policy_override: Option<&PolicyOverride>,
    excluded: &HashSet<String>,
    upload_tx: mpsc::Sender<UploadResult>,
    bus: &AppStateBus,
) -> UploadStart {
    let Some(local) = load_local_archive(settings_file, bus, policy_override) else {
        return UploadStart::Suspended;
    };
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
    // Capture and upload preparation can yield while Pause or Disconnect is persisted.
    let Some(current) = load_local_archive(settings_file, bus, policy_override) else {
        return UploadStart::Suspended;
    };
    if current.org_id != local.org_id {
        return UploadStart::Suspended;
    }
    let Some(credential) = current.credential else {
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
    Suspended,
}

async fn apply_upload_result(
    settings_file: &SettingsFile,
    policy_override: Option<&PolicyOverride>,
    result: UploadResult,
    bus: &AppStateBus,
) -> Result<UploadOutcome, String> {
    let Some(local) = load_local_archive(settings_file, bus, policy_override) else {
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
        match notify::recommended_watcher(move |event: notify::Result<Event>| match event {
            Ok(event) => dispatch_watcher_event(event, &wake),
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

fn dispatch_watcher_event(event: Event, wake: &SchedulerWake) {
    if event.need_rescan() {
        wake.reconcile();
    } else if event_can_change_source(event.kind) {
        wake.changed(event.paths);
    }
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

fn clear_error(bus: &AppStateBus) {
    bus.update(|state| state.archive.last_error = None);
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
    use collector_embedder::sync::ArchivePolicy;
    use collector_embedder::{ArchiveAuthorizedSource, ArchiveHistoryChoice, ArchiveSource};
    use notify::event::Flag;

    fn enrollment(status: ArchivePolicy, collector_id: &str) -> ArchiveEnrollmentRecord {
        ArchiveEnrollmentRecord {
            status: status.as_str().to_string(),
            collector_id: Some(collector_id.to_string()),
            authorized_sources: if status.captures() {
                vec![ArchiveAuthorizedSource {
                    source: ArchiveSource::Claude,
                    history_choice: ArchiveHistoryChoice::AllHistory,
                    authorized_at: 1_770_000_000_001,
                }]
            } else {
                Vec::new()
            },
            reason: None,
        }
    }

    #[tokio::test]
    async fn upload_start_observes_pause_saved_after_capture_began() {
        let directory = tempfile::tempdir().unwrap();
        let settings_file = SettingsFile::at(directory.path());
        let mut settings = crate::settings::Settings {
            syncing: true,
            ..Default::default()
        };
        settings_file.save(&settings).unwrap();
        let capture_settings = settings_file.load().unwrap();
        settings.syncing = false;
        settings_file.save(&settings).unwrap();
        assert!(capture_settings.syncing);

        let (tx, mut rx) = mpsc::channel(1);
        let result = start_upload(
            &settings_file,
            None,
            &HashSet::new(),
            tx,
            &AppStateBus::new(),
        )
        .await;

        assert!(matches!(result, UploadStart::Suspended));
        assert!(rx.try_recv().is_err());
    }

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
    fn rescan_hint_schedules_full_reconcile_without_paths() {
        let (tx, mut rx) = mpsc::channel(1);
        let wake = SchedulerWake {
            tx,
            intent: Arc::new(Mutex::new(CaptureIntent::default())),
        };

        dispatch_watcher_event(Event::new(EventKind::Other).set_flag(Flag::Rescan), &wake);

        assert_eq!(rx.try_recv(), Ok(()));
        let intent = wake.take_intent();
        assert!(intent.capture);
        assert!(intent.reconcile);
        assert!(intent.changed_paths.is_empty());
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

    #[test]
    fn collector_change_rejects_prior_collector_consent() {
        let directory = tempfile::tempdir().unwrap();
        let paths = Paths::at(directory.path().to_path_buf());
        paths.ensure().unwrap();
        enrollment(ArchivePolicy::Enrolled, "collector_old")
            .save_record(&paths.archive_enrollment_file("org_1"))
            .unwrap();

        let (config, error) = prepare_local_archive(&paths, "org_1", "collector_new", None);

        assert!(config.is_none());
        assert!(error.is_none());
        assert!(!paths.archive_spool_dir("org_1").exists());
    }

    #[test]
    fn confirmed_denial_overrides_stale_enrollment() {
        let directory = tempfile::tempdir().unwrap();
        let paths = Paths::at(directory.path().to_path_buf());
        paths.ensure().unwrap();
        enrollment(ArchivePolicy::Enrolled, "collector_1")
            .save_record(&paths.archive_enrollment_file("org_1"))
            .unwrap();

        let (config, error) = prepare_local_archive(
            &paths,
            "org_1",
            "collector_1",
            Some(enrollment(ArchivePolicy::Inactive, "collector_1")),
        );

        assert!(config.is_none());
        assert!(error.is_none());
    }

    #[test]
    fn terminal_revocation_overrides_prior_frozen_policy() {
        let directory = tempfile::tempdir().unwrap();
        let paths = Paths::at(directory.path().to_path_buf());
        paths.ensure().unwrap();
        enrollment(ArchivePolicy::Frozen, "collector_1")
            .save_record(&paths.archive_enrollment_file("org_1"))
            .unwrap();

        let (config, error) = prepare_local_archive(
            &paths,
            "org_1",
            "collector_1",
            Some(enrollment(ArchivePolicy::Revoked, "collector_1")),
        );

        assert_eq!(config.unwrap().policy, ArchivePolicy::Revoked);
        assert!(error.is_none());
    }

    #[test]
    fn failed_denial_persistence_survives_restart() {
        let directory = tempfile::tempdir().unwrap();
        let settings_file = SettingsFile::at(directory.path());
        let bus = AppStateBus::new();
        let denied = enrollment(ArchivePolicy::Inactive, "collector_1");

        remember_denial(&settings_file, "org_1", "collector_1", denied.clone(), &bus);

        let saved = settings_file.load().unwrap().archive_policy_denial.unwrap();
        assert_eq!(saved.org_id, "org_1");
        assert_eq!(saved.collector_id, "collector_1");
        assert_eq!(saved.enrollment, denied);
    }

    #[test]
    fn persisted_refresh_clears_matching_denial() {
        let directory = tempfile::tempdir().unwrap();
        let settings_file = SettingsFile::at(directory.path());
        let bus = AppStateBus::new();
        remember_denial(
            &settings_file,
            "org_1",
            "collector_1",
            enrollment(ArchivePolicy::Inactive, "collector_1"),
            &bus,
        );

        clear_remembered_denial(&settings_file, "org_1", "collector_1", &bus);

        assert!(settings_file
            .load()
            .unwrap()
            .archive_policy_denial
            .is_none());
    }

    #[test]
    fn unpersisted_allowed_refresh_keeps_restart_safe_denial() {
        let directory = tempfile::tempdir().unwrap();
        let settings_file = SettingsFile::at(directory.path());
        let bus = AppStateBus::new();
        remember_denial(
            &settings_file,
            "org_1",
            "collector_1",
            enrollment(ArchivePolicy::Inactive, "collector_1"),
            &bus,
        );

        let effective = effective_policy(
            &settings_file,
            "org_1",
            "collector_1",
            enrollment(ArchivePolicy::Enrolled, "collector_1"),
            false,
        );

        assert_eq!(effective.policy().unwrap(), ArchivePolicy::Inactive);
    }

    #[test]
    fn refresh_for_another_collector_preserves_denial() {
        let directory = tempfile::tempdir().unwrap();
        let settings_file = SettingsFile::at(directory.path());
        let bus = AppStateBus::new();
        remember_denial(
            &settings_file,
            "org_1",
            "collector_old",
            enrollment(ArchivePolicy::Inactive, "collector_old"),
            &bus,
        );

        clear_remembered_denial(&settings_file, "org_1", "collector_new", &bus);

        assert_eq!(
            settings_file
                .load()
                .unwrap()
                .archive_policy_denial
                .unwrap()
                .collector_id,
            "collector_old"
        );
    }
}
