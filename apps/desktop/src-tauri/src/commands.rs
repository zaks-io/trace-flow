// SPDX-License-Identifier: MIT
// Trace Flow Desktop: the Tauri command surface the first-run/settings window invokes.

//! The IPC the window calls. Every command is a thin wrapper over `collector-embedder` + the
//! [`crate::engine`]; no business logic lives here. Returned DTOs never carry a secret (no credential,
//! no transcript text, no absolute home path).

use collector_embedder::connection::Paths;
use collector_embedder::keychain;
use collector_embedder::sources::{self, Support};
use serde::Serialize;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

use crate::connector::Connector;
use crate::engine::{self, EngineCommand, EngineHandle};
use crate::logging::ErrorRing;
use crate::state::AppStateBus;

/// How many recent warn/error lines the diagnostics view shows.
const RECENT_ERROR_LIMIT: usize = 10;

/// One detected source row for the first-run UI. `location` is a $HOME-free label.
#[derive(Debug, Serialize)]
pub struct DetectedSourceDto {
    pub source: String,
    pub supported: bool,
    pub location: String,
    pub file_count: usize,
}

/// Connection + per-source snapshot for the window. No secrets.
#[derive(Debug, Serialize)]
pub struct StatusDto {
    pub connected: bool,
    pub org_id: Option<String>,
    pub credential_present: bool,
    pub expired: bool,
    pub raw_upload: bool,
    pub sync: String,
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn home() -> Result<std::path::PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "could not resolve home directory".to_string())
}

/// Whether a connection exists on disk (used by setup to decide whether to show the first-run window).
/// Not a command — called from the Rust setup hook.
pub fn is_connected() -> bool {
    Paths::resolve()
        .ok()
        .and_then(|p| p.load_connection().ok().flatten())
        .is_some()
}

#[tauri::command]
pub fn detect_sources() -> Result<Vec<DetectedSourceDto>, String> {
    let home = home()?;
    let detected = sources::detect(&home);
    Ok(detected
        .into_iter()
        .map(|d| DetectedSourceDto {
            source: source_label(d.source).to_string(),
            supported: matches!(d.support, Support::Ready),
            location: d.display_root().to_string(),
            file_count: d.file_count,
        })
        .collect())
}

#[tauri::command]
pub fn connection_status(bus: State<'_, AppStateBus>) -> StatusDto {
    let snapshot = bus.snapshot();
    let conn = Paths::resolve()
        .ok()
        .and_then(|p| p.load_connection().ok().flatten());
    let (connected, org_id, credential_present, expired) = match conn {
        Some(c) => {
            let present = keychain::is_present(&c.org_id);
            let expired = c.expires_at <= now_ms();
            (true, Some(c.org_id), present, expired)
        }
        None => (false, None, false, false),
    };
    StatusDto {
        connected,
        org_id,
        credential_present,
        expired,
        raw_upload: snapshot.raw_upload,
        sync: snapshot.sync.label().to_string(),
    }
}

/// Run the browser device flow (the window's explicit "Connect" button). Goes through the shared
/// [`Connector`] seam so it shares the in-flight guard with the sync buttons and the tray. Returns the
/// connected org id for the UI.
#[tauri::command]
pub async fn start_login(
    bus: State<'_, AppStateBus>,
    connector: State<'_, Connector>,
) -> Result<String, String> {
    connector.ensure_connected(&bus).await?;
    connection_status(bus)
        .org_id
        .ok_or_else(|| "connected but no org id on disk".to_string())
}

#[tauri::command]
pub fn set_raw_upload(value: bool, handle: State<'_, EngineHandle>) {
    handle.send(EngineCommand::SetRawUpload(value));
}

/// "Start syncing": connect if needed, then run the one-time 7d backfill and drop into incremental
/// watch mode. Connecting goes through the shared [`Connector`], so a single click from a fresh install
/// does the whole thing.
#[tauri::command]
pub async fn start_syncing(
    bus: State<'_, AppStateBus>,
    handle: State<'_, EngineHandle>,
    connector: State<'_, Connector>,
) -> Result<(), String> {
    connector.ensure_connected(&bus).await?;
    handle.send(EngineCommand::StartSyncing);
    Ok(())
}

#[tauri::command]
pub fn pause(handle: State<'_, EngineHandle>) {
    handle.send(EngineCommand::Pause);
}

#[tauri::command]
pub fn resume(handle: State<'_, EngineHandle>) {
    handle.send(EngineCommand::Resume);
}

/// "Sync now": make it work, then sync. Connects if needed (via the shared [`Connector`]), then tells
/// the engine to authorize egress and run one incremental cycle. One click does whatever's needed;
/// login failures surface to the caller and the engine handles the sync from there.
#[tauri::command]
pub async fn run_sync(
    bus: State<'_, AppStateBus>,
    handle: State<'_, EngineHandle>,
    connector: State<'_, Connector>,
) -> Result<(), String> {
    connector.ensure_connected(&bus).await?;
    handle.send(EngineCommand::SyncNow);
    Ok(())
}

#[tauri::command]
pub fn disconnect(bus: State<'_, AppStateBus>) -> Result<(), String> {
    let paths = Paths::resolve().map_err(|e| format!("{e:#}"))?;
    if let Some(conn) = paths.load_connection().map_err(|e| format!("{e:#}"))? {
        keychain::delete(&conn.org_id).map_err(|e| format!("{e:#}"))?;
        paths
            .clear_connection(&conn.org_id)
            .map_err(|e| format!("{e:#}"))?;
    }
    engine::refresh_connection(&bus);
    Ok(())
}

/// One recent warn/error line for the diagnostics view. Operational only — never a secret.
#[derive(Debug, Serialize)]
pub struct RecentErrorDto {
    pub level: String,
    pub message: String,
}

/// The recent warn/error ring, newest first. Lets the window export diagnostics without opening logs.
#[tauri::command]
pub fn recent_errors(ring: State<'_, ErrorRing>) -> Vec<RecentErrorDto> {
    ring.snapshot(RECENT_ERROR_LIMIT)
        .into_iter()
        .map(|e| RecentErrorDto {
            level: e.level,
            message: e.message,
        })
        .collect()
}

/// Clear the recent-errors ring after the user has reviewed/exported it.
#[tauri::command]
pub fn clear_errors(ring: State<'_, ErrorRing>) {
    ring.clear();
}

#[tauri::command]
pub fn open_dashboard<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    let url = dashboard_url();
    if let Err(err) = app.opener().open_url(url, None::<&str>) {
        tracing::error!(error = %err, "failed to open dashboard");
    }
}

fn dashboard_url() -> String {
    match std::env::var("TRACE_FLOW_WEB_URL") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => "https://trace-flow.dev/app/agents".to_string(),
    }
}

fn source_label(source: collector_contracts::AgentSource) -> &'static str {
    match source {
        collector_contracts::AgentSource::Claude => "claude",
        collector_contracts::AgentSource::Codex => "codex",
        collector_contracts::AgentSource::Cursor => "cursor",
    }
}
