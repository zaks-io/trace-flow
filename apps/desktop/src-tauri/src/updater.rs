// SPDX-License-Identifier: Apache-2.0
// Trace Flow Desktop: signed in-app updates from the public desktop release channel.

use std::future::Future;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

use crate::state::{AppStateBus, UpdateStatus};

const STARTUP_UPDATE_DELAY: Duration = Duration::from_secs(30);
const UPDATE_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

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

pub fn spawn_automatic<R: Runtime>(app: AppHandle<R>, bus: AppStateBus) {
    tauri::async_runtime::spawn(async move {
        run_automatic_updates(STARTUP_UPDATE_DELAY, UPDATE_INTERVAL, || {
            let app = app.clone();
            let bus = bus.clone();
            async move {
                let state = app.state::<UpdateState>();
                install_latest(&app, &bus, &state).await
            }
        })
        .await;
    });
}

async fn run_automatic_updates<F, Fut, T>(startup_delay: Duration, interval: Duration, mut run: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    tokio::time::sleep(startup_delay).await;
    loop {
        if let Err(error) = run().await {
            tracing::warn!(error = %error, "automatic desktop update failed");
        }
        tokio::time::sleep(interval).await;
    }
}

#[tauri::command]
pub async fn update_to_latest<R: Runtime>(
    app: AppHandle<R>,
    bus: State<'_, AppStateBus>,
    state: State<'_, UpdateState>,
) -> Result<UpdateOutcome, String> {
    install_latest(&app, &bus, &state).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn automatic_updates_retry_after_failure() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let task_attempts = attempts.clone();
        let task = tokio::spawn(run_automatic_updates(
            Duration::from_millis(1),
            Duration::from_millis(1),
            move || {
                let attempt = task_attempts.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt == 0 {
                        Err("update service unavailable".to_string())
                    } else {
                        Ok(())
                    }
                }
            },
        ));

        tokio::time::timeout(Duration::from_secs(1), async {
            while attempts.load(Ordering::SeqCst) < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        task.abort();
    }
}
