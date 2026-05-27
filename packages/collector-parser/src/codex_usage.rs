// SPDX-License-Identifier: MIT
// Adapted from otto-parser/src/parser/codex_cli/usage.rs (~/src/otto, 2026-05-25). Reworked: otto
// reads one event's `last_token_usage` in isolation; Trace Flow must fold a whole session, and real
// Codex transcripts emit the same token_count more than once. Naively summing `last_token_usage`
// across events therefore overcounts, so this module deduplicates by the cumulative
// `total_token_usage` (kept only as a dedup key — summing *it* is the ~331x trap) so the kept turns
// sum to the session's final total by construction.
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Codex per-turn token usage. `session_turn_usages` folds a session's `token_count` events into one
//! [`CodexTurnUsage`] per real turn, the input to the per-message token fields on `AgentMessageFact`.
//! It is the home of the cumulative-token trap guard the 3a canary asserts against.

use serde_json::Value;

/// One Codex turn's token usage, read from a `token_count` event's `info.last_token_usage`.
///
/// `input_tokens` is the non-cached portion and `cache_read_tokens` the cached portion (Codex reports
/// a combined `input_tokens` that includes the cached count); with `output_tokens` they reconstruct
/// `total_tokens`. `reasoning_tokens` is a subset of `output_tokens` (informational, never added
/// again). Codex has no prompt-cache-creation split, so the matching `AgentMessageFact` cache-creation
/// fields stay 0.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CodexTurnUsage {
    pub input_tokens: i64,
    pub cache_read_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub total_tokens: i64,
}

fn field_i64(obj: &Value, key: &str) -> i64 {
    obj.get(key).and_then(Value::as_i64).unwrap_or(0)
}

/// Reads `info.last_token_usage` into a turn usage, or `None` when the event carries no usable usage
/// (a session's first token_count events report a null `last_token_usage`).
fn last_token_usage(payload: &Value) -> Option<CodexTurnUsage> {
    let usage = payload.get("info")?.get("last_token_usage")?;
    if !usage.is_object() {
        return None;
    }
    let raw_input = field_i64(usage, "input_tokens");
    let cache_read = field_i64(usage, "cached_input_tokens");
    let output = field_i64(usage, "output_tokens");
    let input_tokens = (raw_input - cache_read).max(0);
    // Reconstruct from the clamped components (not raw input) so a rebuilt total always equals the
    // sum of the fields we store, even on the malformed `cached > input` case.
    let total = usage
        .get("total_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(input_tokens + cache_read + output);
    Some(CodexTurnUsage {
        input_tokens,
        cache_read_tokens: cache_read,
        output_tokens: output,
        reasoning_tokens: field_i64(usage, "reasoning_output_tokens"),
        total_tokens: total,
    })
}

/// The running cumulative `info.total_token_usage.total_tokens`. Used ONLY to drop Codex's duplicate
/// token_count emissions; summing this field across events is the ~331x trap and is never done.
fn cumulative_total(payload: &Value) -> Option<i64> {
    payload
        .get("info")?
        .get("total_token_usage")?
        .get("total_tokens")?
        .as_i64()
}

/// Folds a session's `token_count` event payloads (in file order) into one [`CodexTurnUsage`] per real
/// turn.
///
/// Codex writes some token_count events twice: the duplicate repeats the prior `last_token_usage`
/// while its cumulative `total_token_usage` does not advance, so counting it double-counts tokens. An
/// event is kept only when its cumulative strictly advances past the last kept turn, which both drops
/// the duplicates and makes the kept turns' `total_tokens` sum to the session's final
/// `total_token_usage.total_tokens` by construction — the invariant the 3a canary asserts and the
/// guard against summing the cumulative field.
pub fn session_turn_usages<'a, I>(payloads: I) -> Vec<CodexTurnUsage>
where
    I: IntoIterator<Item = &'a Value>,
{
    let mut turns = Vec::new();
    let mut last_kept_cumulative = 0i64;
    for payload in payloads {
        let Some(usage) = last_token_usage(payload) else {
            continue;
        };
        // No cumulative means we cannot prove the event is new, so skip it rather than risk an
        // overcount; in practice `total_token_usage` always accompanies a non-null `last_token_usage`.
        if let Some(cumulative) = cumulative_total(payload) {
            if cumulative > last_kept_cumulative {
                last_kept_cumulative = cumulative;
                turns.push(usage);
            }
        }
    }
    turns
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Builds a `token_count` event payload. `last` is `(input, cached, output, reasoning, total)` for
    /// `last_token_usage` (`None` => the null early-session event); `cumulative` is
    /// `total_token_usage.total_tokens`.
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
            "info": {
                "last_token_usage": last_usage,
                "total_token_usage": { "total_tokens": cumulative },
            }
        })
    }

    /// The real shape from a captured session: a leading null-usage event, monotonic cumulative
    /// totals, and two duplicate emissions (cumulative does not advance).
    fn session() -> Vec<Value> {
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
    fn drops_duplicate_emissions_and_the_null_event() {
        let events = session();
        let turns = session_turn_usages(events.iter());
        // 9 events: 1 null + 8 with usage, of which 2 are duplicates => 6 real turns.
        assert_eq!(turns.len(), 6);
    }

    #[test]
    fn session_sum_matches_final_total_token_usage() {
        let events = session();
        let turns = session_turn_usages(events.iter());
        let summed: i64 = turns.iter().map(|t| t.total_tokens).sum();
        // Equals the last event's cumulative `total_token_usage.total_tokens`, the ground truth.
        assert_eq!(summed, 299_113);
    }

    #[test]
    fn naive_sum_of_last_token_usage_would_overcount() {
        // Demonstrates why dedup is required: summing every non-null `last_token_usage` double-counts
        // the two duplicate emissions (+57_434 +63_896) over the correct 299_113.
        let events = session();
        let naive: i64 = events
            .iter()
            .filter_map(last_token_usage)
            .map(|t| t.total_tokens)
            .sum();
        assert_eq!(naive, 420_443);
        assert_ne!(naive, 299_113);
    }

    #[test]
    fn summing_the_cumulative_field_is_the_token_trap() {
        // The ~331x trap: `total_token_usage` is cumulative, so adding it across events explodes far
        // past the real session total. `session_turn_usages` never reads it except as a dedup key.
        let events = session();
        let trap: i64 = events.iter().filter_map(cumulative_total).sum();
        assert_eq!(trap, 1_306_755);
        assert!(trap > 299_113 * 3);
    }

    #[test]
    fn splits_cached_input_and_keeps_reasoning_as_a_subset() {
        let events = session();
        let turns = session_turn_usages(events.iter());
        let last = turns.last().expect("a turn");
        // input_tokens is the non-cached remainder: 63_637 - 56_704 = 6_933.
        assert_eq!(last.input_tokens, 6_933);
        assert_eq!(last.cache_read_tokens, 56_704);
        assert_eq!(last.output_tokens, 439);
        assert_eq!(last.reasoning_tokens, 0);
        // Non-cached input + cache_read + output reconstructs the reported total.
        assert_eq!(
            last.input_tokens + last.cache_read_tokens + last.output_tokens,
            last.total_tokens
        );
    }

    #[test]
    fn empty_session_yields_no_turns() {
        assert!(session_turn_usages([].iter()).is_empty());
    }

    #[test]
    fn reconstructs_total_when_last_token_usage_omits_it() {
        let event = json!({
            "info": {
                "last_token_usage": {
                    "input_tokens": 1_000,
                    "cached_input_tokens": 250,
                    "output_tokens": 80,
                    "reasoning_output_tokens": 12
                },
                "total_token_usage": { "total_tokens": 5_000 }
            }
        });
        let turns = session_turn_usages([event].iter());
        let turn = turns.first().expect("a turn");
        assert_eq!(turn.input_tokens, 750); // 1_000 - 250 cached
        assert_eq!(turn.cache_read_tokens, 250);
        assert_eq!(turn.output_tokens, 80);
        assert_eq!(turn.reasoning_tokens, 12);
        // No `total_tokens` field, so it is rebuilt from the stored components.
        assert_eq!(
            turn.total_tokens,
            turn.input_tokens + turn.cache_read_tokens + turn.output_tokens
        );
        assert_eq!(turn.total_tokens, 1_080);
    }

    #[test]
    fn clamps_when_cached_exceeds_raw_input() {
        // Malformed event (cached > input) must not produce a negative input or an inconsistent total.
        let event = json!({
            "info": {
                "last_token_usage": {
                    "input_tokens": 100,
                    "cached_input_tokens": 250,
                    "output_tokens": 40
                },
                "total_token_usage": { "total_tokens": 9_000 }
            }
        });
        let turns = session_turn_usages([event].iter());
        let turn = turns.first().expect("a turn");
        assert_eq!(turn.input_tokens, 0); // clamped, not -150
        assert_eq!(turn.cache_read_tokens, 250);
        assert_eq!(turn.output_tokens, 40);
        assert_eq!(turn.total_tokens, 290); // 0 + 250 + 40, consistent with the stored components
    }
}
