// SPDX-License-Identifier: Apache-2.0

use super::*;
use collector_contracts::AgentToolEventFact;

fn call(id: &str, command: &str) -> Value {
    json!({
        "type": "response_item",
        "payload": {
            "type": "function_call", "name": "exec_command", "call_id": id,
            "arguments": json!({ "cmd": command }).to_string()
        }
    })
}

fn duplicate_unit() -> SyncUnit {
    let mut unit = unit("/duplicate.jsonl");
    unit.ctx.vendor_session_id = "duplicate".into();
    unit.records = vec![
        json!({
            "type": "response_item",
            "payload": {
                "type": "message", "role": "user",
                "content": [{ "type": "input_text", "text": "hello" }]
            }
        }),
        call("same-call", "echo first"),
        call("same-call", "echo later"),
        call("tail", "echo tail"),
    ];
    unit
}

fn tools(envelopes: &[AgentIngestEnvelope]) -> Vec<AgentToolEventFact> {
    envelopes
        .iter()
        .flat_map(|envelope| envelope.facts.tool_events.clone())
        .collect()
}

#[tokio::test]
async fn partial_retry_keeps_the_same_first_duplicate_as_an_uninterrupted_upload() {
    let unit = duplicate_unit();
    let meta = BatchMeta {
        source: AgentSource::Codex,
        ..meta()
    };
    let original = session_facts(meta.source, &unit.records, &unit.ctx);
    assert_eq!(original.tool_events.len(), 3);
    assert_eq!(
        original.tool_events[0].tool_use_id,
        original.tool_events[1].tool_use_id
    );
    assert_ne!(original.tool_events[0], original.tool_events[1]);
    let tuning = SyncTuning {
        max_batch_bytes: 1,
        ..serial_tuning()
    };
    let mut mint = counter();
    let uninterrupted = MockClient::new(std::iter::repeat_with(ok).take(10));
    run_sync_cycle_tuned(
        &uninterrupted,
        &CursorStore::open_in_memory("baseline").unwrap(),
        &mut syncing_orchestrator(),
        &meta,
        std::slice::from_ref(&unit),
        &mut mint,
        None,
        tuning,
    )
    .await
    .unwrap();
    let expected = vec![
        original.tool_events[0].clone(),
        original.tool_events[2].clone(),
    ];
    let accepted_count = {
        let baseline = uninterrupted.envelopes.borrow();
        assert_eq!(tools(&baseline), expected);
        baseline
            .iter()
            .position(|envelope| !envelope.facts.tool_events.is_empty())
            .unwrap()
            + 1
    };

    let store = CursorStore::open_in_memory("org").unwrap();
    let partial = MockClient::new(std::iter::repeat_with(ok).take(accepted_count).chain(
        std::iter::once(Err(IngestError::EnqueueFailed { retry_after: None })),
    ));
    let (report, _) = run_sync_cycle_tuned(
        &partial,
        &store,
        &mut syncing_orchestrator(),
        &meta,
        std::slice::from_ref(&unit),
        &mut mint,
        None,
        tuning,
    )
    .await
    .unwrap();
    assert!(report.throttled);
    assert_eq!(report.advanced, 0);
    assert!(store
        .get(meta.source, "/duplicate.jsonl")
        .unwrap()
        .is_none());
    let mut accepted = tools(&partial.envelopes.borrow()[..accepted_count]);
    assert_eq!(accepted, original.tool_events[..1]);

    let retry = MockClient::new(std::iter::repeat_with(ok).take(10));
    let (report, _) = run_sync_cycle_tuned(
        &retry,
        &store,
        &mut syncing_orchestrator(),
        &meta,
        std::slice::from_ref(&unit),
        &mut mint,
        None,
        tuning,
    )
    .await
    .unwrap();
    assert_eq!(report.advanced, 1);
    accepted.extend(tools(&retry.envelopes.borrow()));
    assert_eq!(
        accepted, expected,
        "partial retries must preserve the uninterrupted winner"
    );
}

#[tokio::test]
async fn growing_session_does_not_resurrect_a_dropped_duplicate() {
    let mut unit = duplicate_unit();
    let meta = BatchMeta {
        source: AgentSource::Codex,
        ..meta()
    };
    let store = CursorStore::open_in_memory("org").unwrap();
    let mut mint = counter();
    let first = MockClient::new([ok()]);
    run_sync_cycle_tuned(
        &first,
        &store,
        &mut syncing_orchestrator(),
        &meta,
        std::slice::from_ref(&unit),
        &mut mint,
        None,
        serial_tuning(),
    )
    .await
    .unwrap();
    assert_eq!(tools(&first.envelopes.borrow()).len(), 2);

    unit.records.push(call("new-call", "echo new"));
    let original = session_facts(meta.source, &unit.records, &unit.ctx);
    let retry = MockClient::new([ok()]);
    let (report, _) = run_sync_cycle_tuned(
        &retry,
        &store,
        &mut syncing_orchestrator(),
        &meta,
        std::slice::from_ref(&unit),
        &mut mint,
        None,
        serial_tuning(),
    )
    .await
    .unwrap();
    assert_eq!(report.advanced, 1);
    assert_eq!(tools(&retry.envelopes.borrow()), original.tool_events[3..]);
}
