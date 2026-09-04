// SPDX-License-Identifier: Apache-2.0
// Adapted from otto-parser/src/parser/claude_code/mod.rs (~/src/otto, 2026-05-25). Reworked: otto
// fingerprints and emits one fact *per JSONL record* (key includes the record's timestamp and
// content hash), so the several records Claude Code writes for a single `message.id` each carry the
// same `message.usage` and sum to a multiple of the true total. Trace Flow instead collapses usage by
// `message.id` so a turn's tokens count exactly once. Claude has no reasoning-token field and no
// session-level total, so reasoning stays 0 and `total_tokens` is reconstructed from the components.
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Claude Code per-message token usage. `session_message_usages` collapses a session's JSONL records
//! to one [`ClaudeMessageUsage`] per `message.id`, the input to the per-message token fields on
//! `AgentMessageFact`. It is the home of the repeated-`message.usage` trap the 3a canary asserts
//! against: Claude Code writes one record per content block of an assistant turn, every record
//! repeating that turn's full `usage`, so summing per record overcounts by the block count.

use std::collections::HashSet;

use serde_json::Value;

/// One Claude assistant message's token usage, collapsed across the records that share its
/// `message_id`.
///
/// `cache_creation_tokens` is the authoritative total prompt-cache-write count
/// (`usage.cache_creation_input_tokens`); `cache_creation_5m_tokens` / `cache_creation_1h_tokens` are
/// the per-TTL split from `usage.cache_creation.ephemeral_{5m,1h}_input_tokens` when present. Older
/// transcripts omit that nested breakdown, so the split stays `0/0` while the total is non-zero — the
/// tier is genuinely unknown and is never fabricated. `reasoning_tokens` is always 0: Claude counts
/// extended-thinking tokens inside `output_tokens` and emits no separate reasoning field.
/// `total_tokens` is reconstructed (`input + output + cache_read + cache_creation`); Claude usage
/// carries no session total of its own.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ClaudeMessageUsage {
    pub message_id: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_creation_5m_tokens: i64,
    pub cache_creation_1h_tokens: i64,
    pub reasoning_tokens: i64,
    pub total_tokens: i64,
}

fn field_i64(obj: &Value, key: &str) -> i64 {
    obj.get(key).and_then(Value::as_i64).unwrap_or(0)
}

/// Reads `message.usage` into a [`ClaudeMessageUsage`], or `None` when the record carries no
/// `message.id` or no `message.usage` object (user turns, tool results, summaries). The id is required
/// because it is the collapse key.
fn message_usage(record: &Value) -> Option<ClaudeMessageUsage> {
    let message = record.get("message")?;
    let message_id = message.get("id").and_then(Value::as_str)?.to_string();
    let usage = message.get("usage")?;
    if !usage.is_object() {
        return None;
    }

    let input_tokens = field_i64(usage, "input_tokens");
    let output_tokens = field_i64(usage, "output_tokens");
    let cache_read_tokens = field_i64(usage, "cache_read_input_tokens");

    // Per-TTL split, present only on newer transcripts; the total is the authoritative top-level
    // field, falling back to the split sum when that is absent.
    let (cache_creation_5m_tokens, cache_creation_1h_tokens) = match usage.get("cache_creation") {
        Some(breakdown) if breakdown.is_object() => (
            field_i64(breakdown, "ephemeral_5m_input_tokens"),
            field_i64(breakdown, "ephemeral_1h_input_tokens"),
        ),
        _ => (0, 0),
    };
    let cache_creation_tokens = usage
        .get("cache_creation_input_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(cache_creation_5m_tokens + cache_creation_1h_tokens);

    Some(ClaudeMessageUsage {
        message_id,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        cache_creation_5m_tokens,
        cache_creation_1h_tokens,
        reasoning_tokens: 0,
        total_tokens: input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens,
    })
}

/// Collapses a session's JSONL records (in file order) to one [`ClaudeMessageUsage`] per `message.id`.
///
/// Claude Code writes one record per content block of an assistant turn — text, each `tool_use`, each
/// `tool_result` — and every record repeats that turn's full `message.usage`. Counting per record
/// therefore multiplies a turn's tokens by its block count (a captured session repeats one id's usage
/// 8x). Real captures show every record sharing a `message.id` carries identical usage, so the first
/// record carrying usage for an id is kept and later repeats are dropped; first-appearance order is
/// preserved so the result tracks turn order. Records without a `message.id` or `message.usage` are
/// skipped (they contribute no tokens).
pub fn session_message_usages<'a, I>(records: I) -> Vec<ClaudeMessageUsage>
where
    I: IntoIterator<Item = &'a Value>,
{
    let mut messages = Vec::new();
    let mut seen = HashSet::new();
    for record in records {
        let Some(usage) = message_usage(record) else {
            continue;
        };
        if seen.insert(usage.message_id.clone()) {
            messages.push(usage);
        }
    }
    messages
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Builds an assistant JSONL record. `cache_creation` is the optional per-TTL split as
    /// `(5m, 1h)`; when `None` the nested object is omitted, mirroring a pre-breakdown transcript.
    fn assistant(
        id: &str,
        input: i64,
        output: i64,
        cache_read: i64,
        cache_creation: i64,
        split: Option<(i64, i64)>,
    ) -> Value {
        let mut usage = json!({
            "input_tokens": input,
            "output_tokens": output,
            "cache_read_input_tokens": cache_read,
            "cache_creation_input_tokens": cache_creation,
        });
        if let Some((c5m, c1h)) = split {
            usage["cache_creation"] = json!({
                "ephemeral_5m_input_tokens": c5m,
                "ephemeral_1h_input_tokens": c1h,
            });
        }
        json!({ "type": "assistant", "message": { "id": id, "usage": usage } })
    }

    #[test]
    fn collapses_repeated_message_id_to_one_contribution() {
        // The captured shape: one assistant turn written across 8 records, each repeating the same
        // usage. Collapsing by id must count it once.
        let one = assistant("msg_01J3rFDW", 5, 598, 17_917, 17_937, Some((0, 17_937)));
        let records = vec![one.clone(); 8];
        let messages = session_message_usages(records.iter());
        assert_eq!(messages.len(), 1);
        let m = &messages[0];
        assert_eq!(m.input_tokens, 5);
        assert_eq!(m.output_tokens, 598);
        assert_eq!(m.cache_read_tokens, 17_917);
        assert_eq!(m.cache_creation_tokens, 17_937);
    }

    #[test]
    fn naive_per_record_sum_would_overcount() {
        // Demonstrates why collapse is required: summing usage on every record multiplies the turn's
        // tokens by the 8 records that share its id.
        let one = assistant("msg_01J3rFDW", 5, 598, 17_917, 17_937, Some((0, 17_937)));
        let records = vec![one; 8];
        let naive: i64 = records
            .iter()
            .filter_map(message_usage)
            .map(|m| m.output_tokens)
            .sum();
        assert_eq!(naive, 598 * 8);
        let collapsed: i64 = session_message_usages(records.iter())
            .iter()
            .map(|m| m.output_tokens)
            .sum();
        assert_eq!(collapsed, 598);
    }

    #[test]
    fn splits_cache_creation_tiers_when_present() {
        let records = [assistant("msg_a", 6, 416, 0, 17_937, Some((0, 17_937)))];
        let m = &session_message_usages(records.iter())[0];
        assert_eq!(m.cache_creation_5m_tokens, 0);
        assert_eq!(m.cache_creation_1h_tokens, 17_937);
        assert_eq!(m.cache_creation_tokens, 17_937);
        // The split sums to the authoritative total when the breakdown is present.
        assert_eq!(
            m.cache_creation_5m_tokens + m.cache_creation_1h_tokens,
            m.cache_creation_tokens
        );
    }

    #[test]
    fn cache_creation_split_stays_zero_when_breakdown_absent() {
        // Pre-breakdown transcript: the total is authoritative, but the tier is unknown and must not
        // be fabricated into one bucket.
        let records = [assistant("msg_b", 1, 112, 51_331, 696, None)];
        let m = &session_message_usages(records.iter())[0];
        assert_eq!(m.cache_creation_tokens, 696);
        assert_eq!(m.cache_creation_5m_tokens, 0);
        assert_eq!(m.cache_creation_1h_tokens, 0);
    }

    #[test]
    fn total_is_reconstructed_from_components() {
        let records = [assistant(
            "msg_c",
            6,
            685,
            18_010,
            22_936,
            Some((22_936, 0)),
        )];
        let m = &session_message_usages(records.iter())[0];
        assert_eq!(
            m.total_tokens,
            m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_creation_tokens
        );
        assert_eq!(m.total_tokens, 6 + 685 + 18_010 + 22_936);
    }

    #[test]
    fn reasoning_is_zero_for_claude() {
        let records = [assistant("msg_d", 1, 805, 36_644, 547, Some((547, 0)))];
        assert_eq!(
            session_message_usages(records.iter())[0].reasoning_tokens,
            0
        );
    }

    #[test]
    fn preserves_first_appearance_order_across_interleaved_repeats() {
        let records = [
            assistant("msg_1", 1, 10, 0, 0, None),
            assistant("msg_2", 1, 20, 0, 0, None),
            assistant("msg_1", 1, 10, 0, 0, None), // repeat of the first turn
            assistant("msg_3", 1, 30, 0, 0, None),
        ];
        let ids: Vec<_> = session_message_usages(records.iter())
            .into_iter()
            .map(|m| m.message_id)
            .collect();
        assert_eq!(ids, ["msg_1", "msg_2", "msg_3"]);
    }

    #[test]
    fn skips_records_without_usage_or_message_id() {
        let records = [
            json!({ "type": "user", "message": { "role": "user", "content": "hi" } }),
            json!({ "type": "summary", "summary": "…" }),
            // assistant record present but with no usage object yet
            json!({ "type": "assistant", "message": { "id": "msg_partial" } }),
            assistant("msg_real", 1, 31, 52_027, 141, Some((141, 0))),
        ];
        let messages = session_message_usages(records.iter());
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].message_id, "msg_real");
    }

    #[test]
    fn first_usage_bearing_record_wins_over_an_earlier_usageless_one() {
        // A record carrying the id without usage must not shadow the later one that has it.
        let records = [
            json!({ "type": "assistant", "message": { "id": "msg_x" } }),
            assistant("msg_x", 2, 50, 100, 10, Some((10, 0))),
        ];
        let messages = session_message_usages(records.iter());
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].output_tokens, 50);
    }

    #[test]
    fn empty_session_yields_no_messages() {
        assert!(session_message_usages([].iter()).is_empty());
    }

    #[test]
    fn multi_turn_session_sums_each_turn_once() {
        // A small session with three turns, two of them written across multiple repeated records.
        let records = [
            assistant("msg_t1", 1, 112, 51_331, 696, None),
            assistant("msg_t1", 1, 112, 51_331, 696, None),
            assistant("msg_t2", 6, 416, 0, 50_557, Some((50_557, 0))),
            assistant("msg_t3", 5, 598, 17_917, 17_937, Some((0, 17_937))),
            assistant("msg_t3", 5, 598, 17_917, 17_937, Some((0, 17_937))),
            assistant("msg_t3", 5, 598, 17_917, 17_937, Some((0, 17_937))),
        ];
        let output: i64 = session_message_usages(records.iter())
            .iter()
            .map(|m| m.output_tokens)
            .sum();
        // Each turn's output counted once: 112 + 416 + 598, not multiplied by the repeated records.
        assert_eq!(output, 112 + 416 + 598);
    }
}
