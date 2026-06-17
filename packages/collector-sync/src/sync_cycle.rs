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
use collector_contracts::{AgentIngestEnvelope, AgentIngestFacts, AgentSource};
use collector_parser::assemble::session_facts;
use collector_parser::session_context::SessionContext;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::cursor::{ComposerCursor, CursorStore, CursorStoreError, FactCursor, FileCursor};
use crate::envelope::{build_envelope, BatchMeta};
use crate::orchestrator::{Action, Orchestrator, Trigger};

/// The watermark a [`SyncUnit`] commits on a `2xx`, by source shape. JSONL sources (Claude, Codex)
/// commit a whole-file [`FileCursor`]; the Cursor SQLite source commits a per-composer
/// [`ComposerCursor`]. The cycle never inspects the inner value — it only routes the variant to the
/// matching `advance`, so a new source shape must add a variant here (and the match stays exhaustive).
#[derive(Debug, Clone, PartialEq)]
pub enum UnitCursor {
    File(FileCursor),
    Composer(ComposerCursor),
}

impl UnitCursor {
    /// Commit this unit's progress to the store. Dispatched per variant; **called only after a
    /// `2xx`**, exactly like the inherent `advance` it wraps.
    fn advance(&self, store: &CursorStore, source: AgentSource) -> Result<(), CursorStoreError> {
        match self {
            UnitCursor::File(c) => store.advance(source, c),
            UnitCursor::Composer(c) => store.advance_composer(source, c),
        }
    }
}

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
    /// The source-shaped watermark *after* this batch — committed only on `Ok`. A file's
    /// mtime/offset/head-hash for JSONL sources, a composer's bubble-count/newest-timestamp for Cursor.
    pub next_cursor: UnitCursor,
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

/// How many sessions to pack into one ingest envelope, and how many envelopes to keep in flight.
///
/// The ingest path is built to absorb bursts (the Worker auth-claims-enqueues and a serverless queue
/// fans the heavy work out to the consumer), so the client must not throttle itself to one
/// round-trip per session. Batching collapses an N-session history backfill to ~N/`max_sessions`
/// POSTs; concurrency overlaps their network latency. Defaults are conservative enough to stay well
/// under the Worker's per-POST claim cap (1000 session_pks) and queue-message size, while turning a
/// thousand-session import from thousands of serial requests into tens of overlapped ones.
#[derive(Debug, Clone, Copy)]
pub struct SyncTuning {
    /// Max sessions merged into one envelope. Bounded well under the Worker's 1000-`session_pk` claim
    /// cap so one batch never exceeds it.
    pub max_sessions_per_batch: usize,
    /// Soft cap on an envelope's pre-gzip JSON size; a batch closes once adding the next session would
    /// exceed it, so a few huge sessions don't build a multi-MB request.
    pub max_batch_bytes: usize,
    /// Max envelopes POSTed concurrently. The work is network-wait, so this overlaps latency on the
    /// embedder's single task without needing `Send` futures or extra threads.
    pub max_concurrent_uploads: usize,
}

impl Default for SyncTuning {
    fn default() -> Self {
        Self {
            max_sessions_per_batch: 10,
            max_batch_bytes: 256 * 1024,
            max_concurrent_uploads: 2,
        }
    }
}

/// One prepared, ready-to-POST batch: the merged multi-session facts and the cursors to commit iff the
/// POST is accepted. `units` is how many sessions it carries (for the report's advanced count).
struct PreparedBatch {
    envelope: AgentIngestEnvelope,
    cursors: Vec<UnitCursor>,
    fact_cursors: Vec<FactCursor>,
}

/// Run one sync cycle against `units` with default tuning. Advances a unit's cursor only after the
/// envelope carrying it is accepted.
pub async fn run_sync_cycle<C: IngestClient>(
    client: &C,
    store: &CursorStore,
    orchestrator: &mut Orchestrator,
    meta: &BatchMeta,
    units: &[SyncUnit],
    mint_batch_id: &mut dyn FnMut() -> String,
    cancel: Option<&CancellationToken>,
) -> Result<(CycleReport, Vec<Action>), CursorStoreError> {
    run_sync_cycle_tuned(
        client,
        store,
        orchestrator,
        meta,
        units,
        mint_batch_id,
        cancel,
        SyncTuning::default(),
    )
    .await
}

/// Run one sync cycle, batching sessions into multi-session envelopes and POSTing up to
/// `tuning.max_concurrent_uploads` at once.
///
/// Sessions are grouped into [`PreparedBatch`]es under the session/byte budget (lazily, via
/// [`BatchPreparer`]); each batch's cursors advance together, and only after its POST returns `2xx`.
/// POSTs run concurrently in a `FuturesUnordered` capped at `max_concurrent_uploads`, but that set is
/// polled on this one task, so cursor writes and report mutation stay single-threaded (the
/// `CursorStore`'s SQLite connection is not shared across tasks).
/// A cycle-fatal error (bad credential, too-old client, exhausted rate limit) stops draining the rest:
/// every remaining batch would hit the same wall, and their cursors stay put for the next cycle. The
/// terminal `JobSucceeded`/`JobFailed` trigger is applied exactly as before.
#[allow(clippy::too_many_arguments)]
pub async fn run_sync_cycle_tuned<C: IngestClient>(
    client: &C,
    store: &CursorStore,
    orchestrator: &mut Orchestrator,
    meta: &BatchMeta,
    units: &[SyncUnit],
    mint_batch_id: &mut dyn FnMut() -> String,
    cancel: Option<&CancellationToken>,
    tuning: SyncTuning,
) -> Result<(CycleReport, Vec<Action>), CursorStoreError> {
    use futures_util::stream::{FuturesUnordered, StreamExt};

    let mut report = CycleReport::default();

    // Lazy: batches are assembled on demand as the pipeline pulls them, so only ~`concurrency` merged
    // envelopes are ever in memory at once (not the whole window), and a pre-cancelled run assembles
    // nothing.
    let concurrency = tuning.max_concurrent_uploads.max(1);
    let mut inflight = FuturesUnordered::new();
    let mut pending = BatchPreparer::new(meta, units, mint_batch_id, tuning);

    // A token already cancelled before we start must POST nothing, but still counts as an early abort
    // if there was work to do (so the cycle fails the job rather than reporting a clean drain).
    let precancelled = cancel.is_some_and(CancellationToken::is_cancelled);
    if precancelled {
        report.aborted_early = !units.is_empty();
    } else {
        // Prime the pipeline up to the concurrency limit.
        for _ in 0..concurrency {
            match pending.next_batch(store)? {
                Some(batch) => inflight.push(post_batch(client, batch, cancel)),
                None => break,
            }
        }
    }

    'drain: while let Some((batch, result)) = inflight.next().await {
        match result {
            Ok(_) => {
                // A cursor-store write failure is terminal for the cycle and propagates as `Err`. Drive
                // the orchestrator to its failed state first so it can't stay stuck in `Syncing` when the
                // caller tears down; un-advanced cursors re-send this batch's sessions next cycle.
                if let Err(err) = store.advance_facts(meta.source, &batch.fact_cursors) {
                    orchestrator.apply(Trigger::JobFailed);
                    return Err(err);
                }
                for cursor in &batch.cursors {
                    if let Err(err) = cursor.advance(store, meta.source) {
                        orchestrator.apply(Trigger::JobFailed);
                        return Err(err);
                    }
                }
                report.advanced += batch.cursors.len() as u32;
            }
            Err(err) => {
                report.failed += batch.cursors.len() as u32;
                let fatal = is_cycle_fatal(&err);
                if report.first_error.is_none() {
                    report.first_error = Some(err);
                }
                if fatal {
                    // Stop launching new POSTs; remaining batches' cursors stay put for next cycle.
                    report.aborted_early = true;
                    break 'drain;
                }
            }
        }

        // Backfill the freed concurrency slot, unless cancelled.
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            report.aborted_early = true;
            break 'drain;
        }
        if let Some(batch) = pending.next_batch(store)? {
            inflight.push(post_batch(client, batch, cancel));
        }
    }

    // Batches never launched (because a fatal error / cancellation stopped the drain) are simply not
    // counted: their cursors were never advanced, so they re-send next cycle. `aborted_early` already
    // records that the cycle did not finish its work.
    drop(inflight);

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

/// POST one prepared batch, returning the batch back alongside the result so the caller can advance
/// exactly its cursors on success. Owns the batch (moved into the future) so it can outlive the
/// iterator while the upload is in flight.
async fn post_batch<C: IngestClient>(
    client: &C,
    batch: PreparedBatch,
    cancel: Option<&CancellationToken>,
) -> (PreparedBatch, IngestResult) {
    let result = client.ingest(&batch.envelope, cancel).await;
    (batch, result)
}

/// A **lazy** producer of multi-session [`PreparedBatch`]es: it assembles + merges sessions only as
/// each batch is pulled, so peak memory tracks `max_concurrent_uploads` (the in-flight batches), not
/// the whole sync window, and a pre-cancelled run does no assembly. Each unit's facts are assembled
/// once and merged into the open batch; the batch closes when adding the next unit would exceed
/// `max_sessions_per_batch` or `max_batch_bytes` (a lone oversized session still rides its own batch).
/// One `collector_batch_id` is minted per yielded batch.
///
/// A unit that assembles to zero facts still carries a cursor that must advance (an empty session is
/// "seen, nothing to send"), so it is folded into a batch and rides along; the Worker treats an
/// all-empty envelope as an accepted no-op.
struct BatchPreparer<'a, M: FnMut() -> String> {
    meta: &'a BatchMeta,
    units: &'a [SyncUnit],
    next_unit: usize,
    mint_batch_id: M,
    max_sessions: usize,
    max_bytes: usize,
}

impl<'a, M: FnMut() -> String> BatchPreparer<'a, M> {
    fn new(
        meta: &'a BatchMeta,
        units: &'a [SyncUnit],
        mint_batch_id: M,
        tuning: SyncTuning,
    ) -> Self {
        Self {
            meta,
            units,
            next_unit: 0,
            mint_batch_id,
            max_sessions: tuning.max_sessions_per_batch.max(1),
            max_bytes: tuning.max_batch_bytes.max(1),
        }
    }

    fn next_batch(
        &mut self,
        store: &CursorStore,
    ) -> Result<Option<PreparedBatch>, CursorStoreError> {
        let mut open_facts = AgentIngestFacts::default();
        let mut open_cursors: Vec<UnitCursor> = Vec::new();
        let mut open_fact_cursors: Vec<FactCursor> = Vec::new();
        let mut open_bytes: usize = 0;

        while let Some(unit) = self.units.get(self.next_unit) {
            let facts = session_facts(self.meta.source, &unit.records, &unit.ctx);
            let (facts, fact_cursors) = store.filter_unsent_facts(self.meta.source, facts)?;
            let facts_bytes = serialized_facts_bytes(&facts);

            // If adding this unit would overflow the open (non-empty) batch, close and return it now —
            // WITHOUT consuming `unit`, so it starts the next batch. Never split a single session.
            let would_overflow = !open_cursors.is_empty()
                && (open_cursors.len() >= self.max_sessions
                    || open_bytes + facts_bytes > self.max_bytes);
            if would_overflow {
                return Ok(Some(PreparedBatch {
                    envelope: build_envelope(self.meta, (self.mint_batch_id)(), open_facts),
                    cursors: open_cursors,
                    fact_cursors: open_fact_cursors,
                }));
            }

            // Commit the peeked unit into the open batch.
            self.next_unit += 1;
            merge_facts(&mut open_facts, facts);
            open_cursors.push(unit.next_cursor.clone());
            open_fact_cursors.extend(fact_cursors);
            open_bytes += facts_bytes;
        }

        if open_cursors.is_empty() {
            return Ok(None);
        }
        Ok(Some(PreparedBatch {
            envelope: build_envelope(self.meta, (self.mint_batch_id)(), open_facts),
            cursors: open_cursors,
            fact_cursors: open_fact_cursors,
        }))
    }
}

/// Concatenate one session's facts onto the batch accumulator. Facts are independent at rest (the
/// consumer dedups each `*_pk`), so a simple per-array append is the whole merge.
fn merge_facts(into: &mut AgentIngestFacts, mut from: AgentIngestFacts) {
    into.messages.append(&mut from.messages);
    into.tool_events.append(&mut from.tool_events);
    into.file_events.append(&mut from.file_events);
    into.capability_snapshots
        .append(&mut from.capability_snapshots);
    into.pull_request_links.append(&mut from.pull_request_links);
}

/// Measure serialized fact bytes before merging into an envelope. This intentionally overcounts some
/// object-key overhead across sessions, which is safer than undercounting and repeatedly building
/// request bodies the Worker or network path cannot drain.
fn serialized_facts_bytes(facts: &AgentIngestFacts) -> usize {
    serde_json::to_vec(facts)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX / 2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use collector_api_client::error::IngestOk;
    use collector_contracts::AgentSource;
    use serde_json::json;
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;

    /// An [`IngestClient`] that returns a scripted sequence of results and counts its calls, so a test
    /// can assert exactly how many POSTs the cycle made.
    struct MockClient {
        scripted: RefCell<VecDeque<IngestResult>>,
        calls: Cell<u32>,
        envelopes: RefCell<Vec<AgentIngestEnvelope>>,
    }

    impl MockClient {
        fn new(results: impl IntoIterator<Item = IngestResult>) -> Self {
            Self {
                scripted: RefCell::new(results.into_iter().collect()),
                calls: Cell::new(0),
                envelopes: RefCell::new(Vec::new()),
            }
        }
    }

    impl IngestClient for MockClient {
        async fn ingest(
            &self,
            envelope: &AgentIngestEnvelope,
            _cancel: Option<&CancellationToken>,
        ) -> IngestResult {
            self.calls.set(self.calls.get() + 1);
            self.envelopes.borrow_mut().push(envelope.clone());
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
            next_cursor: UnitCursor::File(FileCursor {
                file_path: path.to_string(),
                mtime_ms: 1.0,
                byte_offset: 10,
                content_hash_head: "h".to_string(),
            }),
        }
    }

    fn message_unit(path: &str, model: &str) -> SyncUnit {
        let mut ctx = SessionContext {
            vendor_session_id: path.to_string(),
            vendor_started_at: Some(1_778_964_000_000),
            ..SessionContext::default()
        };
        ctx.normalized_git_remote = "github.com/acme/app".to_string();
        SyncUnit {
            records: vec![json!({
                "type": "assistant",
                "timestamp": "2026-05-25T23:37:23.355Z",
                "message": {
                    "id": "msg_1",
                    "model": model,
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "hello" }],
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 20,
                        "cache_read_input_tokens": 0,
                        "cache_creation_input_tokens": 0
                    }
                }
            })],
            ctx,
            next_cursor: UnitCursor::File(FileCursor {
                file_path: path.to_string(),
                mtime_ms: 1.0,
                byte_offset: 10,
                content_hash_head: "h".to_string(),
            }),
        }
    }

    /// A Cursor-source unit committing a per-composer watermark, to exercise the [`UnitCursor::Composer`]
    /// advance path through the same cycle.
    fn composer_unit(composer_id: &str) -> SyncUnit {
        SyncUnit {
            records: Vec::new(),
            ctx: SessionContext::default(),
            next_cursor: UnitCursor::Composer(ComposerCursor {
                composer_id: composer_id.to_string(),
                bubble_count: 3,
                max_created_at: 1_700_000_000_000,
            }),
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
    async fn an_accepted_cursor_composer_unit_advances_its_composer_watermark() {
        // The same cycle drives the Cursor SQLite source: an accepted composer unit commits a
        // ComposerCursor via the UnitCursor::Composer arm, not a FileCursor.
        let client = MockClient::new([ok()]);
        let store = CursorStore::open_in_memory("org").unwrap();
        let mut orch = syncing_orchestrator();
        let mut mint = counter();
        let meta = BatchMeta {
            source: AgentSource::Cursor,
            desktop_version: "1.0.0".to_string(),
            parser_version: "0.1.0".to_string(),
            raw_upload_requested: false,
        };

        let (report, _) = run_sync_cycle(
            &client,
            &store,
            &mut orch,
            &meta,
            &[composer_unit("comp-1")],
            &mut mint,
            None,
        )
        .await
        .unwrap();

        assert_eq!(report.advanced, 1);
        let stored = store
            .get_composer(AgentSource::Cursor, "comp-1")
            .unwrap()
            .expect("composer cursor advanced on 2xx");
        assert_eq!(stored.bubble_count, 3);
        assert_eq!(stored.max_created_at, 1_700_000_000_000);
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
    async fn accepted_facts_are_not_reposted_from_the_same_local_state() {
        let store = CursorStore::open_in_memory("org").unwrap();
        let mut mint = counter();
        let unit = message_unit("/a.jsonl", "claude-opus-4-7");

        let first = MockClient::new([ok()]);
        let mut o1 = syncing_orchestrator();
        run_sync_cycle(
            &first,
            &store,
            &mut o1,
            &meta(),
            std::slice::from_ref(&unit),
            &mut mint,
            None,
        )
        .await
        .unwrap();
        assert_eq!(first.envelopes.borrow()[0].facts.messages.len(), 1);

        let second = MockClient::new([ok()]);
        let mut o2 = syncing_orchestrator();
        run_sync_cycle(
            &second,
            &store,
            &mut o2,
            &meta(),
            std::slice::from_ref(&unit),
            &mut mint,
            None,
        )
        .await
        .unwrap();
        assert_eq!(second.envelopes.borrow()[0].facts.messages.len(), 0);
    }

    #[tokio::test]
    async fn changed_fact_content_with_the_same_identity_is_reposted() {
        let store = CursorStore::open_in_memory("org").unwrap();
        let mut mint = counter();

        let first = MockClient::new([ok()]);
        let mut o1 = syncing_orchestrator();
        run_sync_cycle(
            &first,
            &store,
            &mut o1,
            &meta(),
            &[message_unit("/a.jsonl", "claude-opus-4-7")],
            &mut mint,
            None,
        )
        .await
        .unwrap();

        let changed = MockClient::new([ok()]);
        let mut o2 = syncing_orchestrator();
        run_sync_cycle(
            &changed,
            &store,
            &mut o2,
            &meta(),
            &[message_unit("/a.jsonl", "claude-haiku-4-5")],
            &mut mint,
            None,
        )
        .await
        .unwrap();
        assert_eq!(changed.envelopes.borrow()[0].facts.messages.len(), 1);
    }

    /// One session per envelope, one POST at a time — reproduces the pre-batching contract so the
    /// per-session failure-isolation and fatal-stop semantics can be asserted deterministically.
    fn serial_tuning() -> SyncTuning {
        SyncTuning {
            max_sessions_per_batch: 1,
            max_batch_bytes: usize::MAX,
            max_concurrent_uploads: 1,
        }
    }

    #[tokio::test]
    async fn a_per_envelope_failure_does_not_strand_the_rest_of_the_batch() {
        let client = MockClient::new([ok(), Err(IngestError::InvalidEnvelope), ok()]);
        let store = CursorStore::open_in_memory("org").unwrap();
        let mut orch = syncing_orchestrator();
        let mut mint = counter();

        let units = [unit("/a.jsonl"), unit("/b.jsonl"), unit("/c.jsonl")];
        // One-session batches so a single envelope's failure isolates to its own cursor.
        let (report, actions) = run_sync_cycle_tuned(
            &client,
            &store,
            &mut orch,
            &meta(),
            &units,
            &mut mint,
            None,
            serial_tuning(),
        )
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
        // Serial tuning (one in flight) so the fatal first POST deterministically stops the second.
        let (report, _) = run_sync_cycle_tuned(
            &client,
            &store,
            &mut orch,
            &meta(),
            &units,
            &mut mint,
            None,
            serial_tuning(),
        )
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

    #[tokio::test]
    async fn default_batching_merges_many_sessions_into_one_post_and_advances_all_cursors() {
        // Three sessions, default tuning → one envelope, one POST, all three cursors
        // advanced on the single 2xx. This is the throughput win: N sessions are not N round-trips.
        let client = MockClient::new([ok()]);
        let store = CursorStore::open_in_memory("org").unwrap();
        let mut orch = syncing_orchestrator();
        let mut mint = counter();

        let units = [unit("/a.jsonl"), unit("/b.jsonl"), unit("/c.jsonl")];
        let (report, _) =
            run_sync_cycle(&client, &store, &mut orch, &meta(), &units, &mut mint, None)
                .await
                .unwrap();

        assert_eq!(client.calls.get(), 1, "all sessions rode one batched POST");
        assert_eq!(
            report.advanced, 3,
            "every batched session's cursor advanced"
        );
        assert_eq!(report.failed, 0);
        for p in ["/a.jsonl", "/b.jsonl", "/c.jsonl"] {
            assert!(store.get(AgentSource::Claude, p).unwrap().is_some());
        }
    }

    #[tokio::test]
    async fn batching_uses_serialized_fact_size_to_split_large_sessions() {
        let client = MockClient::new([ok(), ok()]);
        let store = CursorStore::open_in_memory("org").unwrap();
        let mut orch = syncing_orchestrator();
        let mut mint = counter();
        let large_model = "m".repeat(3_000);

        let units = [
            message_unit("/a.jsonl", &large_model),
            message_unit("/b.jsonl", &large_model),
        ];
        let tuning = SyncTuning {
            max_sessions_per_batch: 200,
            max_batch_bytes: 2_000,
            max_concurrent_uploads: 2,
        };
        let (report, _) = run_sync_cycle_tuned(
            &client,
            &store,
            &mut orch,
            &meta(),
            &units,
            &mut mint,
            None,
            tuning,
        )
        .await
        .unwrap();

        assert_eq!(client.calls.get(), 2, "large serialized facts split");
        assert_eq!(report.advanced, 2);
        assert_eq!(report.failed, 0);
    }

    #[tokio::test]
    async fn a_batch_failure_strands_only_that_batch_not_a_concurrent_one() {
        // Two single-session batches, two in flight: the failing one strands only its own cursor; the
        // other still advances. Proves concurrent batches are independent and a non-fatal failure does
        // not abort the cycle.
        let client = MockClient::new([Err(IngestError::InvalidEnvelope), ok()]);
        let store = CursorStore::open_in_memory("org").unwrap();
        let mut orch = syncing_orchestrator();
        let mut mint = counter();

        let units = [unit("/a.jsonl"), unit("/b.jsonl")];
        let tuning = SyncTuning {
            max_sessions_per_batch: 1,
            max_batch_bytes: usize::MAX,
            max_concurrent_uploads: 2,
        };
        let (report, _) = run_sync_cycle_tuned(
            &client,
            &store,
            &mut orch,
            &meta(),
            &units,
            &mut mint,
            None,
            tuning,
        )
        .await
        .unwrap();

        assert_eq!(report.advanced, 1);
        assert_eq!(report.failed, 1);
        assert!(!report.aborted_early);
    }
}
