// SPDX-License-Identifier: Apache-2.0
// Adapted from otto-sync/src/orchestrator.rs (~/src/otto, 2026-05-25): the command set, the
// one-job-at-a-time discipline, and the pause/resume/watch shape come from there. The state set is
// redesigned to the ADR's named states (Watching/Syncing/ImportingHistory/Paused/Error), and the
// transition logic is extracted into a pure, embedder-agnostic core so it is unit-testable without
// the engine, watcher, or async runtime that otto's `Worker` is welded to. Those land in later 3b
// leaves and drive this core via [`Action`]s. Trace Flow owns the contract, IDs, pricing, redaction,
// and storage around this code.

//! The Collector's **one-job-at-a-time** orchestrator state machine.
//!
//! [`Orchestrator`] is a pure transition core: feed it a [`Trigger`] (a user command or a signal
//! from the running job / filesystem watcher) and it returns the side effects the embedder must
//! perform as [`Action`]s, mutating its [`OrchestratorState`]. It owns no engine, channels, or
//! runtime — the Tauri/CLI embedder wires those up and replays the actions — which is why the whole
//! machine is testable with plain synchronous asserts (the 3b "orchestrator state transitions"
//! verify item).
//!
//! **One job at a time.** While a job runs (`Syncing` / `ImportingHistory`), any new job trigger
//! (`SyncNow`, `ImportHistory`, or a watcher `BatchDetected`) is rejected with no state change and no
//! action. No batch is lost by this: the filesystem watcher re-fires and the 5-minute poll backstop
//! (ADR) re-discovers any files left unprocessed once the cursor next advances, so coalescing a
//! "dirty" re-sync is a refinement for a later leaf, not a correctness gap here.
//!
//! **Watcher lifetime.** The watcher is armed exactly in the active cluster (`Watching`, `Syncing`,
//! `ImportingHistory`) and stopped in the resting states (`Paused`, `Error`). So [`Action::StartWatching`]
//! fires only when entering the cluster from rest, and [`Action::StopWatching`] only when leaving it.

/// Where the orchestrator is. The five states the ADR's status surface renders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrchestratorState {
    /// Armed and idle: the watcher is running, no job in flight.
    Watching,
    /// An incremental sync job is running (one batch of changed transcripts).
    Syncing,
    /// A history-import (backfill) job is running.
    ImportingHistory,
    /// Stopped by the user. No watcher, no job. The initial state.
    Paused,
    /// A job failed terminally. No watcher, no job; awaits a `Resume`.
    Error,
}

/// What drives a transition: a user command or a signal from the running job / watcher.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// (Re)start watching — from `Paused` or `Error` back to `Watching`. Also the first start.
    Resume,
    /// Stop watching and cancel any in-flight job.
    Pause,
    /// User asked for an incremental sync now.
    SyncNow,
    /// User asked for a history backfill. The preset/date window is attached by a later leaf.
    ImportHistory,
    /// The watcher observed a changed-file batch.
    BatchDetected,
    /// The in-flight job finished successfully.
    JobSucceeded,
    /// The in-flight job failed terminally.
    JobFailed,
}

/// A side effect for the embedder to perform. The pure core emits these; the engine/watcher layer
/// (later 3b leaves) executes them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    StartWatching,
    StopWatching,
    StartSync,
    StartImport,
    /// Cancel the in-flight job (cooperative cancellation token in the embedder).
    CancelJob,
}

/// The one-job-at-a-time orchestrator. Construct with [`Orchestrator::new`] (starts `Paused`) and
/// drive it with [`Orchestrator::apply`].
#[derive(Debug, Clone)]
pub struct Orchestrator {
    state: OrchestratorState,
}

impl Default for Orchestrator {
    fn default() -> Self {
        Self::new()
    }
}

impl Orchestrator {
    /// A fresh orchestrator in `Paused`. The embedder issues `Resume` to begin watching once
    /// first-run setup (`collector_started_at` + 24h grace, a later leaf) is done.
    pub fn new() -> Self {
        Self {
            state: OrchestratorState::Paused,
        }
    }

    pub fn state(&self) -> OrchestratorState {
        self.state
    }

    /// `true` while a job is in flight, so a new job trigger would be rejected.
    pub fn is_busy(&self) -> bool {
        matches!(
            self.state,
            OrchestratorState::Syncing | OrchestratorState::ImportingHistory
        )
    }

    /// Apply a `trigger`, move to the next state, and return the actions the embedder must perform.
    /// Unmatched `(state, trigger)` pairs are deliberate no-ops: idempotent commands (`Resume` while
    /// already watching), stray job signals (a `JobSucceeded` with no job), and the rejected job
    /// triggers that enforce one-job-at-a-time.
    pub fn apply(&mut self, trigger: Trigger) -> Vec<Action> {
        use Action::*;
        use OrchestratorState::*;
        use Trigger::*;

        let (next, actions) = match (self.state, trigger) {
            // Resting -> active: arm the watcher.
            (Paused | Error, Resume) => (Watching, vec![StartWatching]),
            // Active -> Paused: drop the watcher (Error -> Paused has nothing to stop).
            (Error, Pause) => (Paused, vec![]),

            // Watching: armed and idle.
            (Watching, SyncNow | BatchDetected) => (Syncing, vec![StartSync]),
            (Watching, ImportHistory) => (ImportingHistory, vec![StartImport]),
            (Watching, Pause) => (Paused, vec![StopWatching]),

            // A running job: only completion or pause moves us (the one-job-at-a-time guard rejects
            // every new job trigger via the catch-all below).
            (Syncing | ImportingHistory, JobSucceeded) => (Watching, vec![]),
            (Syncing | ImportingHistory, JobFailed) => (Error, vec![StopWatching]),
            (Syncing | ImportingHistory, Pause) => (Paused, vec![CancelJob, StopWatching]),

            (state, _) => (state, vec![]),
        };

        self.state = next;
        actions
    }
}

#[cfg(test)]
mod tests {
    use super::Action::*;
    use super::OrchestratorState::*;
    use super::Trigger::*;
    use super::*;

    #[test]
    fn starts_paused() {
        assert_eq!(Orchestrator::new().state(), Paused);
        assert!(!Orchestrator::new().is_busy());
    }

    #[test]
    fn resume_from_paused_arms_the_watcher() {
        let mut o = Orchestrator::new();
        assert_eq!(o.apply(Resume), vec![StartWatching]);
        assert_eq!(o.state(), Watching);
    }

    #[test]
    fn batch_and_sync_now_both_start_a_sync_job() {
        for trigger in [BatchDetected, SyncNow] {
            let mut o = Orchestrator::new();
            o.apply(Resume);
            assert_eq!(o.apply(trigger), vec![StartSync]);
            assert_eq!(o.state(), Syncing);
            assert!(o.is_busy());
        }
    }

    #[test]
    fn import_history_starts_an_import_job() {
        let mut o = Orchestrator::new();
        o.apply(Resume);
        assert_eq!(o.apply(ImportHistory), vec![StartImport]);
        assert_eq!(o.state(), ImportingHistory);
        assert!(o.is_busy());
    }

    #[test]
    fn job_success_returns_to_watching_without_rearming_the_watcher() {
        // Both running-job states return to Watching with no action: the watcher stayed armed
        // through the job, so success emits neither StopWatching nor StartWatching.
        for (start, state) in [(SyncNow, Syncing), (ImportHistory, ImportingHistory)] {
            let mut o = Orchestrator::new();
            o.apply(Resume);
            o.apply(start);
            assert_eq!(o.state(), state);
            assert_eq!(o.apply(JobSucceeded), vec![]);
            assert_eq!(o.state(), Watching);
        }
    }

    #[test]
    fn job_failure_moves_to_error_and_stops_watching() {
        let mut o = Orchestrator::new();
        o.apply(Resume);
        o.apply(ImportHistory);
        assert_eq!(o.apply(JobFailed), vec![StopWatching]);
        assert_eq!(o.state(), Error);
    }

    #[test]
    fn a_new_job_trigger_is_rejected_while_busy() {
        // The core one-job-at-a-time invariant: while a job runs (either kind), nothing new starts.
        for (start, busy) in [(SyncNow, Syncing), (ImportHistory, ImportingHistory)] {
            for intruder in [SyncNow, BatchDetected, ImportHistory, Resume] {
                let mut o = Orchestrator::new();
                o.apply(Resume);
                o.apply(start);
                assert_eq!(
                    o.apply(intruder),
                    vec![],
                    "{intruder:?} must be rejected while {busy:?}"
                );
                assert_eq!(o.state(), busy);
            }
        }
    }

    #[test]
    fn pause_during_a_job_cancels_it_and_stops_watching() {
        for start in [SyncNow, ImportHistory] {
            let mut o = Orchestrator::new();
            o.apply(Resume);
            o.apply(start);
            assert_eq!(o.apply(Pause), vec![CancelJob, StopWatching]);
            assert_eq!(o.state(), Paused);
        }
    }

    #[test]
    fn resume_recovers_from_error() {
        let mut o = Orchestrator::new();
        o.apply(Resume);
        o.apply(SyncNow);
        o.apply(JobFailed);
        assert_eq!(o.state(), Error);
        assert_eq!(o.apply(Resume), vec![StartWatching]);
        assert_eq!(o.state(), Watching);
    }

    #[test]
    fn pause_from_error_relabels_without_an_action() {
        let mut o = Orchestrator::new();
        o.apply(Resume);
        o.apply(SyncNow);
        o.apply(JobFailed);
        assert_eq!(o.apply(Pause), vec![]);
        assert_eq!(o.state(), Paused);
    }

    #[test]
    fn idempotent_commands_and_stray_signals_are_no_ops() {
        let mut o = Orchestrator::new();
        o.apply(Resume);
        // Already watching, no job in flight.
        assert_eq!(o.apply(Resume), vec![]);
        assert_eq!(o.apply(JobSucceeded), vec![]);
        assert_eq!(o.apply(JobFailed), vec![]);
        assert_eq!(o.state(), Watching);
        // Pause while already paused.
        o.apply(Pause);
        assert_eq!(o.apply(Pause), vec![]);
        assert_eq!(o.state(), Paused);
    }

    #[test]
    fn full_watch_sync_pause_cycle() {
        let mut o = Orchestrator::new();
        assert_eq!(o.apply(Resume), vec![StartWatching]);
        assert_eq!(o.apply(BatchDetected), vec![StartSync]);
        assert_eq!(o.apply(JobSucceeded), vec![]);
        assert_eq!(o.apply(Pause), vec![StopWatching]);
        assert_eq!(o.state(), Paused);
    }
}
