// SPDX-License-Identifier: Apache-2.0
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

use crate::codex_usage::{cumulative_usage, last_token_usage, CodexTurnUsage, CumulativeUsage};

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
    // The last *counted* cumulative snapshot. A turn's usage is the diff from this to the current
    // snapshot (ccusage-correct), so the kept turns sum to the session's final cumulative by
    // construction. Starts at zero (the implicit pre-session total), so the first real snapshot's delta
    // is itself.
    let mut prev_cumulative = CumulativeUsage::default();
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
                let Some(cumulative) = payload.and_then(cumulative_usage) else {
                    continue;
                };
                // Per-turn usage = diff of successive cumulative snapshots (ccusage#884). Three cases:
                let usage: Option<CodexTurnUsage> =
                    if cumulative.total_tokens > prev_cumulative.total_tokens {
                        // Normal advance: the delta since the last counted snapshot.
                        let u = cumulative.delta_since(prev_cumulative);
                        prev_cumulative = cumulative;
                        Some(u)
                    } else if cumulative.total_tokens == prev_cumulative.total_tokens {
                        // Unchanged cumulative = duplicate snapshot Codex re-emits → contributes nothing.
                        continue;
                    } else {
                        // Cumulative went backwards: a session reset/rollback (e.g. resumed/compacted
                        // context). The cumulative is no longer a continuation of `prev`, so fall back to
                        // this row's own `last_token_usage` and re-baseline `prev` to the new snapshot. If
                        // that row has no usable `last_token_usage` either, leave it `None` — the turn ran
                        // but its tokens are unknown, which the emitter maps to `Missing` coverage. Coercing
                        // to zero would falsely claim known full coverage and undercount.
                        prev_cumulative = cumulative;
                        payload.and_then(last_token_usage)
                    };
                turns.push(CodexTurn {
                    turn_index: next_index,
                    role: CodexTurnRole::Assistant,
                    usage,
                    record,
                });
                next_index += 1;
                pending_activity = None;
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

    /// A `token_count` event whose CUMULATIVE `total_token_usage` is `cum` =
    /// `(raw_input, cached, output, reasoning, total)`. Per-turn usage is derived by diffing these
    /// snapshots (ccusage#884), so the cumulative carries the full breakdown. `last` sets
    /// `last_token_usage` (only consulted on a reset/rollback); pass `None` for the null early emission
    /// and when the row isn't a reset it's ignored.
    fn token_count_cum(
        cum: (i64, i64, i64, i64, i64),
        last: Option<(i64, i64, i64, i64, i64)>,
    ) -> Value {
        let (ci, cc, co, cr, ct) = cum;
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
                    "total_token_usage": {
                        "input_tokens": ci,
                        "cached_input_tokens": cc,
                        "output_tokens": co,
                        "reasoning_output_tokens": cr,
                        "total_tokens": ct,
                    },
                },
            },
        })
    }

    /// A token-count-only session (no message records): a leading null/zero event, monotonic
    /// cumulative snapshots, and two duplicate emissions. Six real assistant turns; the diffed usages
    /// sum to the final cumulative total of 299_113.
    fn token_only_session() -> Vec<Value> {
        // cumulative (raw_input, cached, output, reasoning, total)
        vec![
            token_count_cum((0, 0, 0, 0, 0), None),
            token_count_cum((20_480, 0, 200, 0, 20_680), None),
            token_count_cum((60_480, 10_000, 419, 40, 60_899), None),
            token_count_cum((112_980, 40_000, 727, 100, 113_707), None),
            token_count_cum((169_980, 85_000, 1_161, 180, 171_141), None),
            token_count_cum((169_980, 85_000, 1_161, 180, 171_141), None), // duplicate
            token_count_cum((233_374, 105_352, 1_663, 303, 235_037), None),
            token_count_cum((233_374, 105_352, 1_663, 303, 235_037), None), // duplicate
            token_count_cum((297_011, 162_056, 2_102, 303, 299_113), None),
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
            token_count_cum((1_000, 0, 50, 0, 1_050), None),
            activity("reasoning"), // a reasoning/tool-only turn: tokens but no message record
            token_count_cum((1_500, 0, 70, 0, 1_570), None),
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
            token_count_cum((900, 0, 30, 0, 930), None),
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
            token_count_cum((10, 0, 5, 0, 15), None),
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
        // Guard: `total_token_usage.total_tokens` is cumulative; adding it across events explodes far
        // past the real total. session_turns DIFFS successive snapshots, never sums them.
        let records = token_only_session();
        let trap: i64 = records
            .iter()
            .filter_map(|r| {
                r.get("payload")
                    .and_then(crate::codex_usage::cumulative_total)
            })
            .sum();
        assert_eq!(trap, 1_306_755);
        assert!(trap > 299_113 * 3);
    }

    #[test]
    fn duplicate_snapshots_contribute_zero_and_diffs_match_the_final_total() {
        // The ccusage#884 fix: a row whose cumulative did not advance is a duplicate and adds nothing;
        // the kept turns' usages sum EXACTLY to the session's final cumulative, regardless of what the
        // (possibly lagging) `last_token_usage` rows said.
        let records = token_only_session();
        let turns = session_turns(records.iter());
        assert_eq!(turns.len(), 6, "two duplicate snapshots dropped");
        let summed: i64 = turns
            .iter()
            .filter_map(|t| t.usage.map(|u| u.total_tokens))
            .sum();
        assert_eq!(summed, 299_113);
        // The per-turn split also reconstructs: a turn's input+cache_read+output == its total.
        for t in &turns {
            let u = t.usage.expect("assistant usage");
            assert_eq!(
                u.input_tokens + u.cache_read_tokens + u.output_tokens,
                u.total_tokens
            );
        }
    }

    #[test]
    fn a_cumulative_rollback_falls_back_to_last_token_usage() {
        // A resumed/compacted session can reset its cumulative downward. The post-reset row is not a
        // continuation of the prior cumulative, so its usage comes from `last_token_usage` and the
        // baseline re-anchors to the new snapshot.
        let records = [
            token_count_cum((100_000, 50_000, 1_000, 0, 101_000), None),
            // cumulative dropped (reset): fall back to last_token_usage (raw 800, cached 200, out 40).
            token_count_cum(
                (10_000, 5_000, 200, 0, 10_200),
                Some((800, 200, 40, 0, 840)),
            ),
            // normal advance after reset: diff from the re-anchored 10_200 baseline.
            token_count_cum((12_000, 6_000, 260, 0, 12_260), None),
        ];
        let turns = session_turns(records.iter());
        assert_eq!(turns.len(), 3);
        // turn 0: first snapshot, delta from zero → its own cumulative.
        assert_eq!(turns[0].usage.unwrap().total_tokens, 101_000);
        // turn 1: reset → last_token_usage. input = 800-200 = 600, cache_read 200, out 40.
        let r = turns[1].usage.unwrap();
        assert_eq!(
            (r.input_tokens, r.cache_read_tokens, r.output_tokens),
            (600, 200, 40)
        );
        // turn 2: diff from re-anchored baseline 10_200 → total 2_060.
        assert_eq!(turns[2].usage.unwrap().total_tokens, 2_060);
    }

    #[test]
    fn a_rollback_with_no_last_token_usage_yields_unknown_not_zero() {
        // Reset row whose `last_token_usage` is null: the turn ran but its tokens are unknown. Usage
        // must be `None` (→ Missing coverage downstream), NOT a zero-token turn that falsely claims
        // full coverage and undercounts.
        let records = [
            token_count_cum((100_000, 50_000, 1_000, 0, 101_000), None),
            token_count_cum((10_000, 5_000, 200, 0, 10_200), None), // rollback, no last_token_usage
        ];
        let turns = session_turns(records.iter());
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].usage.unwrap().total_tokens, 101_000);
        assert_eq!(
            turns[1].usage, None,
            "unknown rollback usage stays unknown, not zero"
        );
    }

    #[test]
    fn empty_session_yields_no_turns() {
        assert!(session_turns([].iter()).is_empty());
    }
}
