// SPDX-License-Identifier: Apache-2.0
// Trace Flow Desktop: the tray icon and its menu-event dispatch.

use tauri::{menu::Menu, tray::TrayIconBuilder, AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::connector::Connector;
use crate::engine::{EngineCommand, EngineHandle};
use crate::error::{DesktopError, Result};
use crate::paths::logs_dir_path;
use crate::state::{AppState, AppStateBus, SyncStatus};
use collector_embedder::{ArchiveHistoryChoice, ArchiveSource};

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
    if id.starts_with("archive_enroll:") {
        let bus: tauri::State<'_, AppStateBus> = app.state();
        if let Some(command) = archive_enrollment_command(&bus.snapshot(), id) {
            connect_then(app, command);
        }
        return;
    }
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
        "action_update" => update_to_latest(app),
        "open_dashboard" => open_dashboard(app),
        "open_logs" => open_logs(app),
        "quit" => app.exit(0),
        other => tracing::debug!(menu_id = other, "unhandled menu event"),
    }
}

fn archive_enrollment_command(state: &AppState, id: &str) -> Option<EngineCommand> {
    let (source, history_choice) = parse_archive_enrollment(id)?;
    if state.archive.pending.is_some()
        || state
            .archive
            .sources
            .iter()
            .any(|(authorized, _)| *authorized == source)
    {
        return None;
    }
    Some(EngineCommand::EnrollArchiveSource {
        source,
        history_choice,
    })
}

fn parse_archive_enrollment(id: &str) -> Option<(ArchiveSource, ArchiveHistoryChoice)> {
    let mut parts = id.split(':');
    if parts.next()? != "archive_enroll" {
        return None;
    }
    let source = match parts.next()? {
        "claude" => ArchiveSource::Claude,
        "codex" => ArchiveSource::Codex,
        _ => return None,
    };
    let history_choice = match parts.next()? {
        "all_history" => ArchiveHistoryChoice::AllHistory,
        "new_only" => ArchiveHistoryChoice::NewOnly,
        _ => return None,
    };
    if parts.next().is_some() {
        return None;
    }
    Some((source, history_choice))
}

fn update_to_latest<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let bus: tauri::State<'_, AppStateBus> = app.state();
        let state: tauri::State<'_, crate::updater::UpdateState> = app.state();
        if let Err(err) = crate::updater::install_latest(&app, &bus, &state).await {
            tracing::error!(error = %err, "tray update failed");
        }
    });
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
            report_archive_dispatch_failure(&bus, &cmd, "connection was not completed");
            return;
        }
        let handle: tauri::State<'_, EngineHandle> = app.state();
        if !handle.send(cmd.clone()) {
            tracing::warn!("engine gone; ignoring tray command");
            report_archive_dispatch_failure(&bus, &cmd, "capture control is unavailable");
        }
    });
}

fn report_archive_dispatch_failure(bus: &AppStateBus, cmd: &EngineCommand, message: &str) {
    if matches!(cmd, EngineCommand::EnrollArchiveSource { .. }) {
        bus.update(|state| {
            state.archive.pending = None;
            state.archive.last_error = Some(message.to_string());
        });
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_menu_id_builds_command_and_suppresses_locked_sources() {
        let state = AppState::default();
        assert_eq!(
            archive_enrollment_command(&state, "archive_enroll:claude:all_history"),
            Some(EngineCommand::EnrollArchiveSource {
                source: ArchiveSource::Claude,
                history_choice: ArchiveHistoryChoice::AllHistory,
            })
        );

        let mut pending = state.clone();
        pending.archive.pending = Some(ArchiveSource::Claude);
        assert!(
            archive_enrollment_command(&pending, "archive_enroll:claude:all_history").is_none()
        );

        let mut enrolled = state;
        enrolled.archive.sources = vec![(ArchiveSource::Claude, ArchiveHistoryChoice::AllHistory)];
        assert!(archive_enrollment_command(&enrolled, "archive_enroll:claude:new_only").is_none());
    }

    #[test]
    fn failed_archive_dispatch_publishes_repaint_state() {
        let bus = AppStateBus::new();
        let updates = bus.subscribe();
        let command = EngineCommand::EnrollArchiveSource {
            source: ArchiveSource::Claude,
            history_choice: ArchiveHistoryChoice::AllHistory,
        };

        report_archive_dispatch_failure(&bus, &command, "connection was not completed");

        assert!(updates.has_changed().unwrap());
        let archive = bus.snapshot().archive;
        assert_eq!(archive.pending, None);
        assert_eq!(
            archive.last_error.as_deref(),
            Some("connection was not completed")
        );
        assert!(archive.sources.is_empty());
    }
}
