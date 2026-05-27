// SPDX-License-Identifier: MIT
// Adapted from otto-parser/src/parser/codex_cli/mod.rs `turn_index_counter` (~/src/otto, 2026-05-25).
// Reworked: otto bumps its turn counter inside the event-emission state machine, only when an event is
// actually flushed and *after* scaffold/role filtering — so a re-parse whose scaffold heuristic changes
// renumbers the turns, which is exactly the fragility the ADR flags for Codex `message_pk` (it has no
// vendor message ID and falls back to (session, positional turn index)). Trace Flow assigns the index
// purely from structural file position over `response_item` `message` records, before any role or
// scaffold filtering, so the emitter can drop developer/scaffold messages without renumbering the rest
// and a re-parse is bit-stable. Token-to-message attribution (including reasoning/tool-only token turns
// that carry no message record) stays with the downstream emitter; this module only numbers.
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Codex positional turn indexing. `session_message_turns` assigns each Codex `response_item` `message`
//! record a stable 0-based [`CodexMessageTurn::turn_index`] in file order — the positional surrogate
//! that stands in for the vendor message ID Codex never emits, and that `message_pk` hashes. The index
//! is a pure function of record order, so re-parsing the same session never renumbers it.

use serde_json::Value;

/// The conversation role on a Codex `message` record, reported as-is so the emitter (not this leaf)
/// decides which roles become `AgentMessageFact` rows. `Developer` is the system/instruction preamble;
/// `Other` covers any future or unexpected role string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexMessageRole {
    User,
    Assistant,
    Developer,
    Other,
}

impl CodexMessageRole {
    fn from_str(role: &str) -> Self {
        match role {
            "user" => Self::User,
            "assistant" => Self::Assistant,
            "developer" => Self::Developer,
            _ => Self::Other,
        }
    }
}

/// One Codex `message` record with its positional turn index. `record` borrows the source `Value` so
/// the emitter can read content, timestamp, and usage off it; `turn_index` is its 0-based ordinal among
/// `message` records in file order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodexMessageTurn<'a> {
    pub turn_index: i64,
    pub role: CodexMessageRole,
    pub record: &'a Value,
}

fn is_message_record(record: &Value) -> bool {
    record.get("type").and_then(Value::as_str) == Some("response_item")
        && record
            .get("payload")
            .and_then(|p| p.get("type"))
            .and_then(Value::as_str)
            == Some("message")
}

/// Numbers a Codex session's `message` records in file order, 0-based.
///
/// Only `response_item` records whose `payload.type` is `message` are counted; reasoning, function
/// calls, `token_count` events, `turn_context`, and the `event_msg` render duplicates
/// (`agent_message` / `user_message`, which mirror the canonical `response_item` content and would
/// double-count) are skipped and do not consume an index. The index is assigned before any role or
/// scaffold filtering, so dropping developer/scaffold messages downstream leaves the surviving indices
/// untouched — the stability `message_pk` depends on.
pub fn session_message_turns<'a, I>(records: I) -> Vec<CodexMessageTurn<'a>>
where
    I: IntoIterator<Item = &'a Value>,
{
    let mut turns = Vec::new();
    let mut next_index = 0i64;
    for record in records {
        if !is_message_record(record) {
            continue;
        }
        let role = record
            .get("payload")
            .and_then(|p| p.get("role"))
            .and_then(Value::as_str)
            .map(CodexMessageRole::from_str)
            .unwrap_or(CodexMessageRole::Other);
        turns.push(CodexMessageTurn {
            turn_index: next_index,
            role,
            record,
        });
        next_index += 1;
    }
    turns
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(role: &str) -> Value {
        json!({
            "type": "response_item",
            "payload": { "type": "message", "role": role, "content": [] },
        })
    }

    fn non_message(payload_type: &str) -> Value {
        json!({ "type": "response_item", "payload": { "type": payload_type } })
    }

    /// The interleaving seen in real rollouts: developer preamble, user prompt, then assistant turns
    /// separated by reasoning / function-call / token_count records and their event_msg duplicates.
    fn session() -> Vec<Value> {
        vec![
            json!({ "type": "session_meta", "payload": {} }),
            json!({ "type": "event_msg", "payload": { "type": "task_started" } }),
            message("developer"),
            message("user"),
            json!({ "type": "turn_context", "payload": {} }),
            json!({ "type": "event_msg", "payload": { "type": "user_message" } }),
            non_message("reasoning"),
            json!({ "type": "event_msg", "payload": { "type": "agent_message" } }),
            message("assistant"),
            non_message("function_call"),
            non_message("function_call_output"),
            json!({ "type": "event_msg", "payload": { "type": "token_count" } }),
            non_message("reasoning"),
            message("assistant"),
            json!({ "type": "event_msg", "payload": { "type": "token_count" } }),
        ]
    }

    #[test]
    fn numbers_message_records_in_file_order() {
        let records = session();
        let turns = session_message_turns(records.iter());
        let indices: Vec<_> = turns.iter().map(|t| t.turn_index).collect();
        let roles: Vec<_> = turns.iter().map(|t| t.role).collect();
        assert_eq!(indices, [0, 1, 2, 3]);
        assert_eq!(
            roles,
            [
                CodexMessageRole::Developer,
                CodexMessageRole::User,
                CodexMessageRole::Assistant,
                CodexMessageRole::Assistant,
            ]
        );
    }

    #[test]
    fn skips_non_message_records_without_consuming_an_index() {
        // reasoning / function_call / token_count / turn_context / session_meta never get an index.
        let records = session();
        let turns = session_message_turns(records.iter());
        assert_eq!(turns.len(), 4);
    }

    #[test]
    fn event_msg_render_duplicates_are_not_counted() {
        // agent_message / user_message mirror the response_item content; counting them double-counts.
        let records = [
            message("user"),
            json!({ "type": "event_msg", "payload": { "type": "user_message" } }),
            message("assistant"),
            json!({ "type": "event_msg", "payload": { "type": "agent_message" } }),
        ];
        assert_eq!(session_message_turns(records.iter()).len(), 2);
    }

    #[test]
    fn re_parsing_the_same_session_yields_identical_indices() {
        let records = session();
        let first: Vec<_> = session_message_turns(records.iter())
            .iter()
            .map(|t| (t.turn_index, t.role))
            .collect();
        let second: Vec<_> = session_message_turns(records.iter())
            .iter()
            .map(|t| (t.turn_index, t.role))
            .collect();
        assert_eq!(first, second);
    }

    #[test]
    fn dropping_a_leading_message_downstream_does_not_renumber_the_rest() {
        // The emitter drops the developer preamble; the conversation messages keep their indices because
        // the index is structural (assigned before role filtering), not a count of emitted rows.
        let records = session();
        let turns = session_message_turns(records.iter());
        let user = turns
            .iter()
            .find(|t| t.role == CodexMessageRole::User)
            .expect("a user message");
        // The developer message held index 0, so the user message is index 1, not 0.
        assert_eq!(user.turn_index, 1);
    }

    #[test]
    fn index_follows_file_order_not_timestamps() {
        // Timestamps are never read here, so out-of-order or missing ones cannot perturb numbering — the
        // determinism the ADR requires against a re-parse that might sort differently.
        let records = [
            json!({ "type": "response_item", "payload": { "type": "message", "role": "user" }, "timestamp": "2026-05-26T09:00:00Z" }),
            json!({ "type": "response_item", "payload": { "type": "message", "role": "assistant" }, "timestamp": "2026-05-26T08:00:00Z" }),
        ];
        let turns = session_message_turns(records.iter());
        assert_eq!(turns[0].role, CodexMessageRole::User);
        assert_eq!(turns[0].turn_index, 0);
        assert_eq!(turns[1].role, CodexMessageRole::Assistant);
        assert_eq!(turns[1].turn_index, 1);
    }

    #[test]
    fn unknown_role_maps_to_other() {
        let records = [message("tool")];
        assert_eq!(
            session_message_turns(records.iter())[0].role,
            CodexMessageRole::Other
        );
    }

    #[test]
    fn empty_session_yields_no_turns() {
        assert!(session_message_turns([].iter()).is_empty());
    }
}
