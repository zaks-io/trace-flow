// SPDX-License-Identifier: MIT
// Original Trace Flow code. otto-sync ran its upload loop inline in engine.rs (~/src/otto) against
// otto's own wire types and a server-side cursor; this is Trace Flow's own cycle, composed over the
// landed envelope assembler, SQLite cursor store, and orchestrator, behind a client trait so it
// tests with no network. Trace Flow owns the contract, IDs, pricing, redaction, and storage here.

//! One sync cycle: turn a batch of in-scope sessions into POSTs, advancing each file's cursor **only
//! after** its envelope is accepted (`2xx`).
//!
//! The cycle is the headless core the embedder (Tauri desktop / CLI, Phase 5) and the 3d end-to-end
//! run drive. Discovery — walking the filesystem, reading transcript bytes into [`SyncUnit`]s, and
//! computing each `next_cursor` — happens at 3d; this module assumes the units are prepared and
//! decides only what to POST and when a cursor may move. The [`IngestClient`] trait is the seam that
//! lets it run against scripted responses with no network.
//!
//! Cursor discipline (ADR): a unit's cursor advances on `Ok` and on `Ok` only. Any failure leaves the
//! cursor where it was, so the file is re-sent next cycle. A *cycle-fatal* error (bad credential,
//! too-old client, org rate limit) is not specific to one envelope and would reject every remaining
//! POST too, so it stops the cycle early; per-envelope failures only strand their own unit and the
//! cycle continues with the rest.

use collector_api_client::{CollectorApiClient, IngestError, IngestResult};
use collector_contracts::AgentIngestEnvelope;
use collector_parser::assemble::session_facts;
use collector_parser::session_context::SessionContext;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::cursor::{CursorStore, CursorStoreError, FileCursor};
use crate::envelope::{build_envelope, BatchMeta};
use crate::orchestrator::{Action, Orchestrator, Trigger};

/// The single API-client capability the cycle needs: POST one envelope. Behind a trait so the cycle
/// tests against scripted responses with no network; the real [`CollectorApiClient`] implements it by
/// delegating to its inherent `ingest`.
// `async fn` in a trait warns that callers can't add a `Send` bound on the returned future. The cycle
// is generic over `C` and awaited on the embedder's own runtime, never spawned across threads at this
// seam, so the missing bound is intended. If a future embedder spawns the cycle on a multi-threaded
// runtime, revisit this (switch to an `impl Future + Send` return) rather than widening it silently.
#[allow(async_fn_in_trait)]
pub trait IngestClient {
    async fn ingest(
        &self,
        envelope: &AgentIngestEnvelope,
        cancel: Option<&CancellationToken>,
    ) -> IngestResult;
}

impl IngestClient for CollectorApiClient {
    async fn ingest(
        &self,
        envelope: &AgentIngestEnvelope,
        cancel: Option<&CancellationToken>,
    ) -> IngestResult {
        CollectorApiClient::ingest(self, envelope, cancel).await
    }
}

/// One session's work for a cycle. The source is the cycle's (carried on [`BatchMeta`]); a unit holds
/// the parsed transcript records to assemble, the identity context stamped onto every fact, and the
/// cursor to persist **iff** the POST is accepted.
pub struct SyncUnit {
    pub records: Vec<Value>,
    pub ctx: SessionContext,
    /// The file's mtime / offset / head-hash *after* this batch — committed only on `Ok`.
    pub next_cursor: FileCursor,
}

/// The outcome of one [`run_sync_cycle`].
#[derive(Debug, Default)]
pub struct CycleReport {
    /// Units whose POST was accepted and whose cursor advanced.
    pub advanced: u32,
    /// Units whose POST failed; their cursors were left untouched for the next cycle.
    pub failed: u32,
    /// The first ingest error of the cycle, kept for logging and the handoff to the orchestrator.
    pub first_error: Option<IngestError>,
    /// Set when cancellation or a cycle-fatal error stopped the cycle before every unit was attempted.
    pub aborted_early: bool,
}

/// Whether an ingest error makes the rest of the cycle futile because it is not specific to one
/// envelope. A bad credential, a too-old client, or an exhausted org rate limit rejects every
/// remaining POST too, so stop now and re-send next cycle.
fn is_cycle_fatal(err: &IngestError) -> bool {
    matches!(
        err,
        IngestError::Unauthorized { .. }
            | IngestError::UpgradeRequired(_)
            | IngestError::RateLimited
    )
}

/// Run one sync cycle against `units`, advancing a unit's cursor only after its envelope is accepted.
///
/// `mint_batch_id` is called once per attempted unit to stamp a fresh `collector_batch_id`. The
/// orchestrator is expected to be `Syncing` (the caller applied `SyncNow`/`BatchDetected`); at the end
/// this applies one terminal trigger — `JobSucceeded` if no unit failed, else `JobFailed` — and
/// returns the actions it produced alongside the report. `cancel` is checked between units and passed
/// into each POST, so a cancellation stops the cycle promptly.
pub async fn run_sync_cycle<C: IngestClient>(
    client: &C,
    store: &CursorStore,
    orchestrator: &mut Orchestrator,
    meta: &BatchMeta,
    units: &[SyncUnit],
    mint_batch_id: &mut dyn FnMut() -> String,
    cancel: Option<&CancellationToken>,
) -> Result<(CycleReport, Vec<Action>), CursorStoreError> {
    let mut report = CycleReport::default();

    for unit in units {
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            report.aborted_early = true;
            break;
        }

        let facts = session_facts(meta.source, &unit.records, &unit.ctx);
        let envelope = build_envelope(meta, mint_batch_id(), facts);

        match client.ingest(&envelope, cancel).await {
            Ok(_) => {
                // A cursor-store write failure is terminal for the cycle and propagates as `Err`. Drive
                // the orchestrator to its failed state *first* so it can't stay stuck in `Syncing` when
                // the caller tears down on the error; the un-advanced cursor re-sends this unit later.
                if let Err(err) = store.advance(meta.source, &unit.next_cursor) {
                    orchestrator.apply(Trigger::JobFailed);
                    return Err(err);
                }
                report.advanced += 1;
            }
            Err(err) => {
                report.failed += 1;
                let fatal = is_cycle_fatal(&err);
                if report.first_error.is_none() {
                    report.first_error = Some(err);
                }
                if fatal {
                    report.aborted_early = true;
                    break;
                }
            }
        }
    }

    // A cancelled cycle has no failures yet did not finish its work, so it must not report success:
    // `JobSucceeded` would return the orchestrator to `Watching` as if the batch were drained. Any
    // failure or early abort (cancellation or a cycle-fatal error) is `JobFailed`; the un-advanced
    // cursors mean those files re-send once watching resumes.
    let trigger = if report.failed == 0 && !report.aborted_early {
        Trigger::JobSucceeded
    } else {
        Trigger::JobFailed
    };
    let actions = orchestrator.apply(trigger);
    Ok((report, actions))
}

#[cfg(test)]
mod tests {
    use super::*;
    use collector_api_client::error::IngestOk;
    use collector_contracts::AgentSource;
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;

    /// An [`IngestClient`] that returns a scripted sequence of results and counts its calls, so a test
    /// can assert exactly how many POSTs the cycle made.
    struct MockClient {
        scripted: RefCell<VecDeque<IngestResult>>,
        calls: Cell<u32>,
    }

    impl MockClient {
        fn new(results: impl IntoIterator<Item = IngestResult>) -> Self {
            Self {
                scripted: RefCell::new(results.into_iter().collect()),
                calls: Cell::new(0),
            }
        }
    }

    impl IngestClient for MockClient {
        async fn ingest(
            &self,
            _envelope: &AgentIngestEnvelope,
            _cancel: Option<&CancellationToken>,
        ) -> IngestResult {
            self.calls.set(self.calls.get() + 1);
            // The borrow is released before this returns; nothing holds it across an `.await`, so the
            // single-threaded test runtime never sees an overlapping borrow.
            self.scripted
                .borrow_mut()
                .pop_front()
                .expect("mock ingest called more times than scripted")
        }
    }

    fn ok() -> IngestResult {
        Ok(IngestOk {
            sessions: 1,
            skipped_conflict: 0,
        })
    }

    fn meta() -> BatchMeta {
        BatchMeta {
            source: AgentSource::Claude,
            desktop_version: "1.0.0".to_string(),
            parser_version: "0.1.0".to_string(),
            raw_upload_requested: false,
        }
    }

    fn unit(path: &str) -> SyncUnit {
        SyncUnit {
            records: Vec::new(),
            ctx: SessionContext::default(),
            next_cursor: FileCursor {
                file_path: path.to_string(),
                mtime_ms: 1.0,
                byte_offset: 10,
                content_hash_head: "h".to_string(),
            },
        }
    }

    fn syncing_orchestrator() -> Orchestrator {
        let mut o = Orchestrator::new();
        o.apply(Trigger::Resume);
        o.apply(Trigger::SyncNow);
        assert_eq!(o.state(), OrchestratorState::Syncing);
        o
    }

    use crate::orchestrator::OrchestratorState;

    fn counter() -> impl FnMut() -> String {
        let mut n = 0u32;
        move || {
            n += 1;
            format!("batch-{n}")
        }
    }

    #[tokio::test]
    async fn accepted_unit_advances_its_cursor_and_completes_the_job() {
        let client = MockClient::new([ok()]);
        let store = CursorStore::open_in_memory("org").unwrap();
        let mut orch = syncing_orchestrator();
        let mut mint = counter();

        let (report, actions) = run_sync_cycle(
            &client,
            &store,
            &mut orch,
            &meta(),
            &[unit("/a.jsonl")],
            &mut mint,
            None,
        )
        .await
        .unwrap();

        assert_eq!(report.advanced, 1);
        assert_eq!(report.failed, 0);
        assert!(store
            .get(AgentSource::Claude, "/a.jsonl")
            .unwrap()
            .is_some());
        // JobSucceeded returns Syncing -> Watching with no follow-up actions.
        assert_eq!(orch.state(), OrchestratorState::Watching);
        assert!(actions.is_empty());
    }

    #[tokio::test]
    async fn failed_unit_leaves_its_cursor_untouched_and_fails_the_job() {
        let client = MockClient::new([Err(IngestError::InternalError)]);
        let store = CursorStore::open_in_memory("org").unwrap();
        let mut orch = syncing_orchestrator();
        let mut mint = counter();

        let (report, actions) = run_sync_cycle(
            &client,
            &store,
            &mut orch,
            &meta(),
            &[unit("/a.jsonl")],
            &mut mint,
            None,
        )
        .await
        .unwrap();

        assert_eq!(report.advanced, 0);
        assert_eq!(report.failed, 1);
        assert!(store
            .get(AgentSource::Claude, "/a.jsonl")
            .unwrap()
            .is_none());
        // JobFailed drives Syncing -> Error and tears the watcher down.
        assert_eq!(orch.state(), OrchestratorState::Error);
        assert_eq!(actions, vec![Action::StopWatching]);
    }

    #[tokio::test]
    async fn a_unit_that_failed_then_succeeds_next_cycle_advances() {
        let store = CursorStore::open_in_memory("org").unwrap();
        let mut mint = counter();

        // Cycle 1: the POST fails, so nothing is committed.
        let c1 = MockClient::new([Err(IngestError::EnqueueFailed)]);
        let mut o1 = syncing_orchestrator();
        run_sync_cycle(
            &c1,
            &store,
            &mut o1,
            &meta(),
            &[unit("/a.jsonl")],
            &mut mint,
            None,
        )
        .await
        .unwrap();
        assert!(store
            .get(AgentSource::Claude, "/a.jsonl")
            .unwrap()
            .is_none());

        // Cycle 2: the same file is re-sent and accepted, so the cursor moves.
        let c2 = MockClient::new([ok()]);
        let mut o2 = syncing_orchestrator();
        let (report, _) = run_sync_cycle(
            &c2,
            &store,
            &mut o2,
            &meta(),
            &[unit("/a.jsonl")],
            &mut mint,
            None,
        )
        .await
        .unwrap();
        assert_eq!(report.advanced, 1);
        assert!(store
            .get(AgentSource::Claude, "/a.jsonl")
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn a_per_envelope_failure_does_not_strand_the_rest_of_the_batch() {
        let client = MockClient::new([ok(), Err(IngestError::InvalidEnvelope), ok()]);
        let store = CursorStore::open_in_memory("org").unwrap();
        let mut orch = syncing_orchestrator();
        let mut mint = counter();

        let units = [unit("/a.jsonl"), unit("/b.jsonl"), unit("/c.jsonl")];
        let (report, actions) =
            run_sync_cycle(&client, &store, &mut orch, &meta(), &units, &mut mint, None)
                .await
                .unwrap();

        assert_eq!(client.calls.get(), 3); // every unit was attempted
        assert_eq!(report.advanced, 2);
        assert_eq!(report.failed, 1);
        assert!(!report.aborted_early);
        assert!(store
            .get(AgentSource::Claude, "/a.jsonl")
            .unwrap()
            .is_some());
        assert!(store
            .get(AgentSource::Claude, "/b.jsonl")
            .unwrap()
            .is_none());
        assert!(store
            .get(AgentSource::Claude, "/c.jsonl")
            .unwrap()
            .is_some());
        // Any failure fails the job: Syncing -> Error, tearing the watcher down.
        assert_eq!(orch.state(), OrchestratorState::Error);
        assert_eq!(actions, vec![Action::StopWatching]);
    }

    #[tokio::test]
    async fn a_cycle_fatal_error_stops_before_attempting_the_rest() {
        let client = MockClient::new([
            Err(IngestError::Unauthorized {
                reason: "revoked".to_string(),
            }),
            ok(),
        ]);
        let store = CursorStore::open_in_memory("org").unwrap();
        let mut orch = syncing_orchestrator();
        let mut mint = counter();

        let units = [unit("/a.jsonl"), unit("/b.jsonl")];
        let (report, _) =
            run_sync_cycle(&client, &store, &mut orch, &meta(), &units, &mut mint, None)
                .await
                .unwrap();

        assert_eq!(client.calls.get(), 1); // the second unit was never POSTed
        assert_eq!(report.advanced, 0);
        assert_eq!(report.failed, 1);
        assert!(report.aborted_early);
        assert!(store
            .get(AgentSource::Claude, "/b.jsonl")
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn a_cancelled_token_stops_the_cycle_before_any_post() {
        let client = MockClient::new([ok()]);
        let store = CursorStore::open_in_memory("org").unwrap();
        let mut orch = syncing_orchestrator();
        let mut mint = counter();
        let token = CancellationToken::new();
        token.cancel();

        let (report, actions) = run_sync_cycle(
            &client,
            &store,
            &mut orch,
            &meta(),
            &[unit("/a.jsonl")],
            &mut mint,
            Some(&token),
        )
        .await
        .unwrap();

        assert_eq!(client.calls.get(), 0);
        assert!(report.aborted_early);
        assert_eq!(report.advanced, 0);
        // A cancelled cycle is not a success: it fails the job rather than returning to Watching.
        assert_eq!(orch.state(), OrchestratorState::Error);
        assert_eq!(actions, vec![Action::StopWatching]);
    }
}
