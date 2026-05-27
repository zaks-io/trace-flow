// SPDX-License-Identifier: MIT
// Adapted from otto-parser/src/parser/codex_cli/mod.rs turn segmentation (~/src/otto, 2026-05-25).
// Reworked: otto threads a turn counter through its emission state machine and bumps it after
// scaffold/role filtering, so a re-parse whose heuristic changes renumbers turns — the fragility the ADR
// flags for Codex `message_pk`, which has no vendor message ID and falls back to (session, positional
// turn index). Trace Flow segments turns purely from structural file position: one turn per user message
// and one per `token_count`-bounded assistant turn, numbered 0-based in file order. An assistant turn is
// the token-bearing grain (CONTEXT: "the grain at which token counts are recorded"), so a reasoning- or
// tool-only turn that has tokens but no `message` record still becomes a turn and carries its tokens —
// nothing is dropped. The `token_count` dedup (keep only when the cumulative advances) is shared with
// the usage reader, so the kept assistant turns sum to the session's final total by construction.
// Building message text and model from the records a turn spans stays with the downstream emitter.
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Codex per-turn segmentation. `session_turns` walks a Codex session's records in file order and emits
//! one [`CodexTurn`] per user message and per `token_count`-bounded assistant turn, each with a stable
//! 0-based `turn_index` (the positional surrogate `message_pk` hashes) and, for assistant turns, the
//! turn's [`CodexTurnUsage`]. Re-parsing the same session never renumbers, and the assistant turns'
//! tokens sum to the session total.

use serde_json::Value;

use crate::codex_usage::{cumulative_total, last_token_usage, CodexTurnUsage};

/// Whether a turn is a user message or an assistant (model) turn. Codex's `developer` preamble is not a
/// conversation turn and gets no index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexTurnRole {
    User,
    Assistant,
}

/// One Codex turn. `turn_index` is its 0-based position in file order; `usage` is `Some` for an
/// assistant turn closed by a `token_count` and `None` for a user turn or an assistant turn the session
/// ended (or a user message interrupted) before any `token_count`. `record` borrows the turn's
/// representative record — the user message, the closing `token_count`, or the last assistant activity —
/// so the emitter can read its timestamp and assemble content from there.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CodexTurn<'a> {
    pub turn_index: i64,
    pub role: CodexTurnRole,
    pub usage: Option<CodexTurnUsage>,
    pub record: &'a Value,
}

enum RecordKind {
    UserMessage,
    AssistantActivity,
    TokenCount,
    Ignore,
}

fn classify(record: &Value) -> RecordKind {
    let rtype = record.get("type").and_then(Value::as_str);
    let payload = record.get("payload");
    let ptype = payload.and_then(|p| p.get("type")).and_then(Value::as_str);
    match (rtype, ptype) {
        (Some("response_item"), Some("message")) => {
            match payload.and_then(|p| p.get("role")).and_then(Value::as_str) {
                Some("user") => RecordKind::UserMessage,
                Some("assistant") => RecordKind::AssistantActivity,
                // developer/system preamble or an unknown role: not a conversation turn.
                _ => RecordKind::Ignore,
            }
        }
        // reasoning, function_call(_output), tool_search_*, custom_tool_* — all assistant-turn activity.
        (Some("response_item"), _) => RecordKind::AssistantActivity,
        (Some("event_msg"), Some("token_count")) => RecordKind::TokenCount,
        // event_msg render duplicates (agent_message/user_message), task_*, turn_context, session_meta.
        _ => RecordKind::Ignore,
    }
}

/// Segments a Codex session's records into per-turn [`CodexTurn`]s in file order. See the module docs:
/// one turn per user message and per `token_count`-bounded assistant turn, with duplicate `token_count`
/// emissions (cumulative does not advance) dropped so the kept turns sum to the session total.
pub fn session_turns<'a, I>(records: I) -> Vec<CodexTurn<'a>>
where
    I: IntoIterator<Item = &'a Value>,
{
    let mut turns = Vec::new();
    let mut next_index = 0i64;
    let mut last_kept_cumulative = 0i64;
    // The most recent assistant-activity record not yet closed into a turn. An assistant turn normally
    // closes on its `token_count`; this flushes one that a user message or end-of-session closes instead.
    let mut pending_activity: Option<&'a Value> = None;

    for record in records {
        match classify(record) {
            RecordKind::UserMessage => {
                if let Some(activity) = pending_activity.take() {
                    turns.push(CodexTurn {
                        turn_index: next_index,
                        role: CodexTurnRole::Assistant,
                        usage: None,
                        record: activity,
                    });
                    next_index += 1;
                }
                turns.push(CodexTurn {
                    turn_index: next_index,
                    role: CodexTurnRole::User,
                    usage: None,
                    record,
                });
                next_index += 1;
            }
            RecordKind::AssistantActivity => pending_activity = Some(record),
            RecordKind::TokenCount => {
                let payload = record.get("payload");
                let Some(cumulative) = payload.and_then(cumulative_total) else {
                    continue;
                };
                if cumulative > last_kept_cumulative {
                    last_kept_cumulative = cumulative;
                    turns.push(CodexTurn {
                        turn_index: next_index,
                        role: CodexTurnRole::Assistant,
                        usage: payload.and_then(last_token_usage),
                        record,
                    });
                    next_index += 1;
                    pending_activity = None;
                }
            }
            RecordKind::Ignore => {}
        }
    }
    if let Some(activity) = pending_activity {
        turns.push(CodexTurn {
            turn_index: next_index,
            role: CodexTurnRole::Assistant,
            usage: None,
            record: activity,
        });
    }
    turns
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(role: &str) -> Value {
        json!({ "type": "response_item", "payload": { "type": "message", "role": role, "content": [] } })
    }

    fn activity(payload_type: &str) -> Value {
        json!({ "type": "response_item", "payload": { "type": payload_type } })
    }

    fn event_dup(payload_type: &str) -> Value {
        json!({ "type": "event_msg", "payload": { "type": payload_type } })
    }

    /// A `token_count` event. `last` is `(input, cached, output, reasoning, total)`; `cumulative` is the
    /// running `total_token_usage.total_tokens`. `None` `last` is the null early-session emission.
    fn token_count(last: Option<(i64, i64, i64, i64, i64)>, cumulative: i64) -> Value {
        let last_usage = match last {
            Some((input, cached, output, reasoning, total)) => json!({
                "input_tokens": input,
                "cached_input_tokens": cached,
                "output_tokens": output,
                "reasoning_output_tokens": reasoning,
                "total_tokens": total,
            }),
            None => Value::Null,
        };
        json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": last_usage,
                    "total_token_usage": { "total_tokens": cumulative },
                },
            },
        })
    }

    /// A token-count-only session (no message records): a leading null event, monotonic cumulatives, and
    /// two duplicate emissions. Six real assistant turns summing to 299_113.
    fn token_only_session() -> Vec<Value> {
        vec![
            token_count(None, 0),
            token_count(Some((20_480, 0, 200, 0, 20_680)), 20_680),
            token_count(Some((40_000, 10_000, 219, 40, 40_219)), 60_899),
            token_count(Some((52_500, 30_000, 308, 60, 52_808)), 113_707),
            token_count(Some((57_000, 45_000, 434, 80, 57_434)), 171_141),
            token_count(Some((57_000, 45_000, 434, 80, 57_434)), 171_141), // duplicate
            token_count(Some((63_394, 20_352, 502, 123, 63_896)), 235_037),
            token_count(Some((63_394, 20_352, 502, 123, 63_896)), 235_037), // duplicate
            token_count(Some((63_637, 56_704, 439, 0, 64_076)), 299_113),
        ]
    }

    #[test]
    fn segments_user_and_assistant_turns_in_file_order() {
        let records = [
            message("developer"),
            message("user"),
            activity("reasoning"),
            message("assistant"),
            activity("function_call"),
            token_count(Some((1_000, 0, 50, 0, 1_050)), 1_050),
            activity("reasoning"), // a reasoning/tool-only turn: tokens but no message record
            token_count(Some((500, 0, 20, 0, 520)), 1_570),
        ];
        let turns = session_turns(records.iter());
        let shape: Vec<_> = turns
            .iter()
            .map(|t| (t.turn_index, t.role, t.usage.is_some()))
            .collect();
        assert_eq!(
            shape,
            [
                (0, CodexTurnRole::User, false),
                (1, CodexTurnRole::Assistant, true),
                (2, CodexTurnRole::Assistant, true), // tool-only turn still carries its tokens
            ]
        );
    }

    #[test]
    fn a_tool_only_turn_carries_its_tokens() {
        // The whole point of the per-turn grain: a turn with tokens but no `message` record is not lost.
        let records = [
            activity("reasoning"),
            activity("function_call"),
            token_count(Some((900, 0, 30, 0, 930)), 930),
        ];
        let turns = session_turns(records.iter());
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].role, CodexTurnRole::Assistant);
        assert_eq!(turns[0].usage.expect("usage").total_tokens, 930);
    }

    #[test]
    fn drops_duplicate_emissions_and_the_null_event() {
        let records = token_only_session();
        // 9 events: 1 null + 8 with usage, of which 2 are duplicates => 6 real turns.
        assert_eq!(session_turns(records.iter()).len(), 6);
    }

    #[test]
    fn assistant_turn_usages_sum_to_the_final_total() {
        let records = token_only_session();
        let summed: i64 = session_turns(records.iter())
            .iter()
            .filter_map(|t| t.usage.map(|u| u.total_tokens))
            .sum();
        // Equals the last event's cumulative `total_token_usage.total_tokens`, the ground truth.
        assert_eq!(summed, 299_113);
    }

    #[test]
    fn an_assistant_turn_closed_by_a_user_message_has_no_usage() {
        // Assistant activity with no token_count, then a user message: the activity flushes as a turn
        // with unknown tokens (None), then the user turn follows.
        let records = [activity("reasoning"), message("user")];
        let turns = session_turns(records.iter());
        assert_eq!(turns[0].role, CodexTurnRole::Assistant);
        assert_eq!(turns[0].usage, None);
        assert_eq!(turns[1].role, CodexTurnRole::User);
        assert_eq!(turns[1].turn_index, 1);
    }

    #[test]
    fn trailing_assistant_activity_flushes_at_end_of_session() {
        let records = [message("user"), activity("function_call")];
        let turns = session_turns(records.iter());
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[1].role, CodexTurnRole::Assistant);
        assert_eq!(turns[1].usage, None);
    }

    #[test]
    fn event_msg_render_duplicates_are_not_turns() {
        // agent_message / user_message mirror the response_item content; counting them double-counts.
        let records = [
            message("user"),
            event_dup("user_message"),
            message("assistant"),
            event_dup("agent_message"),
            token_count(Some((10, 0, 5, 0, 15)), 15),
        ];
        // user turn + one assistant turn (closed by token_count); the two event_msg are ignored.
        assert_eq!(session_turns(records.iter()).len(), 2);
    }

    #[test]
    fn re_parsing_the_same_session_yields_identical_turns() {
        let records = token_only_session();
        let first = session_turns(records.iter());
        let second = session_turns(records.iter());
        assert_eq!(first, second);
    }

    #[test]
    fn summing_the_cumulative_field_would_be_the_token_trap() {
        // Guard: `total_token_usage` is cumulative; adding it across events explodes far past the real
        // total. session_turns reads it only as a dedup key, never sums it.
        let records = token_only_session();
        let trap: i64 = records
            .iter()
            .filter_map(|r| r.get("payload").and_then(cumulative_total))
            .sum();
        assert_eq!(trap, 1_306_755);
        assert!(trap > 299_113 * 3);
    }

    #[test]
    fn empty_session_yields_no_turns() {
        assert!(session_turns([].iter()).is_empty());
    }
}
