// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector embedder: the policy long-running embedders share between sync passes.

//! Cycle policy for long-running embedders (the desktop engine and `trace-flow sync --watch`).
//!
//! Both run [`crate::sync::run_detailed`] on a timer. What they must agree on lives here so they
//! cannot drift: which window an authorized pass uses, when the one-time first-run backfill counts as
//! done, and how a pass's reports collapse into one outcome.

use std::time::Duration;

use anyhow::Result;

use crate::sync::{SyncRunOutcome, Window};

/// How often a resumed embedder runs an incremental pass.
pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// The history window the first authorized pass imports.
pub const DEFAULT_FIRST_BACKFILL: &str = "7d";

/// The window an authorized pass uses. Until the first-run backfill has reached ingest, every pass
/// (a click, a tick, a relaunch catch-up) keeps the wider window, so a backfill that failed is
/// retried rather than quietly replaced by an incremental pass that leaves older sessions unsynced.
pub fn authorized_window(backfilled: bool, first_backfill: Window) -> Window {
    if backfilled {
        Window::Incremental
    } else {
        first_backfill
    }
}

/// One pass's result, reduced to what a long-running embedder reports and acts on. `Send`, unlike
/// the sync work itself, so it can cross back from a blocking thread.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CycleOutcome {
    pub advanced: u32,
    pub failed: u32,
    /// The first per-session ingest error of the pass.
    pub first_error: Option<String>,
    /// A failure before any ingest (bad client config, broken cursor DB).
    pub setup_error: Option<String>,
    /// How long to wait before the next periodic pass when the ingest Worker shed load.
    pub backoff: Option<Duration>,
}

impl CycleOutcome {
    pub fn from_run(result: &Result<SyncRunOutcome>) -> Self {
        match result {
            Ok(outcome) => {
                let mut summary = Self {
                    backoff: outcome.backoff(),
                    ..Self::default()
                };
                for (_, report) in &outcome.reports {
                    summary.advanced += report.advanced;
                    summary.failed += report.failed;
                    if summary.first_error.is_none() {
                        summary.first_error = report.first_error.clone();
                    }
                }
                summary
            }
            Err(err) => Self::setup_failure(format!("{err:#}")),
        }
    }

    pub fn setup_failure(message: String) -> Self {
        Self {
            setup_error: Some(message),
            ..Self::default()
        }
    }

    /// Whether the pass reached ingest without errors, which retires the first-run backfill window.
    pub fn reached_ingest(&self) -> bool {
        self.setup_error.is_none() && self.first_error.is_none()
    }

    /// The error to surface for the pass, if any. Per-session errors are only an error state when
    /// nothing advanced; a pass that uploaded most sessions is still healthy.
    pub fn error(&self) -> Option<&str> {
        match (&self.setup_error, &self.first_error) {
            (Some(err), _) => Some(err),
            (None, Some(err)) if self.advanced == 0 => Some(err),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::{window_from_since, SourceReport};
    use collector_contracts::AgentSource;

    fn run_with(reports: Vec<SourceReport>) -> Result<SyncRunOutcome> {
        Ok(SyncRunOutcome {
            reports: reports
                .into_iter()
                .map(|report| (AgentSource::Claude, report))
                .collect(),
            discovery_passes: 1,
            files_read: 0,
        })
    }

    #[test]
    fn backfill_window_holds_until_a_pass_reaches_ingest() {
        let first = window_from_since(DEFAULT_FIRST_BACKFILL).unwrap();
        assert!(matches!(
            authorized_window(false, first),
            Window::History(_)
        ));
        assert!(matches!(
            authorized_window(true, first),
            Window::Incremental
        ));
    }

    #[test]
    fn outcome_sums_reports_and_keeps_the_first_error() {
        let outcome = CycleOutcome::from_run(&run_with(vec![
            SourceReport {
                advanced: 2,
                failed: 1,
                first_error: Some("first".to_string()),
                ..SourceReport::default()
            },
            SourceReport {
                advanced: 3,
                first_error: Some("second".to_string()),
                ..SourceReport::default()
            },
        ]));
        assert_eq!((outcome.advanced, outcome.failed), (5, 1));
        assert_eq!(outcome.first_error.as_deref(), Some("first"));
        assert!(!outcome.reached_ingest());
        assert_eq!(
            outcome.error(),
            None,
            "sessions advanced, so the pass is healthy"
        );
    }

    #[test]
    fn setup_failures_and_fully_failed_passes_are_errors() {
        let setup = CycleOutcome::from_run(&Err(anyhow::anyhow!("open cursor store")));
        assert_eq!(setup.error(), Some("open cursor store"));
        assert!(!setup.reached_ingest());

        let failed = CycleOutcome::from_run(&run_with(vec![SourceReport {
            failed: 2,
            first_error: Some("ingest 500".to_string()),
            ..SourceReport::default()
        }]));
        assert_eq!(failed.error(), Some("ingest 500"));

        let clean = CycleOutcome::from_run(&run_with(vec![SourceReport::default()]));
        assert!(clean.reached_ingest());
        assert_eq!(clean.error(), None);
    }
}
