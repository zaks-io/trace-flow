// SPDX-License-Identifier: Apache-2.0
// Original Trace Flow code. Trace Flow owns the contract, IDs, pricing, redaction, and storage around
// this code.

//! Cycle behavior when ingest rejects a batch (`400`) or sheds load (`503 enqueue_failed`), and
//! identity dedupe across the units merged into one envelope.

use super::*;

/// An [`IngestClient`] that answers by envelope content: any envelope carrying a fact from the
/// poisoned session is a `400` (optionally naming it, like the post-#573 Worker); every other
/// envelope is accepted.
struct PoisonClient {
    poisoned: &'static str,
    name_it: bool,
    calls: Cell<u32>,
    sessions_per_call: RefCell<Vec<Vec<String>>>,
}

impl PoisonClient {
    fn new(poisoned: &'static str, name_it: bool) -> Self {
        Self {
            poisoned,
            name_it,
            calls: Cell::new(0),
            sessions_per_call: RefCell::new(Vec::new()),
        }
    }
}

impl IngestClient for PoisonClient {
    async fn ingest(
        &self,
        envelope: &AgentIngestEnvelope,
        _cancel: Option<&CancellationToken>,
    ) -> IngestResult {
        self.calls.set(self.calls.get() + 1);
        let sessions: Vec<String> = envelope
            .facts
            .messages
            .iter()
            .map(|m| m.vendor_session_id.clone())
            .collect();
        let poisoned = sessions.iter().any(|s| s == self.poisoned);
        self.sessions_per_call.borrow_mut().push(sessions);
        if poisoned {
            return Err(IngestError::InvalidEnvelope(InvalidEnvelopeDetail {
                reason: self.name_it.then(|| "fact_identity_conflict".to_string()),
                category: self.name_it.then(|| "messages".to_string()),
                vendor_session_ids: if self.name_it {
                    vec![self.poisoned.to_string()]
                } else {
                    Vec::new()
                },
            }));
        }
        ok()
    }
}

fn ten_units() -> Vec<SyncUnit> {
    (0..10)
        .map(|i| message_unit(&format!("/p{i}.jsonl"), "claude-opus-4-7"))
        .collect()
}

#[tokio::test]
async fn a_400_on_a_ten_unit_batch_advances_the_nine_good_units_and_quarantines_the_bad_one() {
    let client = PoisonClient::new("/p4.jsonl", false);
    let store = CursorStore::open_in_memory("org").unwrap();
    let mut orch = syncing_orchestrator();
    let mut mint = counter();
    let units = ten_units();

    let (report, actions) =
        run_sync_cycle(&client, &store, &mut orch, &meta(), &units, &mut mint, None)
            .await
            .unwrap();

    // One batched POST, then every unit on its own within the same cycle.
    assert_eq!(client.calls.get(), 11);
    assert_eq!(report.advanced, 9);
    assert_eq!(report.failed, 0);
    assert_eq!(report.quarantined, vec!["/p4.jsonl".to_string()]);
    assert!(report.first_error.is_none());
    for i in (0..10).filter(|i| *i != 4) {
        let path = format!("/p{i}.jsonl");
        assert!(store.get(AgentSource::Claude, &path).unwrap().is_some());
    }
    assert!(store
        .get(AgentSource::Claude, "/p4.jsonl")
        .unwrap()
        .is_none());
    // The poisoned unit does not block completion: the job succeeds.
    assert_eq!(orch.state(), OrchestratorState::Watching);
    assert!(actions.is_empty());

    // The next cycle skips the quarantined unit without POSTing it or reporting it again.
    let next = PoisonClient::new("/p4.jsonl", false);
    let mut orch = syncing_orchestrator();
    let (report, _) = run_sync_cycle(
        &next,
        &store,
        &mut orch,
        &meta(),
        &units[4..5],
        &mut mint,
        None,
    )
    .await
    .unwrap();
    assert_eq!(next.calls.get(), 0);
    assert_eq!(report.skipped_quarantined, 1);
    assert!(report.quarantined.is_empty());
    assert_eq!(orch.state(), OrchestratorState::Watching);

    // A changed file is retried.
    let mut changed = message_unit("/p4.jsonl", "claude-opus-4-7");
    if let UnitCursor::File(cursor) = &mut changed.next_cursor {
        cursor.byte_offset += 1;
    }
    let healed = MockClient::new([ok()]);
    let mut orch = syncing_orchestrator();
    let (report, _) = run_sync_cycle(
        &healed,
        &store,
        &mut orch,
        &meta(),
        &[changed],
        &mut mint,
        None,
    )
    .await
    .unwrap();
    assert_eq!(report.advanced, 1);
}

#[tokio::test]
async fn a_400_naming_its_session_retries_the_rest_together_and_the_bad_unit_alone() {
    let client = PoisonClient::new("/p7.jsonl", true);
    let store = CursorStore::open_in_memory("org").unwrap();
    let mut orch = syncing_orchestrator();
    let mut mint = counter();

    let (report, _) = run_sync_cycle(
        &client,
        &store,
        &mut orch,
        &meta(),
        &ten_units(),
        &mut mint,
        None,
    )
    .await
    .unwrap();

    assert_eq!(client.calls.get(), 3);
    let calls = client.sessions_per_call.borrow();
    assert!(calls.iter().any(|sessions| sessions.len() == 9));
    assert!(calls.iter().any(|sessions| sessions == &["/p7.jsonl"]));
    assert_eq!(report.advanced, 9);
    assert_eq!(report.failed, 0);
    assert_eq!(report.quarantined, vec!["/p7.jsonl".to_string()]);
}

#[tokio::test]
async fn a_400_on_every_envelope_fails_the_units_instead_of_quarantining_them() {
    // Nothing was accepted and the body names no session: the client or server is broken, not
    // the data, so the units stay pending rather than being parked.
    let client = MockClient::new(
        std::iter::repeat_with(|| {
            Err(IngestError::InvalidEnvelope(
                InvalidEnvelopeDetail::default(),
            ))
        })
        .take(3),
    );
    let store = CursorStore::open_in_memory("org").unwrap();
    let mut orch = syncing_orchestrator();
    let mut mint = counter();
    let units = [
        message_unit("/a.jsonl", "claude-opus-4-7"),
        message_unit("/b.jsonl", "claude-opus-4-7"),
    ];

    let (report, _) = run_sync_cycle(&client, &store, &mut orch, &meta(), &units, &mut mint, None)
        .await
        .unwrap();

    assert_eq!(client.calls.get(), 3);
    assert_eq!(report.failed, 2);
    assert!(report.quarantined.is_empty());
    assert!(matches!(
        report.first_error,
        Some(IngestError::InvalidEnvelope(_))
    ));
    assert!(!store
        .is_quarantined(AgentSource::Claude, &units[0].next_cursor)
        .unwrap());
    assert_eq!(orch.state(), OrchestratorState::Error);
}

#[tokio::test]
async fn enqueue_failed_stops_new_batches_and_carries_retry_after() {
    let client = MockClient::new([Err(IngestError::EnqueueFailed {
        retry_after: Some(Duration::from_secs(60)),
    })]);
    let store = CursorStore::open_in_memory("org").unwrap();
    let mut orch = syncing_orchestrator();
    let mut mint = counter();
    let units = [unit("/a.jsonl"), unit("/b.jsonl"), unit("/c.jsonl")];

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

    assert_eq!(client.calls.get(), 1, "no batch is sent into a closed gate");
    assert!(report.aborted_early);
    assert!(report.throttled);
    assert_eq!(report.retry_after, Some(Duration::from_secs(60)));
    assert_eq!(orch.state(), OrchestratorState::Error);
}

#[tokio::test]
async fn duplicate_identities_across_units_are_sent_once_per_envelope() {
    let client = MockClient::new([ok()]);
    let store = CursorStore::open_in_memory("org").unwrap();
    let mut orch = syncing_orchestrator();
    let mut mint = counter();
    let mut a = message_unit("/a.jsonl", "claude-opus-4-7");
    let mut b = message_unit("/b.jsonl", "claude-opus-4-7");
    a.ctx.vendor_session_id = "shared".to_string();
    b.ctx.vendor_session_id = "shared".to_string();

    let (report, _) = run_sync_cycle(
        &client,
        &store,
        &mut orch,
        &meta(),
        &[a, b],
        &mut mint,
        None,
    )
    .await
    .unwrap();

    assert_eq!(report.advanced, 2);
    assert_eq!(client.envelopes.borrow()[0].facts.messages.len(), 1);
}

/// Holds every POST carrying `slow_model` open across several polls, so a concurrent POST could
/// finish first, and rejects any envelope carrying the `poisoned` session with a naming `400`. Records
/// each accepted POST's start and end by the model of its first message.
struct OrderClient {
    poisoned: &'static str,
    slow_model: &'static str,
    events: RefCell<Vec<String>>,
}

impl OrderClient {
    fn new(poisoned: &'static str, slow_model: &'static str) -> Self {
        Self {
            poisoned,
            slow_model,
            events: RefCell::new(Vec::new()),
        }
    }
}

impl IngestClient for OrderClient {
    async fn ingest(
        &self,
        envelope: &AgentIngestEnvelope,
        _cancel: Option<&CancellationToken>,
    ) -> IngestResult {
        let messages = &envelope.facts.messages;
        if messages
            .iter()
            .any(|m| m.vendor_session_id == self.poisoned)
        {
            return Err(IngestError::InvalidEnvelope(InvalidEnvelopeDetail {
                vendor_session_ids: vec![self.poisoned.to_string()],
                ..InvalidEnvelopeDetail::default()
            }));
        }
        let label = messages[0].model.clone();
        self.events.borrow_mut().push(format!("start {label}"));
        if messages.iter().any(|m| m.model == self.slow_model) {
            for _ in 0..10 {
                tokio::task::yield_now().await;
            }
        }
        self.events.borrow_mut().push(format!("end {label}"));
        ok()
    }
}

fn shared(path: &str, model: &str) -> SyncUnit {
    let mut unit = message_unit(path, model);
    unit.ctx.vendor_session_id = "shared".to_string();
    unit
}

const IN_ORDER: [&str; 4] = [
    "start claude-opus-4-7",
    "end claude-opus-4-7",
    "start claude-opus-4-8",
    "end claude-opus-4-8",
];

#[tokio::test]
async fn a_changed_copy_of_a_batched_fact_is_sent_after_the_copy_it_replaces() {
    let client = OrderClient::new("none", "claude-opus-4-7");
    let store = CursorStore::open_in_memory("org").unwrap();
    let mut orch = syncing_orchestrator();
    let mut mint = counter();
    let units = [
        shared("/a.jsonl", "claude-opus-4-7"),
        shared("/b.jsonl", "claude-opus-4-8"),
    ];

    let (report, _) = run_sync_cycle(&client, &store, &mut orch, &meta(), &units, &mut mint, None)
        .await
        .unwrap();

    // Merged, b's copy would be dropped while its cursor advanced. Sent concurrently, it could land
    // first and be overwritten by a's older copy.
    assert_eq!(report.advanced, 2);
    assert_eq!(*client.events.borrow(), IN_ORDER);
}

#[tokio::test]
async fn a_changed_copy_waits_for_the_retry_of_a_rejected_batch_carrying_the_older_copy() {
    let client = OrderClient::new("/p.jsonl", "claude-opus-4-7");
    let store = CursorStore::open_in_memory("org").unwrap();
    let mut orch = syncing_orchestrator();
    let mut mint = counter();
    let units = [
        shared("/a.jsonl", "claude-opus-4-7"),
        message_unit("/p.jsonl", "claude-opus-4-7"),
        shared("/b.jsonl", "claude-opus-4-8"),
    ];

    let (report, _) = run_sync_cycle(&client, &store, &mut orch, &meta(), &units, &mut mint, None)
        .await
        .unwrap();

    // [a, p] is rejected and a is re-sent alone; b must not overtake that retry.
    assert_eq!(report.advanced, 2);
    assert_eq!(report.quarantined, ["/p.jsonl"]);
    assert_eq!(*client.events.borrow(), IN_ORDER);
}
