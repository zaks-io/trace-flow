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
//! assumes that consent and reads only the inputs in the config that step wrote, never the default
//! homes. A missing config or login is a [`ConfigError`]: the service exits with `EX_CONFIG` instead
//! of retrying something only a person can fix. A glob that cannot be searched fails just that cycle,
//! before any upload, so the watermark never moves past homes the pass could not see.
//!
//! The loop's own state (the backfill marker and the last cycle's outcome, for `status`) lives in
//! `service-state.json` beside the cursor stores, written and read through
//! [`collector_embedder::private_file`] like the connection file. It belongs to one Organization:
//! logging in to another starts a fresh state, so the new Organization gets its own first-run
//! backfill. Stopping mid-cycle is safe because cursors only advance after ingest acknowledges a
//! batch.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use collector_embedder::cycle::{self, CycleOutcome};
use collector_embedder::private_file;
use collector_embedder::sync::{self, Window};
use serde::{Deserialize, Serialize};

use crate::config::{Config, ConfigError};
use crate::report;
use crate::scope::Layout;

const STATE_FILE: &str = "service-state.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ServiceState {
    /// The Organization the rest of this state describes.
    pub org_id: Option<String>,
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

impl ServiceState {
    /// This state if it describes `org_id`; otherwise a fresh one for it.
    pub fn for_org(self, org_id: &str) -> Self {
        if self.org_id.as_deref() == Some(org_id) {
            self
        } else {
            Self {
                org_id: Some(org_id.to_string()),
                ..Self::default()
            }
        }
    }
}

pub fn state_file(paths_root: &Path) -> PathBuf {
    paths_root.join(STATE_FILE)
}

/// The state in the state dir `paths_root`. A missing file means the service has not run yet.
/// Anything unreadable is an error rather than a silent reset, which would re-run the first-run
/// backfill.
pub fn load_state(paths_root: &Path) -> Result<ServiceState> {
    let path = state_file(paths_root);
    match private_file::read_owned(&path)? {
        Some(bytes) => {
            serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))
        }
        None => Ok(ServiceState::default()),
    }
}

fn save_state(paths_root: &Path, state: &ServiceState) -> Result<()> {
    let json = serde_json::to_vec_pretty(state).context("serialize service state")?;
    private_file::write(paths_root, &state_file(paths_root), &json)
}

/// Run sync cycles until SIGTERM or SIGINT.
pub async fn run(layout: &Layout) -> Result<()> {
    // Before the config: the per-user one lives in the state dir, which must refuse planted entries
    // first.
    layout.paths.ensure()?;
    let Some(config) = layout.config()? else {
        return Err(ConfigError(format!(
            "`sync --watch` reads its inputs from {}, which does not exist; run `trace-flow{} service install` to create it",
            layout.config_file.display(),
            layout.scope.flag()
        ))
        .into());
    };
    let interval = config.interval();
    let first_backfill = config.first_backfill();
    let mut state = load_state(layout.paths.root())?;

    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);

    println!(
        "Trace Flow Collector started; syncing every {} min.",
        interval.as_secs() / 60
    );
    loop {
        let pass = run_pass(layout, &config, &mut state, first_backfill);
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
        save_state(layout.paths.root(), &state)?;

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
    config: &Config,
    state: &mut ServiceState,
    first_backfill: Window,
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
    let credentials = conn.credentials(&layout.paths);
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
    *state = std::mem::take(state).for_org(&conn.org_id);
    let window = cycle::authorized_window(state.backfilled, first_backfill);
    let source_homes = match config.source_homes(&layout.home) {
        Ok(source_homes) => source_homes,
        Err(err) => return Ok(Err(err)),
    };

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
        assert_eq!(load_state(dir.path()).unwrap(), ServiceState::default());

        let state = ServiceState {
            org_id: Some("org_a".to_string()),
            backfilled: true,
            last_cycle: Some(CycleRecord {
                finished_at_ms: 1,
                uploaded: 2,
                failed: 0,
                error: None,
            }),
        };
        save_state(dir.path(), &state).unwrap();
        assert_eq!(load_state(dir.path()).unwrap(), state);
    }

    #[test]
    fn another_organization_starts_with_its_own_backfill() {
        let state = ServiceState {
            org_id: Some("org_a".to_string()),
            backfilled: true,
            last_cycle: None,
        };
        assert!(state.clone().for_org("org_a").backfilled);
        let other = state.for_org("org_b");
        assert!(!other.backfilled);
        assert_eq!(other.org_id.as_deref(), Some("org_b"));
    }

    #[test]
    fn a_corrupt_state_file_is_an_error_not_a_fresh_backfill() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(state_file(dir.path()), b"{not json").unwrap();
        assert!(load_state(dir.path()).is_err());
    }
}
