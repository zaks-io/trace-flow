// SPDX-License-Identifier: Apache-2.0
// Trace Flow Desktop: the tray menu. Adapted from otto-desktop's menu builder, trimmed to the agent
// collector surface (no provider-usage rows).

pub mod apply;
pub mod refresh;

use tauri::{
    menu::{
        CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder,
        PredefinedMenuItem, SubmenuBuilder,
    },
    AppHandle, Runtime,
};

use crate::error::{DesktopError, Result};

/// Handles to the live menu items the refresh loop updates in place. Static items (Sync now, links,
/// Quit) are added to the menu inline and dispatched by id, so they need no stored handle.
///
/// The status + source rows are **enabled** items, not disabled ones: macOS renders disabled menu
/// items in a low-contrast gray that's hard to read, and the native menu API exposes no text-color
/// control. They're informational (live status + per-source file counts the engine refreshes), and
/// clicking any of them just opens the window — a harmless no-surprise action.
pub struct MenuHandles<R: Runtime> {
    pub status_header: MenuItem<R>,
    pub src_claude: MenuItem<R>,
    pub src_codex: MenuItem<R>,
    pub archive_status: MenuItem<R>,
    pub archive_claude_all: CheckMenuItem<R>,
    pub archive_claude_new: CheckMenuItem<R>,
    pub archive_codex_all: CheckMenuItem<R>,
    pub archive_codex_new: CheckMenuItem<R>,
    pub action_pause: MenuItem<R>,
    pub action_update: MenuItem<R>,
    pub autostart: CheckMenuItem<R>,
}

fn tauri_err(err: tauri::Error) -> DesktopError {
    DesktopError::Message(err.to_string())
}

pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> Result<(Menu<R>, MenuHandles<R>)> {
    let action = |id: &str, text: &str| -> tauri::Result<MenuItem<R>> {
        MenuItemBuilder::with_id(id, text).build(app)
    };

    // Enabled (legible) info rows; clicking any opens the window. The id is `open_window` so a click
    // is a sensible no-surprise action rather than a dead click.
    let status_header = action("open_window", "\u{25CB} Not connected").map_err(tauri_err)?;
    let src_claude = action("open_window", "Claude Code \u{00B7} \u{2014}").map_err(tauri_err)?;
    let src_codex = action("open_window", "Codex \u{00B7} \u{2014}").map_err(tauri_err)?;

    let action_open = action("open_window", "Open Trace Flow\u{2026}").map_err(tauri_err)?;
    let action_reconnect = action("action_reconnect", "Reconnect\u{2026}").map_err(tauri_err)?;
    let action_sync = action("action_sync", "Sync now").map_err(tauri_err)?;
    let action_pause = action("action_pause", "Pause syncing").map_err(tauri_err)?;

    let autostart = CheckMenuItemBuilder::with_id("toggle_autostart", "Start at login")
        .build(app)
        .map_err(tauri_err)?;

    let open_dashboard = action("open_dashboard", "Open dashboard").map_err(tauri_err)?;
    let open_logs = action("open_logs", "Open logs").map_err(tauri_err)?;
    let action_update = action("action_update", "Update to latest").map_err(tauri_err)?;
    let quit = action("quit", "Quit Trace Flow Desktop").map_err(tauri_err)?;

    let archive_status = action("open_window", "Archive: not configured").map_err(tauri_err)?;
    let archive_claude_all = CheckMenuItemBuilder::with_id(
        "archive_enroll:claude:all_history",
        "Archive existing and new conversations",
    )
    .build(app)
    .map_err(tauri_err)?;
    let archive_claude_new = CheckMenuItemBuilder::with_id(
        "archive_enroll:claude:new_only",
        "Archive new conversations",
    )
    .build(app)
    .map_err(tauri_err)?;
    let archive_codex_all = CheckMenuItemBuilder::with_id(
        "archive_enroll:codex:all_history",
        "Archive existing and new conversations",
    )
    .build(app)
    .map_err(tauri_err)?;
    let archive_codex_new =
        CheckMenuItemBuilder::with_id("archive_enroll:codex:new_only", "Archive new conversations")
            .build(app)
            .map_err(tauri_err)?;
    let archive_claude = SubmenuBuilder::new(app, "Claude")
        .item(&archive_claude_all)
        .item(&archive_claude_new)
        .build()
        .map_err(tauri_err)?;
    let archive_codex = SubmenuBuilder::new(app, "Codex")
        .item(&archive_codex_all)
        .item(&archive_codex_new)
        .build()
        .map_err(tauri_err)?;
    let archive = SubmenuBuilder::new(app, "Archive")
        .item(&archive_status)
        .item(&archive_claude)
        .item(&archive_codex)
        .build()
        .map_err(tauri_err)?;

    let sep = || PredefinedMenuItem::separator(app).map_err(tauri_err);

    let menu = MenuBuilder::new(app)
        .item(&status_header)
        .item(&sep()?)
        .item(&src_claude)
        .item(&src_codex)
        .item(&sep()?)
        .item(&action_open)
        .item(&action_reconnect)
        .item(&action_sync)
        .item(&action_pause)
        .item(&archive)
        .item(&sep()?)
        .item(&autostart)
        .item(&open_dashboard)
        .item(&open_logs)
        .item(&action_update)
        .item(&sep()?)
        .item(&quit)
        .build()
        .map_err(tauri_err)?;

    let handles = MenuHandles {
        status_header,
        src_claude,
        src_codex,
        archive_status,
        archive_claude_all,
        archive_claude_new,
        archive_codex_all,
        archive_codex_new,
        action_pause,
        action_update,
        autostart,
    };
    Ok((menu, handles))
}
