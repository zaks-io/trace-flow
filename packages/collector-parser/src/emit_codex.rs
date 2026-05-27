// SPDX-License-Identifier: MIT
// Adapted from otto-parser/src/parser/codex_cli/mod.rs message emission (~/src/otto, 2026-05-25).
// Reworked: otto builds one priced event per `message` record and threads a renumbering turn counter;
// Trace Flow emits one unpriced `AgentMessageFact` per segmented turn (see `codex_turns`), ships tokens
// + model only (pricing is server-side), and leaves `*_pk` to the ingest Worker. Codex has no
// sub-agents in its transcript, so `agent_depth`/`is_sidechain`/`is_subagent_spawn` are constant.
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Codex `AgentMessageFact` emission. [`codex_message_facts`] turns a Codex session's records into one
//! [`AgentMessageFact`] per segmented turn: the per-turn token story from [`session_turns`], tagged
//! with the model active at each turn and the session-level git/identity context. It is the headline
//! economic path for Codex — assistant turns carry their tokens with `Full` coverage, user turns carry
//! none with `Missing` coverage, and the assistant turns' tokens sum to the session total by
//! construction (the dedup lives in `codex_turns`).

use collector_contracts::enums::{AgentMessageRole, CacheCoverage, TokenCoverage};
use collector_contracts::facts::AgentMessageFact;
use serde_json::Value;

use crate::codex_turns::{session_turns, CodexTurn, CodexTurnRole};
use crate::session_context::SessionContext;
use crate::timestamp::rfc3339_to_epoch_ms;

/// The model named by a `turn_context` record's `payload.model`, or `None` for any other record.
/// Codex sets the model per turn here; `session_meta.model` is null, so this is the only source.
fn turn_context_model(record: &Value) -> Option<&str> {
    if record.get("type").and_then(Value::as_str) != Some("turn_context") {
        return None;
    }
    record.get("payload")?.get("model")?.as_str()
}

/// The model active at each turn, aligned 1:1 with `turns`. Walks records in file order tracking the
/// most recent `turn_context.model`; when a record is a turn's representative record, that turn takes
/// the current model. Turns borrow their record from `records`, so the match is pointer identity — the
/// same structural correlation `codex_turns` uses, never a timestamp or content guess.
fn models_by_turn(records: &[Value], turns: &[CodexTurn]) -> Vec<String> {
    let mut models = Vec::with_capacity(turns.len());
    let mut current = "";
    let mut pending = turns.iter().peekable();
    for record in records {
        if let Some(model) = turn_context_model(record) {
            current = model;
        }
        if let Some(turn) = pending.peek() {
            // Deliberate pointer identity: `turn.record` is a `&Value` borrowed from this exact
            // `records` slice (it came from `session_turns(records.iter())`), so `std::ptr::eq` matches
            // the same allocation. Passing a cloned or rebuilt `records` here would silently break the
            // match — every turn would fall through to the defensive loop below and take the last model.
            if std::ptr::eq(record, turn.record) {
                models.push(current.to_string());
                pending.next();
            }
        }
    }
    // Defensive: any turn whose record was not encountered (cannot happen — turns borrow from
    // `records`) still gets a model so the alignment with `turns` holds.
    while pending.next().is_some() {
        models.push(current.to_string());
    }
    models
}

/// The turn's `event_at` in epoch ms from its record's `timestamp`, falling back to the session start
/// when a record omits or malforms it (real Codex records always carry one).
fn turn_event_at(record: &Value, ctx: &SessionContext) -> i64 {
    record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(rfc3339_to_epoch_ms)
        .or(ctx.vendor_started_at)
        .unwrap_or(0)
}

fn message_fact(turn: &CodexTurn, model: String, ctx: &SessionContext) -> AgentMessageFact {
    let usage = turn.usage.unwrap_or_default();
    let has_usage = turn.usage.is_some();
    AgentMessageFact {
        vendor_session_id: ctx.vendor_session_id.clone(),
        // Codex emits no per-message vendor ID; the Worker's `message_pk` falls back to the positional
        // `turn_index` (ADR identity rule).
        vendor_message_id: None,
        turn_index: turn.turn_index,
        role: match turn.role {
            CodexTurnRole::User => AgentMessageRole::User,
            CodexTurnRole::Assistant => AgentMessageRole::Assistant,
        },
        event_at: turn_event_at(turn.record, ctx),
        model,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        // Codex reports no prompt-cache-creation split (see `CodexTurnUsage`).
        cache_creation_tokens: 0,
        cache_creation_5m_tokens: 0,
        cache_creation_1h_tokens: 0,
        reasoning_tokens: usage.reasoning_tokens,
        // A turn closed by a `token_count` has full token data; a user turn or an unclosed assistant
        // turn has none. Codex carries no `Partial` case at the message grain.
        token_coverage: if has_usage {
            TokenCoverage::Full
        } else {
            TokenCoverage::Missing
        },
        cache_coverage: if has_usage {
            CacheCoverage::Full
        } else {
            CacheCoverage::Missing
        },
        // Codex transcripts are single-agent: no sub-agent depth, spawn, or sidechain.
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

/// Emits one [`AgentMessageFact`] per segmented Codex turn (see [`session_turns`]), each tagged with
/// the model active at that turn and the session's git/identity [`SessionContext`].
pub fn codex_message_facts(records: &[Value], ctx: &SessionContext) -> Vec<AgentMessageFact> {
    let turns = session_turns(records.iter());
    let models = models_by_turn(records, &turns);
    turns
        .iter()
        .zip(models)
        .map(|(turn, model)| message_fact(turn, model, ctx))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx() -> SessionContext {
        SessionContext {
            vendor_session_id: "codex-sess-1".to_string(),
            agent_id: "agent-abc".to_string(),
            normalized_git_remote: "github.com/acme/trace-flow".to_string(),
            repo_path_fallback: "trace-flow".to_string(),
            git_branch: "main".to_string(),
            git_head_sha: "deadbeef".to_string(),
            vendor_started_at: Some(1_778_964_000_000),
            agent_depth: 0,
        }
    }

    fn turn_context(model: &str, ts: &str) -> Value {
        json!({ "type": "turn_context", "timestamp": ts, "payload": { "model": model } })
    }

    fn user_message(ts: &str) -> Value {
        json!({
            "type": "response_item",
            "timestamp": ts,
            "payload": { "type": "message", "role": "user", "content": [] }
        })
    }

    fn assistant_message(ts: &str) -> Value {
        json!({
            "type": "response_item",
            "timestamp": ts,
            "payload": { "type": "message", "role": "assistant", "content": [] }
        })
    }

    fn token_count(last: (i64, i64, i64, i64, i64), cumulative: i64, ts: &str) -> Value {
        let (input, cached, output, reasoning, total) = last;
        json!({
            "type": "event_msg",
            "timestamp": ts,
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {
                        "input_tokens": input,
                        "cached_input_tokens": cached,
                        "output_tokens": output,
                        "reasoning_output_tokens": reasoning,
                        "total_tokens": total,
                    },
                    "total_token_usage": { "total_tokens": cumulative },
                },
            },
        })
    }

    #[test]
    fn emits_one_fact_per_turn_with_role_and_index() {
        let records = [
            turn_context("gpt-5.5", "2026-05-16T20:53:00.000Z"),
            user_message("2026-05-16T20:53:01.000Z"),
            assistant_message("2026-05-16T20:53:05.000Z"),
            token_count((1_000, 0, 50, 0, 1_050), 1_050, "2026-05-16T20:53:10.000Z"),
        ];
        let facts = codex_message_facts(&records, &ctx());
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].role, AgentMessageRole::User);
        assert_eq!(facts[0].turn_index, 0);
        assert_eq!(facts[1].role, AgentMessageRole::Assistant);
        assert_eq!(facts[1].turn_index, 1);
    }

    #[test]
    fn assistant_turn_carries_tokens_and_full_coverage() {
        let records = [
            turn_context("gpt-5.5", "2026-05-16T20:53:00.000Z"),
            assistant_message("2026-05-16T20:53:05.000Z"),
            token_count(
                (1_000, 200, 50, 12, 1_050),
                1_050,
                "2026-05-16T20:53:10.631Z",
            ),
        ];
        let fact = &codex_message_facts(&records, &ctx())[0];
        assert_eq!(fact.input_tokens, 800); // 1_000 raw - 200 cached
        assert_eq!(fact.cache_read_tokens, 200);
        assert_eq!(fact.output_tokens, 50);
        assert_eq!(fact.reasoning_tokens, 12);
        assert_eq!(fact.token_coverage, TokenCoverage::Full);
        assert_eq!(fact.cache_coverage, CacheCoverage::Full);
        // Codex has no prompt-cache-creation split.
        assert_eq!(fact.cache_creation_tokens, 0);
        assert_eq!(fact.event_at, 1_778_964_790_631);
    }

    #[test]
    fn user_turn_has_no_tokens_and_missing_coverage() {
        let records = [user_message("2026-05-16T20:53:01.000Z")];
        let fact = &codex_message_facts(&records, &ctx())[0];
        assert_eq!(fact.input_tokens, 0);
        assert_eq!(fact.output_tokens, 0);
        assert_eq!(fact.token_coverage, TokenCoverage::Missing);
        assert_eq!(fact.cache_coverage, CacheCoverage::Missing);
        assert_eq!(fact.vendor_message_id, None);
    }

    #[test]
    fn tags_each_turn_with_the_model_active_at_that_turn() {
        // The model switches mid-session; each assistant turn must carry the model in force when it ran.
        let records = [
            turn_context("gpt-5.5", "2026-05-16T20:53:00.000Z"),
            assistant_message("2026-05-16T20:53:05.000Z"),
            token_count((1_000, 0, 50, 0, 1_050), 1_050, "2026-05-16T20:53:10.000Z"),
            turn_context("gpt-5.5-codex", "2026-05-16T20:54:00.000Z"),
            assistant_message("2026-05-16T20:54:05.000Z"),
            token_count((500, 0, 20, 0, 520), 1_570, "2026-05-16T20:54:10.000Z"),
        ];
        let models: Vec<_> = codex_message_facts(&records, &ctx())
            .into_iter()
            .map(|f| f.model)
            .collect();
        assert_eq!(models, ["gpt-5.5", "gpt-5.5-codex"]);
    }

    #[test]
    fn carries_session_context_onto_every_fact() {
        let records = [
            user_message("2026-05-16T20:53:01.000Z"),
            assistant_message("2026-05-16T20:53:05.000Z"),
            token_count((10, 0, 5, 0, 15), 15, "2026-05-16T20:53:10.000Z"),
        ];
        let context = ctx();
        for fact in codex_message_facts(&records, &context) {
            assert_eq!(fact.vendor_session_id, context.vendor_session_id);
            assert_eq!(fact.agent_id, context.agent_id);
            assert_eq!(fact.normalized_git_remote, context.normalized_git_remote);
            assert_eq!(fact.git_head_sha, context.git_head_sha);
            assert_eq!(fact.vendor_started_at, context.vendor_started_at);
            // Codex transcripts are single-agent.
            assert_eq!(fact.agent_depth, 0);
            assert!(!fact.is_sidechain);
            assert!(!fact.is_subagent_spawn);
        }
    }

    #[test]
    fn assistant_token_totals_sum_to_the_session_total() {
        let records = [
            turn_context("gpt-5.5", "2026-05-16T20:53:00.000Z"),
            assistant_message("2026-05-16T20:53:05.000Z"),
            token_count(
                (20_480, 0, 200, 0, 20_680),
                20_680,
                "2026-05-16T20:53:10.000Z",
            ),
            assistant_message("2026-05-16T20:54:05.000Z"),
            token_count(
                (40_000, 10_000, 219, 40, 40_219),
                60_899,
                "2026-05-16T20:54:10.000Z",
            ),
        ];
        let summed: i64 = codex_message_facts(&records, &ctx())
            .iter()
            .map(|f| f.input_tokens + f.cache_read_tokens + f.output_tokens)
            .sum();
        // Equals the final cumulative `total_token_usage.total_tokens`.
        assert_eq!(summed, 60_899);
    }

    #[test]
    fn empty_session_emits_no_facts() {
        assert!(codex_message_facts(&[], &ctx()).is_empty());
    }
}
