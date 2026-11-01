// SPDX-License-Identifier: Apache-2.0

use super::*;
use collector_contracts::AgentIngestFacts;

fn mixed_unit() -> SyncUnit {
    let mut unit = unit("/mixed.jsonl");
    unit.ctx.vendor_session_id = "mixed-session".to_string();
    unit.ctx.normalized_git_remote = "github.com/acme/app".to_string();
    unit.ctx.repo_root = "/repo".to_string();
    unit.records = vec![
        json!({
            "type": "session_meta",
            "payload": {
                "id": "mixed-session",
                "base_instructions": "You are Codex.",
                "dynamic_tools": [{ "name": "shell" }]
            }
        }),
        json!({
            "type": "response_item",
            "payload": {
                "type": "message", "role": "user",
                "content": [{ "type": "input_text", "text": "add the file" }]
            }
        }),
        json!({
            "type": "response_item",
            "payload": {
                "type": "message", "role": "assistant",
                "content": [{ "type": "output_text", "text": "opened github.com/acme/app/pull/42" }]
            }
        }),
        json!({
            "type": "response_item",
            "payload": {
                "type": "function_call", "name": "apply_patch", "call_id": "patch-1",
                "arguments": json!({ "input": "*** Add File: src/new.rs\n+fn main() {}\n" }).to_string()
            }
        }),
    ];
    unit
}

fn remove_accepted(pending: &mut AgentIngestFacts, accepted: &AgentIngestFacts) {
    pending
        .messages
        .retain(|fact| !accepted.messages.contains(fact));
    pending
        .tool_events
        .retain(|fact| !accepted.tool_events.contains(fact));
    pending
        .file_events
        .retain(|fact| !accepted.file_events.contains(fact));
    pending
        .capability_snapshots
        .retain(|fact| !accepted.capability_snapshots.contains(fact));
    pending
        .pull_request_links
        .retain(|fact| !accepted.pull_request_links.contains(fact));
}

#[tokio::test]
async fn every_failure_kind_commits_exactly_the_accepted_prefix_in_every_fact_category() {
    let unit = mixed_unit();
    let meta = BatchMeta {
        source: AgentSource::Codex,
        ..meta()
    };
    let original = session_facts(meta.source, &unit.records, &unit.ctx);
    assert_eq!(original.messages.len(), 2);
    assert_eq!(original.tool_events.len(), 1);
    assert_eq!(original.file_events.len(), 1);
    assert_eq!(original.capability_snapshots.len(), 2);
    assert_eq!(original.pull_request_links.len(), 1);
    // A one-byte budget leaves each indivisible fact in its own envelope, with attribution context.
    let tuning = SyncTuning {
        max_batch_bytes: 1,
        ..serial_tuning()
    };
    let envelope_count = 6;
    for accepted_count in 0..envelope_count {
        for error in [
            IngestError::EnqueueFailed {
                retry_after: Some(Duration::from_secs(60)),
            },
            IngestError::RateLimited {
                retry_after: Some(Duration::from_secs(15)),
            },
            IngestError::InternalError,
            IngestError::Transport(std::io::Error::other("connection reset").into()),
            IngestError::InvalidEnvelope(InvalidEnvelopeDetail::default()),
            IngestError::InvalidEnvelope(InvalidEnvelopeDetail {
                vendor_session_ids: vec![unit.ctx.vendor_session_id.clone()],
                ..InvalidEnvelopeDetail::default()
            }),
        ] {
            let invalid = matches!(error, IngestError::InvalidEnvelope(_));
            let named = matches!(&error, IngestError::InvalidEnvelope(detail) if !detail.vendor_session_ids.is_empty());
            let backoff = error.is_backoff();
            let retry_after = error.retry_after();
            let client = MockClient::new(
                std::iter::repeat_with(ok)
                    .take(accepted_count)
                    .chain(std::iter::once(Err(error))),
            );
            let store = CursorStore::open_in_memory("org").unwrap();
            let (report, _) = run_sync_cycle_tuned(
                &client,
                &store,
                &mut syncing_orchestrator(),
                &meta,
                std::slice::from_ref(&unit),
                &mut counter(),
                None,
                tuning,
            )
            .await
            .unwrap();

            assert_eq!(client.calls.get() as usize, accepted_count + 1);
            assert_eq!(report.advanced, 0);
            assert_eq!(report.failed, u32::from(!named));
            assert_eq!(report.throttled, backoff);
            assert_eq!(report.retry_after, retry_after);
            assert_eq!(report.aborted_early, backoff);
            assert_eq!(report.invalid_envelope.is_some(), invalid);
            assert_eq!(report.unconfirmed.len(), usize::from(invalid && !named));
            assert_eq!(report.quarantined.len(), usize::from(named));
            assert_eq!(report.first_error.is_some(), !invalid);
            assert!(store.get(meta.source, "/mixed.jsonl").unwrap().is_none());

            let mut expected = original.clone();
            for envelope in client.envelopes.borrow().iter().take(accepted_count) {
                remove_accepted(&mut expected, &envelope.facts);
            }
            assert_ne!(expected, AgentIngestFacts::default());
            assert_eq!(
                store
                    .filter_unsent_facts(meta.source, original.clone())
                    .unwrap()
                    .0,
                expected
            );
        }
    }
}

#[tokio::test]
async fn oversized_session_converges_under_a_per_cycle_admission_cap() {
    let unit = multi_message_unit("/large.jsonl", 41, &"m".repeat(1_000));
    let original = session_facts(AgentSource::Claude, &unit.records, &unit.ctx);
    let mut sizing = original.clone();
    sizing.messages.truncate(3);
    let tuning = SyncTuning {
        max_batch_bytes: serialized_facts_bytes(&sizing) + 128,
        ..serial_tuning()
    };
    let probe = MockClient::new(std::iter::repeat_with(ok).take(41));
    run_sync_cycle_tuned(
        &probe,
        &CursorStore::open_in_memory("probe").unwrap(),
        &mut syncing_orchestrator(),
        &meta(),
        std::slice::from_ref(&unit),
        &mut counter(),
        None,
        tuning,
    )
    .await
    .unwrap();
    let envelope_count = probe.calls.get() as usize;
    assert!(envelope_count > 4);

    for admitted_per_cycle in [1, 2, 4] {
        let store = CursorStore::open_in_memory("org").unwrap();
        let mut mint = counter();
        let mut accepted_counts: BTreeMap<String, usize> = BTreeMap::new();
        let mut accepted_envelopes = 0;
        let mut batch_ids = HashSet::new();
        let mut pending = original.clone();
        let cycle_limit = envelope_count.div_ceil(admitted_per_cycle) + 1;
        let mut completed = false;
        for cycle in 1..=cycle_limit {
            let client =
                MockClient::new(std::iter::repeat_with(ok).take(admitted_per_cycle).chain(
                    std::iter::once(Err(IngestError::EnqueueFailed {
                        retry_after: Some(Duration::from_secs(60)),
                    })),
                ));
            let (report, _) = run_sync_cycle_tuned(
                &client,
                &store,
                &mut syncing_orchestrator(),
                &meta(),
                std::slice::from_ref(&unit),
                &mut mint,
                None,
                tuning,
            )
            .await
            .unwrap();

            let envelopes = client.envelopes.borrow();
            for envelope in envelopes.iter() {
                assert!(batch_ids.insert(envelope.batch.collector_batch_id.clone()));
                assert!(serialized_facts_bytes(&envelope.facts) <= tuning.max_batch_bytes);
                assert_eq!(envelope.facts.messages.first(), original.messages.first());
                assert!(envelope
                    .facts
                    .messages
                    .iter()
                    .skip(1)
                    .all(|fact| pending.messages.contains(fact)));
            }
            let accepted = envelopes.len().min(admitted_per_cycle);
            accepted_envelopes += accepted;
            for envelope in envelopes.iter().take(accepted) {
                for message in &envelope.facts.messages {
                    *accepted_counts
                        .entry(message.vendor_message_id.clone().unwrap())
                        .or_default() += 1;
                }
                remove_accepted(&mut pending, &envelope.facts);
            }
            assert_eq!(
                store
                    .filter_unsent_facts(AgentSource::Claude, original.clone())
                    .unwrap()
                    .0,
                pending
            );
            if report.advanced == 1 {
                assert_eq!(report.failed, 0);
                assert!(!report.throttled);
                assert!(!report.aborted_early);
                assert!(pending.messages.is_empty());
                assert!(store
                    .get(AgentSource::Claude, "/large.jsonl")
                    .unwrap()
                    .is_some());
                assert!(cycle > 1);
                completed = true;
                break;
            }
            assert_eq!(client.calls.get() as usize, admitted_per_cycle + 1);
            assert_eq!(report.failed, 1);
            assert!(report.throttled);
            assert!(report.aborted_early);
            assert_eq!(report.retry_after, Some(Duration::from_secs(60)));
            assert!(store
                .get(AgentSource::Claude, "/large.jsonl")
                .unwrap()
                .is_none());
        }
        assert!(
            completed,
            "session did not converge within {cycle_limit} cycles at cap {admitted_per_cycle}"
        );
        assert_eq!(accepted_counts.len(), original.messages.len());
        for (index, message) in original.messages.iter().enumerate() {
            assert_eq!(
                accepted_counts[message.vendor_message_id.as_ref().unwrap()],
                if index == 0 { accepted_envelopes } else { 1 },
                "only attribution context may be accepted more than once"
            );
        }
    }
}
