// SPDX-License-Identifier: Apache-2.0
// Trace Flow Desktop: render AppState into the live tray menu items.

use collector_embedder::{ArchiveHistoryChoice, ArchiveSource};
use tauri::Runtime;

use crate::menu::MenuHandles;
use crate::state::{AppState, ConnectionState, SyncStatus, UpdateStatus};

/// Update every menu item from a state snapshot. Best-effort: a failed set is ignored, not fatal.
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

    let archive = archive_menu_view(state);
    let _ = handles.archive_status.set_text(archive.status);
    apply_archive_source(
        &handles.archive_claude_all,
        &handles.archive_claude_new,
        archive.claude,
    );
    apply_archive_source(
        &handles.archive_codex_all,
        &handles.archive_codex_new,
        archive.codex,
    );

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

#[derive(Debug, PartialEq, Eq)]
struct ArchiveSourceView {
    all_checked: bool,
    new_checked: bool,
    enabled: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct ArchiveMenuView {
    status: String,
    claude: ArchiveSourceView,
    codex: ArchiveSourceView,
}

fn archive_menu_view(state: &AppState) -> ArchiveMenuView {
    let status = if let Some(source) = state.archive.pending {
        format!("{}: enabling\u{2026}", archive_source_label(source))
    } else if let Some(error) = &state.archive.last_error {
        format!("Archive: {error}")
    } else if state.archive.enrolled {
        let count = state.archive.sources.len();
        format!(
            "Archive: {count} Source{}",
            if count == 1 { "" } else { "s" }
        )
    } else {
        archive_reason_label(state.archive.reason.as_deref()).to_string()
    };
    ArchiveMenuView {
        status,
        claude: archive_source_view(state, ArchiveSource::Claude),
        codex: archive_source_view(state, ArchiveSource::Codex),
    }
}

fn archive_source_view(state: &AppState, source: ArchiveSource) -> ArchiveSourceView {
    let authorized = state
        .archive
        .sources
        .iter()
        .find(|(authorized, _)| *authorized == source)
        .map(|(_, history)| *history);
    ArchiveSourceView {
        all_checked: authorized == Some(ArchiveHistoryChoice::AllHistory),
        new_checked: authorized == Some(ArchiveHistoryChoice::NewOnly),
        enabled: authorized.is_none() && state.archive.pending.is_none(),
    }
}

fn apply_archive_source<R: Runtime>(
    all: &tauri::menu::CheckMenuItem<R>,
    new: &tauri::menu::CheckMenuItem<R>,
    view: ArchiveSourceView,
) {
    let _ = all.set_checked(view.all_checked);
    let _ = new.set_checked(view.new_checked);
    let _ = all.set_enabled(view.enabled);
    let _ = new.set_enabled(view.enabled);
}

fn archive_source_label(source: ArchiveSource) -> &'static str {
    match source {
        ArchiveSource::Claude => "Claude",
        ArchiveSource::Codex => "Codex",
    }
}

fn archive_reason_label(reason: Option<&str>) -> &'static str {
    match reason {
        Some("not_activated") => "Archive: not enabled for your organization",
        Some("server_disabled") => "Archive: unavailable",
        Some("not_pro") => "Archive: Pro subscription needed",
        Some("frozen") => "Archive: frozen",
        Some("deleting") => "Archive: deleting",
        Some("credential_revoked") => "Archive: reconnect needed",
        Some("enrollment_invalid") => "Archive: enrollment inactive",
        _ => "Archive: not configured",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorized_source_is_checked_and_locked() {
        let mut state = AppState::default();
        state.archive.enrolled = true;
        state.archive.sources = vec![(ArchiveSource::Claude, ArchiveHistoryChoice::AllHistory)];

        let view = archive_menu_view(&state);
        assert_eq!(view.status, "Archive: 1 Source");
        assert!(view.claude.all_checked);
        assert!(!view.claude.new_checked);
        assert!(!view.claude.enabled);
        assert!(view.codex.enabled);
    }

    #[test]
    fn archive_repair_error_replaces_enrolled_status() {
        let mut state = AppState::default();
        state.archive.enrolled = true;
        state.archive.sources = vec![(ArchiveSource::Codex, ArchiveHistoryChoice::AllHistory)];
        state.archive.last_error = Some("Codex archive needs repair".to_string());

        let view = archive_menu_view(&state);
        assert_eq!(view.status, "Archive: Codex archive needs repair");
    }

    #[test]
    fn pending_and_denied_states_are_rendered_without_enabling_another_click() {
        let mut pending = AppState::default();
        pending.archive.pending = Some(ArchiveSource::Codex);
        let pending_view = archive_menu_view(&pending);
        assert_eq!(pending_view.status, "Codex: enabling\u{2026}");
        assert!(!pending_view.codex.all_checked);
        assert!(!pending_view.codex.new_checked);
        assert!(!pending_view.claude.enabled);
        assert!(!pending_view.codex.enabled);

        let mut denied = AppState::default();
        denied.archive.reason = Some("not_activated".to_string());
        let denied_view = archive_menu_view(&denied);
        assert_eq!(
            denied_view.status,
            "Archive: not enabled for your organization"
        );
        assert!(denied_view.claude.enabled);
    }
}
