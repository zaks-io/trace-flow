// SPDX-License-Identifier: MIT
// Adapted from otto-parser/src/parser/codex_cli/usage.rs (~/src/otto, 2026-05-25). Reworked: otto reads
// one event's `last_token_usage` in isolation and prices it locally; Trace Flow ships tokens only and
// reduces the two Codex usage fields to a per-turn shape. This module is the usage *reader* — it turns
// one `token_count` payload into a [`CodexTurnUsage`] and exposes the cumulative key used to drop Codex's
// duplicate emissions. Per-session turn segmentation (which events are real turns, and the dedup that
// makes the kept turns sum to the session total) lives in `codex_turns`, which calls these readers.
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Codex token-usage reading. [`last_token_usage`] turns a `token_count` payload's
//! `info.last_token_usage` into a [`CodexTurnUsage`]; [`cumulative_total`] exposes the running
//! `info.total_token_usage.total_tokens` used as a dedup key. `codex_turns` composes both into per-turn
//! usage; summing `total_token_usage` itself is the ~331x trap and is never done.

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
/// (a session's first token_count events report a null `last_token_usage`). `payload` is the
/// `token_count` event payload (the object holding `info`).
pub(crate) fn last_token_usage(payload: &Value) -> Option<CodexTurnUsage> {
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

/// The running cumulative `info.total_token_usage.total_tokens`. Retained for the trap-guard test that
/// asserts summing this cumulative field across events explodes past the real total; production now
/// diffs full [`CumulativeUsage`] snapshots via [`cumulative_usage`] instead.
#[cfg(test)]
pub(crate) fn cumulative_total(payload: &Value) -> Option<i64> {
    payload
        .get("info")?
        .get("total_token_usage")?
        .get("total_tokens")?
        .as_i64()
}

/// A `token_count` event's cumulative `info.total_token_usage` snapshot — the running session totals.
/// `input_tokens` is the full prompt incl. cache (Codex convention), matching `last_token_usage`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct CumulativeUsage {
    /// Raw cumulative input incl. cache (Codex's `input_tokens`, NOT yet cache-subtracted).
    pub raw_input_tokens: i64,
    pub cache_read_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub total_tokens: i64,
}

/// Reads `info.total_token_usage` into a [`CumulativeUsage`], or `None` when absent/non-object.
///
/// This is the basis of the ccusage-correct per-turn accounting: a turn's usage is the DIFF between
/// successive cumulative snapshots (see [`CumulativeUsage::delta_since`]), not the row's
/// `last_token_usage`. Codex re-emits `token_count` rows whose cumulative does not advance (duplicate
/// snapshots) and a row's `last_token_usage` can lag/diverge from the true delta when rows are dropped;
/// diffing the cumulative makes the kept turns sum to the final total by construction
/// (ccusage `ryoppippi/ccusage#884`).
pub(crate) fn cumulative_usage(payload: &Value) -> Option<CumulativeUsage> {
    let tt = payload.get("info")?.get("total_token_usage")?;
    if !tt.is_object() {
        return None;
    }
    Some(CumulativeUsage {
        raw_input_tokens: field_i64(tt, "input_tokens"),
        cache_read_tokens: field_i64(tt, "cached_input_tokens"),
        output_tokens: field_i64(tt, "output_tokens"),
        reasoning_tokens: field_i64(tt, "reasoning_output_tokens"),
        total_tokens: field_i64(tt, "total_tokens"),
    })
}

impl CumulativeUsage {
    /// The per-turn [`CodexTurnUsage`] for advancing from `prev` cumulative to `self`. Components are
    /// clamped at 0 so a malformed non-monotonic field can't produce a negative token count; `input`
    /// is the non-cached remainder (raw input delta minus cache-read delta), mirroring
    /// [`last_token_usage`]'s split. Caller guarantees `self.total_tokens > prev.total_tokens`
    /// (a non-advancing snapshot is a duplicate and is skipped, not diffed).
    pub(crate) fn delta_since(self, prev: CumulativeUsage) -> CodexTurnUsage {
        let raw_input = (self.raw_input_tokens - prev.raw_input_tokens).max(0);
        let cache_read = (self.cache_read_tokens - prev.cache_read_tokens).max(0);
        let output = (self.output_tokens - prev.output_tokens).max(0);
        let reasoning = (self.reasoning_tokens - prev.reasoning_tokens).max(0);
        let input_tokens = (raw_input - cache_read).max(0);
        CodexTurnUsage {
            input_tokens,
            cache_read_tokens: cache_read,
            output_tokens: output,
            reasoning_tokens: reasoning,
            total_tokens: input_tokens + cache_read + output,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Builds a `token_count` event payload's body. `last` is `(input, cached, output, reasoning,
    /// total)` for `last_token_usage`; `cumulative` is `total_token_usage.total_tokens`.
    fn token_count_payload(last: (i64, i64, i64, i64, i64), cumulative: i64) -> Value {
        let (input, cached, output, reasoning, total) = last;
        json!({
            "info": {
                "last_token_usage": {
                    "input_tokens": input,
                    "cached_input_tokens": cached,
                    "output_tokens": output,
                    "reasoning_output_tokens": reasoning,
                    "total_tokens": total,
                },
                "total_token_usage": { "total_tokens": cumulative },
            }
        })
    }

    #[test]
    fn null_last_token_usage_reads_as_none() {
        let payload = json!({
            "info": { "last_token_usage": Value::Null, "total_token_usage": { "total_tokens": 0 } }
        });
        assert_eq!(last_token_usage(&payload), None);
    }

    #[test]
    fn splits_cached_input_and_keeps_reasoning_as_a_subset() {
        let payload = token_count_payload((63_637, 56_704, 439, 0, 64_076), 299_113);
        let usage = last_token_usage(&payload).expect("usage");
        // input_tokens is the non-cached remainder: 63_637 - 56_704 = 6_933.
        assert_eq!(usage.input_tokens, 6_933);
        assert_eq!(usage.cache_read_tokens, 56_704);
        assert_eq!(usage.output_tokens, 439);
        assert_eq!(usage.reasoning_tokens, 0);
        // Non-cached input + cache_read + output reconstructs the reported total.
        assert_eq!(
            usage.input_tokens + usage.cache_read_tokens + usage.output_tokens,
            usage.total_tokens
        );
    }

    #[test]
    fn reconstructs_total_when_last_token_usage_omits_it() {
        let payload = json!({
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
        let usage = last_token_usage(&payload).expect("usage");
        assert_eq!(usage.input_tokens, 750); // 1_000 - 250 cached
        assert_eq!(usage.cache_read_tokens, 250);
        assert_eq!(usage.output_tokens, 80);
        assert_eq!(usage.reasoning_tokens, 12);
        // No `total_tokens` field, so it is rebuilt from the stored components.
        assert_eq!(usage.total_tokens, 1_080);
    }

    #[test]
    fn clamps_when_cached_exceeds_raw_input() {
        // Malformed event (cached > input) must not produce a negative input or an inconsistent total.
        let payload = json!({
            "info": {
                "last_token_usage": {
                    "input_tokens": 100,
                    "cached_input_tokens": 250,
                    "output_tokens": 40
                },
                "total_token_usage": { "total_tokens": 9_000 }
            }
        });
        let usage = last_token_usage(&payload).expect("usage");
        assert_eq!(usage.input_tokens, 0); // clamped, not -150
        assert_eq!(usage.cache_read_tokens, 250);
        assert_eq!(usage.output_tokens, 40);
        assert_eq!(usage.total_tokens, 290); // 0 + 250 + 40, consistent with the stored components
    }

    #[test]
    fn cumulative_total_reads_the_running_total() {
        let payload = token_count_payload((1, 0, 1, 0, 2), 12_345);
        assert_eq!(cumulative_total(&payload), Some(12_345));
    }
}
