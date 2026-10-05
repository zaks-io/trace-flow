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
    // The pass, not this cycle, decides whether they are quarantined.
    let mut unconfirmed: Vec<&str> = report
        .unconfirmed
        .iter()
        .map(|r| r.vendor_session_id.as_str())
        .collect();
    unconfirmed.sort_unstable();
    assert_eq!(unconfirmed, ["/a.jsonl", "/b.jsonl"]);
    assert!(report
        .unconfirmed
        .iter()
        .all(|r| matches!(r.error, IngestError::InvalidEnvelope(_))));
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

/// Rejects the envelope carrying the `/p.jsonl` session with a naming `400` and, while doing so,
/// records `shift` as sent, as if another upload had moved those facts' stored state. Records the
/// models of every accepted POST's messages, in upload order.
struct StateShiftClient<'a> {
    store: &'a CursorStore,
    shift: Vec<crate::cursor::FactCursor>,
    events: RefCell<Vec<String>>,
}

impl IngestClient for StateShiftClient<'_> {
    async fn ingest(
        &self,
        envelope: &AgentIngestEnvelope,
        _cancel: Option<&CancellationToken>,
    ) -> IngestResult {
        let messages = &envelope.facts.messages;
        if messages.iter().any(|m| m.vendor_session_id == "/p.jsonl") {
            self.store
                .advance_facts(AgentSource::Claude, &self.shift)
                .unwrap();
            return Err(IngestError::InvalidEnvelope(InvalidEnvelopeDetail {
                vendor_session_ids: vec!["/p.jsonl".to_string()],
                ..InvalidEnvelopeDetail::default()
            }));
        }
        self.events
            .borrow_mut()
            .extend(messages.iter().map(|m| m.model.clone()));
        ok()
    }
}

#[tokio::test]
async fn held_batches_launch_oldest_unit_first_when_a_retry_defers_a_unit() {
    let store = CursorStore::open_in_memory("org").unwrap();
    let mut orch = syncing_orchestrator();
    let mut mint = counter();
    // r carries the shared message plus one of its own; q's copy of the shared message is already
    // current, so it rides along empty until the poisoned upload moves that state.
    let mut r = shared("/r.jsonl", "claude-opus-4-7");
    let mut second = r.records[0].clone();
    second["message"]["id"] = json!("msg_2");
    r.records.push(second);
    let q = shared("/q.jsonl", "claude-opus-4-9");
    let b = shared("/b.jsonl", "claude-opus-4-8");
    let first_message = |unit: &SyncUnit| {
        let facts = session_facts(AgentSource::Claude, &unit.records, &unit.ctx);
        crate::cursor::message_cursor(AgentSource::Claude, &facts.messages[0]).unwrap()
    };
    store
        .advance_facts(AgentSource::Claude, &[first_message(&q)])
        .unwrap();
    let client = StateShiftClient {
        store: &store,
        shift: vec![first_message(&r)],
        events: RefCell::new(Vec::new()),
    };
    let units = [r, q, message_unit("/p.jsonl", "claude-opus-4-7"), b];

    let (report, _) = run_sync_cycle(&client, &store, &mut orch, &meta(), &units, &mut mint, None)
        .await
        .unwrap();

    // The retry of [r, q] now finds q's copy pending and defers q while b is already held. q is the
    // older unit, so it must land before b.
    assert_eq!(report.advanced, 3);
    let events = client.events.borrow();
    let position = |model: &str| events.iter().position(|e| e == model).unwrap();
    assert!(
        position("claude-opus-4-9") < position("claude-opus-4-8"),
        "{events:?}"
    );
}

/// A unit of the shared session whose records are the given `(message id, model)` pairs.
fn shared_messages(path: &str, messages: &[(&str, &str)]) -> SyncUnit {
    let mut unit = shared(path, "unused");
    let template = unit.records[0].clone();
    unit.records = messages
        .iter()
        .map(|(id, model)| {
            let mut record = template.clone();
            record["message"]["id"] = json!(id);
            record["message"]["model"] = json!(model);
            record
        })
        .collect();
    unit
}

#[tokio::test]
async fn a_retry_closes_at_its_first_conflict_and_keeps_the_rest_in_order() {
    let store = CursorStore::open_in_memory("org").unwrap();
    let mut orch = syncing_orchestrator();
    let mut mint = counter();
    let a = shared_messages("/a.jsonl", &[("msg_1", "x-a"), ("msg_2", "a-2")]);
    let b = shared_messages("/b.jsonl", &[("msg_1", "x-b"), ("msg_3", "z-b")]);
    let c = shared_messages("/c.jsonl", &[("msg_3", "z-c")]);
    let cursors = |unit: &SyncUnit| -> Vec<crate::cursor::FactCursor> {
        session_facts(AgentSource::Claude, &unit.records, &unit.ctx)
            .messages
            .iter()
            .map(|m| crate::cursor::message_cursor(AgentSource::Claude, m).unwrap())
            .collect()
    };
    // b's facts are already current, so the first batch carries it empty. The poisoned upload then
    // moves both identities, so the retry finds b's older copies pending.
    store
        .advance_facts(AgentSource::Claude, &cursors(&b))
        .unwrap();
    let mut moved_z = cursors(&b)[1].clone();
    moved_z.content_hash = "sha256:moved".to_string();
    let client = StateShiftClient {
        store: &store,
        shift: vec![cursors(&a)[0].clone(), moved_z],
        events: RefCell::new(Vec::new()),
    };
    let units = [a, b, c, message_unit("/p.jsonl", "p")];

    let (report, _) = run_sync_cycle(&client, &store, &mut orch, &meta(), &units, &mut mint, None)
        .await
        .unwrap();

    // b's copy of msg_3 is older than c's, so c's must be the last one uploaded.
    assert_eq!(report.advanced, 3);
    let events = client.events.borrow();
    let last_z = events.iter().rev().find(|model| model.starts_with("z-"));
    assert_eq!(last_z.map(String::as_str), Some("z-c"), "{events:?}");
}
