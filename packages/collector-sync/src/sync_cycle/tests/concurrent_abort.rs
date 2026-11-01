// SPDX-License-Identifier: Apache-2.0

use super::*;
use tokio::sync::Notify;

struct InterruptingClient {
    accepted: MockClient,
    next_post_started: Notify,
    first_batch_calls: Cell<usize>,
    cancel_cycle: bool,
}

impl IngestClient for InterruptingClient {
    async fn ingest(
        &self,
        envelope: &AgentIngestEnvelope,
        cancel: Option<&CancellationToken>,
    ) -> IngestResult {
        if envelope.facts.messages[0].vendor_session_id == "/a.jsonl" {
            let calls = self.first_batch_calls.get();
            self.first_batch_calls.set(calls + 1);
            if calls == 0 {
                return self.accepted.ingest(envelope, cancel).await;
            }
            self.next_post_started.notify_one();
            return std::future::pending().await;
        }

        // Force the abort to happen while A's second POST is awaiting its response.
        self.next_post_started.notified().await;
        if self.cancel_cycle {
            cancel.unwrap().cancel();
            Err(IngestError::InternalError)
        } else {
            Err(IngestError::EnqueueFailed { retry_after: None })
        }
    }
}

async fn assert_concurrent_abort_keeps_accepted_facts(cancel_cycle: bool) {
    let units = [
        multi_message_unit("/a.jsonl", 5, "claude-opus-4-7"),
        message_unit("/b.jsonl", "claude-opus-4-7"),
    ];
    let original = session_facts(AgentSource::Claude, &units[0].records, &units[0].ctx);
    let mut sizing = original.clone();
    sizing.messages.truncate(2);
    let tuning = SyncTuning {
        max_sessions_per_batch: 1,
        max_batch_bytes: serialized_facts_bytes(&sizing),
        max_concurrent_uploads: 2,
    };
    let client = InterruptingClient {
        accepted: MockClient::new([ok()]),
        next_post_started: Notify::new(),
        first_batch_calls: Cell::new(0),
        cancel_cycle,
    };
    let store = CursorStore::open_in_memory("org").unwrap();
    let token = CancellationToken::new();
    let mut mint = counter();
    let (report, _) = tokio::time::timeout(
        Duration::from_secs(5),
        run_sync_cycle_tuned(
            &client,
            &store,
            &mut syncing_orchestrator(),
            &meta(),
            &units,
            &mut mint,
            Some(&token),
            tuning,
        ),
    )
    .await
    .expect("B must abort while A's second POST is pending")
    .unwrap();

    assert!(report.aborted_early);
    assert_eq!(report.throttled, !cancel_cycle);
    assert_eq!(report.advanced, 0);
    assert_eq!(report.failed, 1);
    assert_eq!(client.first_batch_calls.get(), 2);
    assert_eq!(
        client.accepted.envelopes.borrow()[0].facts.messages,
        original.messages[..2]
    );
    assert!(store
        .get(AgentSource::Claude, "/a.jsonl")
        .unwrap()
        .is_none());
    assert!(store
        .get(AgentSource::Claude, "/b.jsonl")
        .unwrap()
        .is_none());

    let retry = MockClient::new(std::iter::repeat_with(ok).take(10));
    let (report, _) = run_sync_cycle_tuned(
        &retry,
        &store,
        &mut syncing_orchestrator(),
        &meta(),
        &units,
        &mut mint,
        None,
        tuning,
    )
    .await
    .unwrap();
    assert_eq!(report.advanced, 2);
    let retried: Vec<_> = retry
        .envelopes
        .borrow()
        .iter()
        .flat_map(|envelope| envelope.facts.messages.clone())
        .filter(|message| message.vendor_session_id == "/a.jsonl")
        .collect();
    assert!(
        !retried.contains(&original.messages[1]),
        "accepted facts must not resend"
    );
    for message in &original.messages[2..] {
        assert_eq!(retried.iter().filter(|row| *row == message).count(), 1);
    }
}

#[tokio::test]
async fn fatal_concurrent_batch_keeps_accepted_facts_from_an_unfinished_batch() {
    assert_concurrent_abort_keeps_accepted_facts(false).await;
}

#[tokio::test]
async fn cancellation_keeps_accepted_facts_from_an_unfinished_concurrent_batch() {
    assert_concurrent_abort_keeps_accepted_facts(true).await;
}
