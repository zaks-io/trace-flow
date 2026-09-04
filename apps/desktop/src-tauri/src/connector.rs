// SPDX-License-Identifier: Apache-2.0
// Trace Flow Desktop: the single seam for "make sure we're connected".

//! One place that owns the device-flow login.
//!
//! Login can be requested from four surfaces (the window's Connect button, the window's
//! Start/Sync-now buttons, and the tray's Sync-now / Start-syncing items). Each needs the same
//! behaviour: if there's no connection yet, run the browser device flow once, then refresh the bus.
//! Funnelling them all through [`Connector::ensure_connected`] keeps that logic in one spot and lets a
//! single in-flight guard prevent a fumbled double-click from opening two browser tabs and two blocking
//! loopback listeners.

use std::sync::Arc;

use collector_embedder::connection::Paths;
use collector_embedder::{defaults, keychain, login};
use tokio::sync::Mutex;

use crate::engine;
use crate::state::AppStateBus;

/// Owns the device-flow login behind an in-flight guard. Cheap to clone (an `Arc` inside), managed in
/// Tauri state so every command and the tray share the one guard.
#[derive(Clone)]
pub struct Connector {
    /// Held for the duration of a login. `try_lock` failing means a login is already running, so the
    /// caller no-ops instead of starting a second browser flow.
    in_flight: Arc<Mutex<()>>,
}

impl Default for Connector {
    fn default() -> Self {
        Self {
            in_flight: Arc::new(Mutex::new(())),
        }
    }
}

impl Connector {
    /// Ensure there is a connection, running the browser device flow if needed. A no-op (returns
    /// `Ok`) when already connected. If a login is already in flight, returns an error rather than
    /// opening a second browser tab. On success the bus connection state is refreshed.
    ///
    /// The device flow blocks on a loopback listener, so it runs on a blocking thread; this future
    /// itself stays `Send` and can be awaited from any command or the tray.
    pub async fn ensure_connected(&self, bus: &AppStateBus) -> Result<(), String> {
        if crate::commands::is_connected() {
            return Ok(());
        }

        self.login(bus, false).await
    }

    /// Force a fresh browser login, preserving cursor DBs. The old credential remains in place if the
    /// new login fails, so a cancelled browser flow does not strand the existing connection.
    pub async fn reconnect(&self, bus: &AppStateBus) -> Result<(), String> {
        self.login(bus, true).await
    }

    async fn login(&self, bus: &AppStateBus, force: bool) -> Result<(), String> {
        // Don't queue a second login behind the first — a double-click should be a no-op, not a second
        // browser tab. `try_lock` fails iff a login is already running.
        let _guard = match self.in_flight.try_lock() {
            Ok(guard) => guard,
            Err(_) => return Err("a sign-in is already in progress".to_string()),
        };

        // Re-check under the guard: the first login may have completed between our check and the lock.
        if !force && crate::commands::is_connected() {
            return Ok(());
        }

        let convex_site_url = defaults::convex_site_url();
        let ingest_url = defaults::ingest_url();
        let old_org_id = Paths::resolve()
            .ok()
            .and_then(|paths| paths.load_connection().ok().flatten())
            .map(|conn| conn.org_id);
        let conn =
            tauri::async_runtime::spawn_blocking(move || login::run(&convex_site_url, &ingest_url))
                .await
                .map_err(|err| format!("login task panicked: {err}"))?
                .map_err(|err| format!("{err:#}"))?;
        if let Some(old_org_id) = old_org_id.filter(|old| old != &conn.org_id) {
            if let Err(err) = keychain::delete(&old_org_id) {
                tracing::warn!(error = %err, org_id = %old_org_id, "failed to remove old Collector Credential");
            }
        }
        engine::refresh_connection(bus);
        tracing::info!(org_id = %conn.org_id, "connected");
        Ok(())
    }
}
