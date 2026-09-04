// SPDX-License-Identifier: MIT
// Trace Flow Desktop: signed in-app updates from the public desktop release channel.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

use crate::state::{AppStateBus, UpdateStatus};

#[derive(Default)]
pub struct UpdateState {
    in_flight: Mutex<()>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOutcome {
    current_version: String,
}

fn set_status<R: Runtime>(app: &AppHandle<R>, bus: &AppStateBus, status: UpdateStatus) {
    bus.update(|snapshot| snapshot.update = status.clone());
    if let Err(err) = app.emit("desktop-update-status", status) {
        tracing::warn!(error = %err, "failed to emit desktop update status");
    }
}

pub async fn install_latest<R: Runtime>(
    app: &AppHandle<R>,
    bus: &AppStateBus,
    state: &UpdateState,
) -> Result<UpdateOutcome, String> {
    let _guard = state
        .in_flight
        .try_lock()
        .map_err(|_| "An update is already running.".to_string())?;

    set_status(app, bus, UpdateStatus::Checking);

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(err) => {
            let message = err.to_string();
            set_status(app, bus, UpdateStatus::Failed);
            tracing::error!(error = %message, "desktop updater initialization failed");
            return Err(message);
        }
    };

    let update = match updater.check().await {
        Ok(update) => update,
        Err(err) => {
            let message = err.to_string();
            set_status(app, bus, UpdateStatus::Failed);
            tracing::error!(error = %message, "desktop update check failed");
            return Err(message);
        }
    };

    let Some(update) = update else {
        let current_version = app.package_info().version.to_string();
        set_status(
            app,
            bus,
            UpdateStatus::UpToDate {
                version: current_version.clone(),
            },
        );
        return Ok(UpdateOutcome { current_version });
    };

    let version = update.version.clone();
    set_status(
        app,
        bus,
        UpdateStatus::Installing {
            version: version.clone(),
        },
    );

    if let Err(err) = update.download_and_install(|_, _| {}, || {}).await {
        let message = err.to_string();
        set_status(app, bus, UpdateStatus::Failed);
        tracing::error!(error = %message, version, "desktop update install failed");
        return Err(message);
    }

    tracing::info!(version, "desktop update installed; restarting");
    app.restart();
}

#[tauri::command]
pub async fn update_to_latest<R: Runtime>(
    app: AppHandle<R>,
    bus: State<'_, AppStateBus>,
    state: State<'_, UpdateState>,
) -> Result<UpdateOutcome, String> {
    install_latest(&app, &bus, &state).await
}
