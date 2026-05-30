// SPDX-License-Identifier: MIT
// Trace Flow Desktop: the menu-bar Collector. Adapted from otto-desktop's lib.rs.

//! The desktop Collector (TRA-115).
//!
//! A macOS menu-bar app that runs the same Collector path as the CLI through the shared
//! `collector-embedder` crate: sign in via the browser device flow, store the Collector Credential in
//! the OS keychain, and sync local Claude/Codex transcripts to production ingest. A small first-run
//! window hosts source detection, the raw-upload opt-in (default off), and the explicit "Start
//! syncing" egress gate; the tray menu mirrors status and drives the engine thereafter.

mod commands;
mod connector;
mod engine;
mod error;
mod logging;
mod menu;
mod paths;
mod state;
mod tray;

use std::sync::Arc;

use tauri::{Manager, Runtime};

use crate::engine::EngineHandle;
use crate::menu::refresh::spawn_menu_refresh;
use crate::menu::{build_menu, MenuHandles};
use crate::state::AppStateBus;

/// Reflect the OS autostart state into the bus on launch (the plugin is the source of truth).
fn refresh_autostart<R: Runtime>(app: &tauri::AppHandle<R>, bus: &AppStateBus) {
    use tauri_plugin_autostart::ManagerExt;
    match app.autolaunch().is_enabled() {
        Ok(enabled) => bus.update(|s| s.autostart = enabled),
        Err(err) => tracing::warn!(error = %err, "failed to read autostart state"),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch just surfaces the existing window instead of starting a duplicate.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            commands::detect_sources,
            commands::connection_status,
            commands::start_login,
            commands::set_raw_upload,
            commands::start_syncing,
            commands::pause,
            commands::resume,
            commands::run_sync,
            commands::disconnect,
            commands::recent_errors,
            commands::clear_errors,
            commands::open_dashboard,
        ])
        .setup(|app| {
            let error_ring = logging::init_tracing(app.handle());
            app.manage(error_ring);

            // Menu-bar app: no Dock icon, no app-switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let bus = AppStateBus::new();
            app.manage(bus.clone());
            refresh_autostart(app.handle(), &bus);

            // The background sync engine. Starts paused — nothing leaves the machine until the user
            // clicks "Start syncing" in the window or the tray.
            let engine_handle: EngineHandle = engine::spawn(bus.clone());
            app.manage(engine_handle);

            // The single login seam, shared by every command and the tray (one in-flight guard).
            app.manage(crate::connector::Connector::default());

            let (menu, handles) = build_menu(app.handle()).map_err(|err| {
                Box::new(std::io::Error::other(err.to_string())) as Box<dyn std::error::Error>
            })?;
            let handles = Arc::new(handles);
            spawn_menu_refresh(handles, bus.subscribe());

            tray::build_tray(app.handle(), menu).map_err(|err| {
                Box::new(std::io::Error::other(err.to_string())) as Box<dyn std::error::Error>
            })?;

            // Show the window on first run (no connection yet); otherwise stay in the tray.
            if !commands::is_connected() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }

            tracing::info!("trace flow desktop tray initialised");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Trace Flow Desktop")
        .run(|_app, event| {
            // Keep running when the window is closed — it is a tray app, not a windowed one.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}

#[allow(dead_code)]
fn _menu_handles_type<R: Runtime>(h: Arc<MenuHandles<R>>) -> Arc<MenuHandles<R>> {
    h
}
