// SPDX-License-Identifier: Apache-2.0
// Trace Flow Desktop: render AppState into the live tray menu items.

use tauri::Runtime;

use crate::menu::MenuHandles;
use crate::state::{AppState, ConnectionState, SyncStatus, UpdateStatus};

/// Update every menu item from a state snapshot. Best-effort: a failed set is ignored, not fatal —
/// the next state change repaints the whole menu, so a dropped single update self-heals.
pub fn apply_state<R: Runtime>(handles: &MenuHandles<R>, state: &AppState) {
    let status = match (&state.connection, &state.sync) {
        (ConnectionState::Disconnected, _) => "\u{25CB} Not connected".to_string(),
        (ConnectionState::Connected { .. }, SyncStatus::Paused) => {
            "\u{25CB} Connected \u{00B7} paused".to_string()
        }
        (ConnectionState::Connected { .. }, SyncStatus::Idle) => {
            "\u{25CF} Connected \u{00B7} watching".to_string()
        }
        (ConnectionState::Connected { .. }, SyncStatus::Syncing) => {
            "\u{25CF} Syncing\u{2026}".to_string()
        }
        (ConnectionState::Connected { .. }, SyncStatus::Error { message }) => {
            format!("\u{26A0} Error \u{00B7} {message}")
        }
    };
    let _ = handles.status_header.set_text(status);

    let _ = handles.src_claude.set_text(format!(
        "Claude Code \u{00B7} {} files",
        state.sources.claude_files
    ));
    let _ = handles.src_codex.set_text(format!(
        "Codex \u{00B7} {} files",
        state.sources.codex_files
    ));

    let pause_label = match state.sync {
        SyncStatus::Paused => "Start syncing",
        _ => "Pause syncing",
    };
    let _ = handles.action_pause.set_text(pause_label);

    let _ = handles.autostart.set_checked(state.autostart);

    let update_label = match &state.update {
        UpdateStatus::Idle => "Update to latest".to_string(),
        UpdateStatus::Checking => "Checking for updates\u{2026}".to_string(),
        UpdateStatus::Installing { version } => format!("Installing {version}\u{2026}"),
        UpdateStatus::UpToDate { version } => format!("Up to date \u{00B7} {version}"),
        UpdateStatus::Failed => "Update failed \u{00B7} Retry".to_string(),
    };
    let _ = handles.action_update.set_text(update_label);
    let _ = handles.action_update.set_enabled(!matches!(
        &state.update,
        UpdateStatus::Checking | UpdateStatus::Installing { .. }
    ));
}
