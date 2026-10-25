// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector CLI: `trace-flow sync --watch`, the long-running service loop.

//! The Collector as a long-running service.
//!
//! Each cycle runs the same [`sync::run_detailed`] as a one-shot `sync`, in the window
//! [`cycle::authorized_window`] picks: the first-run backfill until a pass reaches ingest, then
//! incremental passes that resume from the last complete sync, so time the service was stopped is
//! still covered. Connection, credential, and glob inputs are re-read every cycle, so a re-login or
//! a newly created agent home takes effect without a restart.
//!
//! Installing the service is the explicit "start syncing" step (see `service install`); this loop
//! assumes that consent. A missing login is a [`ConfigError`]: the service exits with `EX_CONFIG`
//! instead of retrying something only a person can fix.
//!
//! The loop's own state (the backfill marker and the last cycle's outcome, for `status`) lives in
//! `service-state.json` beside the cursor store. Stopping mid-cycle is safe because cursors only
//! advance after ingest acknowledges a batch.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use collector_embedder::cycle::{self, CycleOutcome};
use collector_embedder::keychain::CredentialStore;
use collector_embedder::sync::{self, Window};
use serde::{Deserialize, Serialize};

use crate::config::{Config, ConfigError};
use crate::report;
use crate::scope::Layout;

const STATE_FILE: &str = "service-state.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ServiceState {
    /// Whether a pass has reached ingest, which retires the first-run backfill window.
    pub backfilled: bool,
    pub last_cycle: Option<CycleRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CycleRecord {
    pub finished_at_ms: i64,
    pub uploaded: u32,
    pub failed: u32,
    /// The pass's error class, when it is in an error state. Never a secret.
    pub error: Option<String>,
}

pub fn state_file(paths_root: &Path) -> PathBuf {
    paths_root.join(STATE_FILE)
}

/// A missing file means the service has not run yet. Anything unreadable is an error rather than
/// a silent reset, which would re-run the first-run backfill.
pub fn load_state(path: &Path) -> Result<ServiceState> {
    match std::fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(ServiceState::default()),
        Err(err) => Err(err).with_context(|| format!("read {}", path.display())),
    }
}

/// Write via a sibling temp file and rename, so a crash never leaves a half-written state file.
fn save_state(path: &Path, state: &ServiceState) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(state)?)
        .with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("replace {}", path.display()))
}

/// Run sync cycles until SIGTERM or SIGINT.
pub async fn run(
    layout: &Layout,
    config: Option<&Config>,
    credentials: &CredentialStore,
) -> Result<()> {
    let interval = config.map_or(cycle::DEFAULT_INTERVAL, Config::interval);
    let first_backfill = match config {
        Some(config) => config.first_backfill(),
        None => sync::window_from_since(cycle::DEFAULT_FIRST_BACKFILL)?,
    };
    layout.paths.ensure()?;
    let state_path = state_file(layout.paths.root());
    let mut state = load_state(&state_path)?;

    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);

    println!(
        "Trace Flow Collector started; syncing every {} min.",
        interval.as_secs() / 60
    );
    loop {
        let window = cycle::authorized_window(state.backfilled, first_backfill);
        let pass = run_pass(layout, config, credentials, window);
        let result = tokio::select! {
            result = pass => result?,
            signal = &mut shutdown => {
                println!("Stopping mid-cycle; unacknowledged sessions retry on the next start.");
                return signal;
            }
        };

        let (uploaded, failed) = match &result {
            Ok(outcome) => report::print_reports(&outcome.reports),
            Err(_) => (0, 0),
        };
        let outcome = CycleOutcome::from_run(&result);
        if outcome.reached_ingest() {
            state.backfilled = true;
        }
        let error = outcome.error().map(str::to_string);
        match &error {
            Some(err) => eprintln!("Cycle failed: {err}"),
            None => println!("Cycle finished: uploaded {uploaded} session(s), {failed} failed."),
        }
        state.last_cycle = Some(CycleRecord {
            finished_at_ms: now_ms(),
            uploaded,
            failed,
            error,
        });
        save_state(&state_path, &state)?;

        let wait = match outcome.backoff {
            Some(backoff) => {
                println!(
                    "Ingest asked collectors to back off for {}s.",
                    backoff.as_secs()
                );
                backoff
            }
            None => interval,
        };
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            signal = &mut shutdown => {
                println!("Stopping.");
                return signal;
            }
        }
    }
}

/// One pass. The outer `Result` is a setup problem that stops the service; the inner one is the
/// pass itself, recorded and retried next cycle.
async fn run_pass(
    layout: &Layout,
    config: Option<&Config>,
    credentials: &CredentialStore,
    window: Window,
) -> Result<Result<sync::SyncRunOutcome>> {
    let relogin = format!(
        "then run `{}`",
        layout.scope.hint("systemctl", "restart trace-flow.service")
    );
    let Some(conn) = layout.paths.load_connection()? else {
        return Err(ConfigError(format!(
            "not logged in; run `trace-flow{} login`, {relogin}",
            layout.scope.flag()
        ))
        .into());
    };
    let credential = credentials.load(&conn.org_id)?.ok_or_else(|| {
        ConfigError(format!(
            "no Collector Credential in the {} for org {}; run `trace-flow{} login`, {relogin}",
            credentials.kind().label(),
            conn.org_id,
            layout.scope.flag()
        ))
    })?;
    let ingest_url = conn
        .sync_ingest_url()
        .map_err(|err| ConfigError(format!("{err:#}")))?;
    let source_homes = layout.source_homes(config)?;

    Ok(sync::run_detailed(sync::RunConfig {
        ingest_url,
        credential,
        org_id: &conn.org_id,
        home: &layout.home,
        source_homes: Some(&source_homes),
        window,
        replay: false,
        now_ms: now_ms(),
        batch_id_prefix: "service",
        state_dir: Some(layout.paths.root()),
    })
    .await)
}

#[cfg(unix)]
async fn shutdown_signal() -> Result<()> {
    use tokio::signal::unix::{signal, SignalKind};
    let mut terminate = signal(SignalKind::terminate()).context("listen for SIGTERM")?;
    let mut interrupt = signal(SignalKind::interrupt()).context("listen for SIGINT")?;
    tokio::select! {
        _ = terminate.recv() => {}
        _ = interrupt.recv() => {}
    }
    Ok(())
}

#[cfg(not(unix))]
async fn shutdown_signal() -> Result<()> {
    tokio::signal::ctrl_c().await.context("listen for Ctrl-C")
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_round_trips_and_a_missing_file_is_a_fresh_service() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_file(dir.path());
        assert_eq!(load_state(&path).unwrap(), ServiceState::default());

        let state = ServiceState {
            backfilled: true,
            last_cycle: Some(CycleRecord {
                finished_at_ms: 1,
                uploaded: 2,
                failed: 0,
                error: None,
            }),
        };
        save_state(&path, &state).unwrap();
        assert_eq!(load_state(&path).unwrap(), state);
    }

    #[test]
    fn a_corrupt_state_file_is_an_error_not_a_fresh_backfill() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_file(dir.path());
        std::fs::write(&path, b"{not json").unwrap();
        assert!(load_state(&path).is_err());
    }
}
