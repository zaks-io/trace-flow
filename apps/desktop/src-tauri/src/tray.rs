// SPDX-License-Identifier: MIT
// Trace Flow Desktop: the tray icon and its menu-event dispatch.

use tauri::{menu::Menu, tray::TrayIconBuilder, AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::connector::Connector;
use crate::engine::{EngineCommand, EngineHandle};
use crate::error::{DesktopError, Result};
use crate::paths::logs_dir_path;
use crate::state::{AppStateBus, SyncStatus};

const TRAY_ICON_BYTES: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/icons/tray-icon-template.png"
));

/// Build the tray icon with the given (already-built) menu and wire menu-event dispatch.
pub fn build_tray<R: Runtime>(app: &AppHandle<R>, menu: Menu<R>) -> Result<()> {
    let icon = tauri::image::Image::from_bytes(TRAY_ICON_BYTES)
        .map_err(|err| DesktopError::Message(format!("decode tray icon: {err}")))?;

    TrayIconBuilder::with_id("trace-flow-tray")
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Trace Flow Desktop")
        .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()))
        .build(app)
        .map_err(|err| DesktopError::Message(err.to_string()))?;
    Ok(())
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "open_window" => show_window(app),
        // "Sync now": connect if needed, then authorize + run one incremental cycle. Routed through
        // the same smart path as the window's button so the tray never silently no-ops while paused.
        "action_sync" => connect_then(app, EngineCommand::SyncNow),
        "action_reconnect" => reconnect(app),
        // "Start syncing" / "Pause syncing": when paused, connect if needed then backfill + watch;
        // when running, pause.
        "action_pause" => match current_sync(app) {
            SyncStatus::Paused => connect_then(app, EngineCommand::StartSyncing),
            _ => dispatch(app, EngineCommand::Pause),
        },
        "toggle_autostart" => toggle_autostart(app),
        "open_dashboard" => open_dashboard(app),
        "open_logs" => open_logs(app),
        "quit" => app.exit(0),
        other => tracing::debug!(menu_id = other, "unhandled menu event"),
    }
}

fn reconnect<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let bus: tauri::State<'_, AppStateBus> = app.state();
        let connector: tauri::State<'_, Connector> = app.state();
        if let Err(err) = connector.reconnect(&bus).await {
            tracing::error!(error = %err, "tray reconnect failed");
        }
    });
}

/// Drive a sync-authorizing command from the tray: connect if needed (via the shared [`Connector`]
/// seam, which owns the in-flight guard), then send the command. Runs on the async runtime because
/// login blocks on a loopback listener; the tray event handler itself can't await.
fn connect_then<R: Runtime>(app: &AppHandle<R>, cmd: EngineCommand) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let bus: tauri::State<'_, AppStateBus> = app.state();
        let connector: tauri::State<'_, Connector> = app.state();
        if let Err(err) = connector.ensure_connected(&bus).await {
            tracing::error!(error = %err, "tray connect failed");
            return;
        }
        let handle: tauri::State<'_, EngineHandle> = app.state();
        if !handle.send(cmd) {
            tracing::warn!("engine gone; ignoring tray command");
        }
    });
}

fn show_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn dispatch<R: Runtime>(app: &AppHandle<R>, cmd: EngineCommand) {
    let handle: tauri::State<'_, EngineHandle> = app.state();
    if !handle.send(cmd) {
        tracing::warn!("engine gone; ignoring menu command");
    }
}

fn current_sync<R: Runtime>(app: &AppHandle<R>) -> SyncStatus {
    let bus: tauri::State<'_, AppStateBus> = app.state();
    bus.snapshot().sync
}

fn toggle_autostart<R: Runtime>(app: &AppHandle<R>) {
    let was_enabled = match crate::autostart::is_enabled(app) {
        Ok(value) => value,
        Err(err) => {
            // Reading the current state failed; we can't know which way to toggle. Surface it and
            // reconcile the bus from whatever the OS reports next, rather than guessing.
            tracing::error!(error = %err, "autostart: failed to read state before toggle");
            reconcile_autostart(app);
            return;
        }
    };

    let target = !was_enabled;
    let result = if was_enabled {
        crate::autostart::disable(app)
    } else {
        crate::autostart::enable(app)
    };

    match result {
        Ok(()) => tracing::info!(enabled = target, "autostart toggled"),
        // Don't swallow it: log at error (so the tray "Recent error" row shows it) and fall through to
        // reconcile, so the checkbox reflects the real OS state instead of the intended one.
        Err(err) => tracing::error!(error = %err, target, "autostart: toggle failed"),
    }

    reconcile_autostart(app);
}

/// Re-read the autostart state from disk (the source of truth) and publish it to the bus, so a failed
/// or partial toggle leaves the menu checkbox showing reality, never a stale or wished-for value.
fn reconcile_autostart<R: Runtime>(app: &AppHandle<R>) {
    let actual = match crate::autostart::is_enabled(app) {
        Ok(value) => value,
        Err(err) => {
            tracing::error!(error = %err, "autostart: failed to read state");
            return;
        }
    };
    let bus: tauri::State<'_, AppStateBus> = app.state();
    bus.update(|s| s.autostart = actual);
}

fn open_dashboard<R: Runtime>(app: &AppHandle<R>) {
    let url = match std::env::var("TRACE_FLOW_WEB_URL") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => "https://trace-flow.dev/app/agents".to_string(),
    };
    if let Err(err) = app.opener().open_url(url, None::<&str>) {
        tracing::error!(error = %err, "failed to open dashboard");
    }
}

fn open_logs<R: Runtime>(app: &AppHandle<R>) {
    match logs_dir_path(app) {
        Ok(path) => {
            if let Err(err) = app.opener().open_path(path.to_string_lossy(), None::<&str>) {
                tracing::error!(error = %err, "failed to open logs");
            }
        }
        Err(err) => tracing::error!(error = %err, "failed to resolve logs dir"),
    }
}
