// SPDX-License-Identifier: MIT
// Original Trace Flow code (otto parsed Cursor's legacy `~/.cursor/projects` JSONL, not the current
// `state.vscdb`; this targets the SQLite store). One unpriced `AgentMessageFact` per conversational turn,
// tokens + session-grain model only — pricing and model normalization are server-side. Trace Flow owns
// the contract, IDs, pricing, redaction, and storage around this code.

//! Cursor `AgentMessageFact` emission. [`cursor_message_facts`] turns one composer's bubbles (already
//! grouped and ordered by the reader) into one [`AgentMessageFact`] per genuine conversational turn —
//! user bubbles and assistant bubbles that delivered text or thinking. Tool-call frames and empty
//! streaming placeholders are skipped (see [`is_message_bubble`]); Cursor writes thousands of them and
//! they already flow to `agent_tool_events` / `agent_file_events`, so emitting them as messages would
//! double-count tool turns and inflate message volume ~7x off the Claude/Codex grain.
//!
//! **Token coverage is honest-Partial-or-Missing, never Full.** Cursor records `tokenCount` on only ~1%
//! of bubbles, carries no cache-token breakdown, and never reconciles a session total the way Codex's
//! `token_count` does — so a bubble that *has* a `tokenCount` is `Partial` (real but incomplete), and one
//! that does not is `Missing`. `cache_coverage` is always `Missing`. This is the visible-coverage
//! contract the dashboard reads to mark Cursor's partial economics, not a defect to paper over.
//!
//! **Model is session-grain.** Cursor names the model once on the composer, never per bubble, so every
//! message of a session carries the same raw `__model` label the reader stamped on (an empty string for
//! the house `default`). Normalization + pricing happen server-side; the parser passes the label
//! through untouched.

use collector_contracts::enums::{AgentMessageRole, CacheCoverage, TokenCoverage};
use collector_contracts::facts::AgentMessageFact;
use serde_json::Value;

use crate::cursor_records::{
    bubble_id, bubble_model, bubble_text, bubble_thinking, bubble_tokens, bubble_type, composer_id,
    BUBBLE_TYPE_ASSISTANT, BUBBLE_TYPE_USER,
};
use crate::session_context::SessionContext;
use crate::timestamp::rfc3339_to_epoch_ms;

/// Whether a bubble is a genuine conversational turn that belongs in `agent_messages`, as opposed to a
/// tool-call frame, an empty streaming placeholder, or other non-message bubble Cursor writes by the
/// thousands. This keeps Cursor's message grain aligned with the Claude/Codex emitters, which likewise
/// skip tool-result-only records — otherwise `agent_messages` double-counts every tool turn (it already
/// lands in `agent_tool_events`) and inflates message volume ~7x.
///
/// A **user** bubble is always a turn. An **assistant** bubble counts only when it delivered something:
/// visible `text` or a `thinking` block. A tool-only / blank assistant bubble carries neither and is not
/// a message (its tool invocation flows to `agent_tool_events` / `agent_file_events` instead).
fn is_message_bubble(record: &Value) -> bool {
    match bubble_type(record) {
        Some(BUBBLE_TYPE_USER) => true,
        Some(BUBBLE_TYPE_ASSISTANT) => {
            bubble_text(record).is_some() || bubble_thinking(record).is_some()
        }
        _ => false,
    }
}

/// The bubble's `event_at` in epoch ms from its ISO-8601 `createdAt`, falling back to the session start
/// (the composer's `createdAt`) when a bubble omits or malforms it.
fn bubble_event_at(record: &Value, ctx: &SessionContext) -> i64 {
    record
        .get("createdAt")
        .and_then(Value::as_str)
        .and_then(rfc3339_to_epoch_ms)
        .or(ctx.vendor_started_at)
        .unwrap_or(0)
}

fn role_of(record: &Value) -> AgentMessageRole {
    match bubble_type(record) {
        Some(BUBBLE_TYPE_USER) => AgentMessageRole::User,
        Some(BUBBLE_TYPE_ASSISTANT) => AgentMessageRole::Assistant,
        _ => AgentMessageRole::Other,
    }
}

fn message_fact(record: &Value, turn_index: i64, ctx: &SessionContext) -> AgentMessageFact {
    let (input_tokens, output_tokens) = bubble_tokens(record).unwrap_or((0, 0));
    // Coverage is about whether *real* token data exists, not whether a (often all-zero) `tokenCount`
    // object is present. Cursor writes `tokenCount` on every bubble but populates it on only ~1%, so an
    // all-zero count is "no data" → Missing, and only a nonzero count is the honest Partial.
    let has_tokens = input_tokens > 0 || output_tokens > 0;
    // The reader stamps the session-grain model on every bubble as `__model`; a record missing it (only
    // a malformed/hand-built one) gets the empty label, which the server treats as unpriceable.
    let model = bubble_model(record).unwrap_or_default().to_string();
    AgentMessageFact {
        // Prefer the bubble's own composer id; ctx carries the same value as the canonical fallback.
        vendor_session_id: composer_id(record)
            .unwrap_or(&ctx.vendor_session_id)
            .to_string(),
        // Cursor bubbles carry a stable per-message id, so the Worker's `message_pk` uses it (not the
        // positional turn_index fallback the id-less Codex path relies on).
        vendor_message_id: bubble_id(record).map(str::to_string),
        turn_index,
        role: role_of(record),
        event_at: bubble_event_at(record, ctx),
        model,
        input_tokens,
        output_tokens,
        // Cursor reports no cache-token breakdown at all.
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cache_creation_5m_tokens: 0,
        cache_creation_1h_tokens: 0,
        reasoning_tokens: 0,
        // Present-but-incomplete when real tokens exist (never reconciled to a session total → never
        // Full); Missing when the count is absent or all-zero. ~99% of Cursor bubbles land in `Missing`.
        token_coverage: if has_tokens {
            TokenCoverage::Partial
        } else {
            TokenCoverage::Missing
        },
        // No cache fields exist in the Cursor store.
        cache_coverage: CacheCoverage::Missing,
        // Cursor sessions in `state.vscdb` are single-agent: no sub-agent depth, spawn, or sidechain.
        agent_depth: 0,
        is_subagent_spawn: false,
        is_sidechain: false,
        agent_id: ctx.agent_id.clone(),
        normalized_git_remote: ctx.normalized_git_remote.clone(),
        repo_path_fallback: ctx.repo_path_fallback.clone(),
        git_branch: ctx.git_branch.clone(),
        git_head_sha: ctx.git_head_sha.clone(),
        vendor_started_at: ctx.vendor_started_at,
        // Message facts carry no free text, so nothing is redacted here (tool/file excerpts are).
        dropped_sensitive: 0,
    }
}

/// Emits one [`AgentMessageFact`] per genuine conversational turn in the composer, in the reader's
/// createdAt order. Non-message bubbles (tool-call frames, empty streaming placeholders) are skipped via
/// [`is_message_bubble`] so the table matches the Claude/Codex message grain and never double-counts the
/// tool turns that already populate `agent_tool_events`. The model is the session-grain label on every
/// fact; `turn_index` is the 0-based position **among emitted messages** (bubbles carry no turn number),
/// and identity rides the bubble's own id via `vendor_message_id`.
pub fn cursor_message_facts(records: &[Value], ctx: &SessionContext) -> Vec<AgentMessageFact> {
    records
        .iter()
        .filter(|record| is_message_bubble(record))
        .enumerate()
        .map(|(i, record)| message_fact(record, i as i64, ctx))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor_records::tests::bubble;
    use serde_json::json;

    fn ctx() -> SessionContext {
        SessionContext {
            vendor_session_id: "comp-1".to_string(),
            agent_id: "agent-abc".to_string(),
            normalized_git_remote: "github.com/acme/trace-flow".to_string(),
            repo_path_fallback: "trace-flow".to_string(),
            git_branch: "main".to_string(),
            git_head_sha: "deadbeef".to_string(),
            vendor_started_at: Some(1_778_964_000_000),
            agent_depth: 0,
            repo_root: String::new(),
        }
    }

    #[test]
    fn emits_one_fact_per_message_turn_with_role_and_index() {
        let records = [
            bubble(
                "comp-1",
                "gpt-5.2",
                BUBBLE_TYPE_USER,
                json!({ "text": "hi" }),
            ),
            bubble(
                "comp-1",
                "gpt-5.2",
                BUBBLE_TYPE_ASSISTANT,
                json!({ "text": "hello" }),
            ),
        ];
        let facts = cursor_message_facts(&records, &ctx());
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].role, AgentMessageRole::User);
        assert_eq!(facts[0].turn_index, 0);
        assert_eq!(facts[1].role, AgentMessageRole::Assistant);
        assert_eq!(facts[1].turn_index, 1);
    }

    #[test]
    fn a_tool_only_assistant_bubble_is_skipped_not_a_message() {
        // Cursor writes thousands of textless assistant bubbles that are tool-call frames (their
        // invocation already lands in agent_tool_events). They are not messages — emitting them would
        // double-count every tool turn and inflate message volume ~7x. Only the user turn survives here.
        let records = [
            bubble(
                "comp-1",
                "gpt-5.2",
                BUBBLE_TYPE_USER,
                json!({ "text": "go" }),
            ),
            bubble(
                "comp-1",
                "gpt-5.2",
                BUBBLE_TYPE_ASSISTANT,
                json!({ "toolFormerData": { "name": "read_file_v2" } }),
            ),
        ];
        let facts = cursor_message_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].role, AgentMessageRole::User);
    }

    #[test]
    fn a_thinking_only_assistant_bubble_is_a_message() {
        // A textless assistant bubble that carries a reasoning block is a delivered turn, so it counts.
        let records = [bubble(
            "comp-1",
            "gpt-5.2",
            BUBBLE_TYPE_ASSISTANT,
            json!({ "thinking": { "text": "let me think", "signature": "sig" } }),
        )];
        let facts = cursor_message_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].role, AgentMessageRole::Assistant);
    }

    #[test]
    fn an_unknown_bubble_type_is_not_a_message() {
        let records = [bubble("comp-1", "gpt-5.2", 99, json!({ "text": "x" }))];
        let facts = cursor_message_facts(&records, &ctx());
        assert!(facts.is_empty());
    }

    #[test]
    fn a_bubble_with_tokens_is_partial_and_cache_missing() {
        let records = [bubble(
            "comp-1",
            "gpt-5.2",
            BUBBLE_TYPE_ASSISTANT,
            json!({ "text": "answer", "tokenCount": { "inputTokens": 26069, "outputTokens": 911 } }),
        )];
        let f = &cursor_message_facts(&records, &ctx())[0];
        assert_eq!(f.input_tokens, 26069);
        assert_eq!(f.output_tokens, 911);
        // Cursor never reconciles a session total, so a real tokenCount is Partial, never Full.
        assert_eq!(f.token_coverage, TokenCoverage::Partial);
        assert_eq!(f.cache_coverage, CacheCoverage::Missing);
        assert_eq!(f.cache_read_tokens, 0);
        assert_eq!(f.cache_creation_tokens, 0);
    }

    #[test]
    fn a_bubble_without_tokens_is_missing_coverage() {
        let records = [bubble(
            "comp-1",
            "gpt-5.2",
            BUBBLE_TYPE_ASSISTANT,
            json!({ "text": "answer" }),
        )];
        let f = &cursor_message_facts(&records, &ctx())[0];
        assert_eq!(f.input_tokens, 0);
        assert_eq!(f.output_tokens, 0);
        assert_eq!(f.token_coverage, TokenCoverage::Missing);
        assert_eq!(f.cache_coverage, CacheCoverage::Missing);
    }

    #[test]
    fn an_all_zero_token_count_is_missing_not_partial() {
        // Cursor writes a `tokenCount` object on EVERY bubble but populates it on only ~1%. An all-zero
        // count is "no real data", so coverage must be Missing — not a misleading Partial that would
        // claim ~99% of bubbles carry token economics they don't.
        let records = [bubble(
            "comp-1",
            "gpt-5.2",
            BUBBLE_TYPE_ASSISTANT,
            json!({ "text": "answer", "tokenCount": { "inputTokens": 0, "outputTokens": 0 } }),
        )];
        let f = &cursor_message_facts(&records, &ctx())[0];
        assert_eq!(f.token_coverage, TokenCoverage::Missing);
    }

    #[test]
    fn the_session_grain_model_tags_every_message() {
        let records = [
            bubble(
                "comp-1",
                "claude-4.5-opus-high-thinking",
                BUBBLE_TYPE_USER,
                json!({ "text": "q" }),
            ),
            bubble(
                "comp-1",
                "claude-4.5-opus-high-thinking",
                BUBBLE_TYPE_ASSISTANT,
                json!({ "text": "a" }),
            ),
        ];
        let facts = cursor_message_facts(&records, &ctx());
        assert_eq!(facts.len(), 2);
        for f in facts {
            // Raw label passes through untouched; the server normalizes/prices it.
            assert_eq!(f.model, "claude-4.5-opus-high-thinking");
        }
    }

    #[test]
    fn vendor_message_id_is_the_bubble_id() {
        let records = [bubble(
            "comp-1",
            "gpt-5.2",
            BUBBLE_TYPE_ASSISTANT,
            json!({ "text": "answer" }),
        )];
        let f = &cursor_message_facts(&records, &ctx())[0];
        assert_eq!(f.vendor_message_id.as_deref(), Some("bub-1"));
        assert_eq!(f.vendor_session_id, "comp-1");
    }

    #[test]
    fn event_at_comes_from_the_bubble_created_at() {
        let records = [bubble(
            "comp-1",
            "gpt-5.2",
            BUBBLE_TYPE_ASSISTANT,
            json!({ "text": "answer" }),
        )];
        let f = &cursor_message_facts(&records, &ctx())[0];
        assert_eq!(f.event_at, 1_779_752_243_355); // 2026-05-25T23:37:23.355Z
    }

    #[test]
    fn empty_session_emits_no_facts() {
        assert!(cursor_message_facts(&[], &ctx()).is_empty());
    }
}
