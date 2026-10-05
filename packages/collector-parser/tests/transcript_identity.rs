// SPDX-License-Identifier: Apache-2.0
//! Identity regressions from real transcript shapes (TRA-322): Claude's compact_boundary tail
//! re-append and Codex continuation rollouts must each yield one fact per identity.

use std::collections::HashSet;

use collector_contracts::enums::AgentSource;
use collector_contracts::envelope::AgentIngestFacts;
use collector_parser::assemble::session_facts;
use collector_parser::session_context::SessionContext;
use serde_json::{json, Value};

fn ctx(session: &str) -> SessionContext {
    SessionContext {
        vendor_session_id: session.to_string(),
        repo_root: "/work/repo".to_string(),
        vendor_started_at: Some(1_778_964_000_000),
        ..SessionContext::default()
    }
}

fn claude_user(uuid: &str, ts: &str) -> Value {
    json!({
        "type": "user", "uuid": uuid, "timestamp": ts, "promptId": "p1",
        "message": { "role": "user", "content": "please edit the file" }
    })
}

fn claude_assistant(uuid: &str, ts: &str) -> Value {
    json!({
        "type": "assistant", "uuid": uuid, "timestamp": ts,
        "message": {
            "id": "msg_1", "model": "claude-opus-4-7", "role": "assistant",
            "content": [
                { "type": "text", "text": "editing" },
                { "type": "tool_use", "id": "toolu_1", "name": "Edit",
                  "input": { "file_path": "/work/repo/src/lib.rs", "command": "edit" } }
            ],
            "usage": { "input_tokens": 5, "output_tokens": 7 }
        }
    })
}

fn claude_tool_result(uuid: &str, ts: &str) -> Value {
    json!({
        "type": "user", "uuid": uuid, "timestamp": ts,
        "message": { "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": "toolu_1", "content": "ok" }
        ] },
        "toolUseResult": { "stdout": "ok" }
    })
}

#[test]
fn compact_boundary_reappend_emits_one_fact_per_identity_at_its_first_position() {
    let mut records = vec![
        claude_user("u-1", "2026-10-01T10:00:00Z"),
        claude_assistant("a-1", "2026-10-01T10:00:01Z"),
        claude_tool_result("r-1", "2026-10-01T10:00:02Z"),
        json!({ "type": "system", "subtype": "compact_boundary", "uuid": "boundary" }),
    ];
    // The re-appended tail keeps every id; real copies also differ in fields like cwd and promptId.
    let mut reappended = [
        claude_user("u-1", "2026-10-01T11:00:00Z"),
        claude_assistant("a-1", "2026-10-01T11:00:01Z"),
        claude_tool_result("r-1", "2026-10-01T11:00:02Z"),
    ];
    reappended[0]["promptId"] = json!("p2");
    records.extend(reappended);
    records.push(claude_user("u-2", "2026-10-01T11:05:00Z"));

    let facts = session_facts(AgentSource::Claude, &records, &ctx("claude-1"));

    let messages: Vec<_> = facts
        .messages
        .iter()
        .map(|m| (m.vendor_message_id.clone().unwrap(), m.turn_index))
        .collect();
    assert_eq!(
        messages,
        [
            ("u-1".to_string(), 0),
            ("msg_1".to_string(), 1),
            ("u-2".to_string(), 2)
        ]
    );
    assert_eq!(facts.tool_events.len(), 1);
    assert_eq!(facts.tool_events[0].tool_use_id.as_deref(), Some("toolu_1"));
    assert_eq!(facts.tool_events[0].source_block_index, 1);
    assert_eq!(facts.file_events.len(), 1);
    assert_eq!(facts.file_events[0].source_block_index, 1);
}

fn codex_meta(id: &str, history_base: Option<Value>) -> Value {
    let mut payload =
        json!({ "id": id, "cwd": "/work/repo", "base_instructions": { "text": "be brief" } });
    if let Some(base) = history_base {
        payload["history_base"] = base;
        payload["history_mode"] = json!("paginated");
    }
    json!({ "type": "session_meta", "timestamp": "2026-10-01T10:00:00Z", "payload": payload })
}

fn codex_user(text: &str) -> Value {
    json!({ "type": "response_item", "timestamp": "2026-10-01T10:00:01Z",
            "payload": { "type": "message", "role": "user",
                         "content": [{ "type": "input_text", "text": text }] } })
}

fn codex_patch(call_id: &str) -> Value {
    json!({ "type": "response_item", "timestamp": "2026-10-01T10:00:02Z",
            "payload": { "type": "function_call", "name": "apply_patch", "call_id": call_id,
                         "arguments": "*** Begin Patch\n*** Update File: src/lib.rs\n*** End Patch" } })
}

fn codex_assistant(link: &str) -> Value {
    json!({ "type": "response_item", "timestamp": "2026-10-01T10:00:03Z",
            "payload": { "type": "message", "role": "assistant",
                         "content": [{ "type": "output_text", "text": link }] } })
}

/// A `token_count` whose cumulative total is `cumulative` and whose own turn total is `last`, with all
/// tokens attributed to output so the totals are easy to follow.
fn codex_tokens(cumulative: i64, last: i64) -> Value {
    let usage = |total: i64| {
        json!({ "input_tokens": 0, "cached_input_tokens": 0, "output_tokens": total,
                "reasoning_output_tokens": 0, "total_tokens": total })
    };
    json!({ "type": "event_msg", "timestamp": "2026-10-01T10:00:04Z",
            "payload": { "type": "token_count",
                         "info": { "total_token_usage": usage(cumulative),
                                   "last_token_usage": usage(last) } } })
}

fn identities(facts: &AgentIngestFacts) -> HashSet<String> {
    let mut ids = HashSet::new();
    for m in &facts.messages {
        let key = m
            .vendor_message_id
            .clone()
            .unwrap_or_else(|| format!("turn:{}", m.turn_index));
        assert!(ids.insert(format!("messages|{key}")), "duplicate {key}");
    }
    for f in &facts.file_events {
        let key = format!(
            "files|{}|{}|{:?}|{}",
            f.vendor_message_id.as_deref().unwrap_or(""),
            f.normalized_repo_path,
            f.operation,
            f.source_block_index
        );
        assert!(ids.insert(key.clone()), "duplicate {key}");
    }
    for c in &facts.capability_snapshots {
        let key = c
            .source_snapshot_id
            .clone()
            .unwrap_or_else(|| format!("turn:{}", c.stable_turn_index));
        assert!(ids.insert(format!("caps|{key}")), "duplicate {key}");
    }
    for p in &facts.pull_request_links {
        let key = p
            .source_event_id
            .clone()
            .unwrap_or_else(|| format!("turn:{}", p.stable_turn_index));
        assert!(
            ids.insert(format!("links|{key}|{}", p.url)),
            "duplicate {key}"
        );
    }
    ids
}

fn assistant_tokens(facts: &AgentIngestFacts) -> i64 {
    facts.messages.iter().map(|m| m.output_tokens).sum()
}

#[test]
fn codex_continuation_page_has_distinct_identities_and_does_not_recount_parent_tokens() {
    let link = "https://github.com/acme/app/pull/7";
    let parent = vec![
        codex_meta("sess-1", None),
        codex_user("start"),
        codex_patch("call-1"),
        codex_assistant(link),
        codex_tokens(100, 100),
        codex_user("more"),
        codex_tokens(250, 150),
    ];
    // The page's cumulative continues from the parent's 250 at the fork.
    let page = vec![
        codex_meta(
            "sess-1",
            Some(
                json!({ "thread_id": "sess-1", "end_ordinal_exclusive": 7, "end_byte_offset": 900 }),
            ),
        ),
        codex_user("continue"),
        codex_patch("call-2"),
        codex_assistant(link),
        codex_tokens(290, 40),
        codex_user("again"),
        codex_tokens(350, 60),
    ];

    let parent_facts = session_facts(AgentSource::Codex, &parent, &ctx("sess-1"));
    let page_facts = session_facts(AgentSource::Codex, &page, &ctx("sess-1"));

    let parent_ids = identities(&parent_facts);
    let page_ids = identities(&page_facts);
    assert!(
        parent_ids.is_disjoint(&page_ids),
        "continuation identities collide with the parent: {:?}",
        parent_ids.intersection(&page_ids).collect::<Vec<_>>()
    );
    assert!(page_facts.messages.iter().all(|m| m
        .vendor_message_id
        .as_deref()
        .is_some_and(|id| id.starts_with("history:7:turn:"))));

    assert_eq!(assistant_tokens(&parent_facts), 250);
    assert_eq!(assistant_tokens(&page_facts), 100);
    assert_eq!(
        assistant_tokens(&parent_facts) + assistant_tokens(&page_facts),
        350,
        "the two files together sum to the thread's final cumulative"
    );
}
