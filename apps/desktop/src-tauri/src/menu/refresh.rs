// SPDX-License-Identifier: MIT
// Trace Flow Desktop: drive tray-menu updates off the state bus.

use std::sync::Arc;

use tauri::Runtime;
use tokio::sync::watch;

use crate::menu::{apply::apply_state, MenuHandles};
use crate::state::AppState;

/// Watch the state bus and re-render the menu on every change. Renders once up front so the menu is
/// correct before the first state update.
pub fn spawn_menu_refresh<R: Runtime>(
    handles: Arc<MenuHandles<R>>,
    mut rx: watch::Receiver<AppState>,
) {
    tauri::async_runtime::spawn(async move {
        apply_state(&handles, &rx.borrow().clone());
        while rx.changed().await.is_ok() {
            let snapshot = rx.borrow().clone();
            apply_state(&handles, &snapshot);
        }
    });
}
