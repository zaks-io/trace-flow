// SPDX-License-Identifier: MIT
// Adapted from otto-parser/src/parser/claude_code/mod.rs message emission (~/src/otto, 2026-05-25).
// Reworked: otto emits one priced event per JSONL record (so a turn written across N content-block
// records is counted N times) and threads its own depth/spawn maps; Trace Flow emits one unpriced
// `AgentMessageFact` per assistant `message.id` (usage collapsed in `claude_usage`) plus one per
// text-bearing user record, ships tokens + model only (pricing is server-side), and leaves `*_pk` to
// the ingest Worker. Trace Flow owns the contract, IDs, pricing, redaction, and storage around this
// code.

//! Claude Code `AgentMessageFact` emission. [`claude_message_facts`] turns a Claude session's records
//! into one [`AgentMessageFact`] per assistant turn (keyed by `message.id`, usage collapsed by
//! [`session_message_usages`]) and one per text-bearing user record (keyed by the record `uuid`).
//! Tool-result-only user records carry no message and are skipped. Sub-agent transcripts are separate
//! files the sync layer marks with `agent_depth > 0`; each record's own `isSidechain` flag rides onto
//! the fact, and a turn whose content spawns a sub-agent (a `Task`/`Agent` tool_use) is flagged.

use std::collections::{HashMap, HashSet};

use collector_contracts::enums::{AgentMessageRole, CacheCoverage, TokenCoverage};
use collector_contracts::facts::AgentMessageFact;
use serde_json::Value;

use crate::claude_usage::{session_message_usages, ClaudeMessageUsage};
use crate::session_context::SessionContext;
use crate::timestamp::rfc3339_to_epoch_ms;

/// Tool names whose `tool_use` marks a turn as spawning a sub-agent. Matches otto's
/// `SUBAGENT_SPAWN_TOOL_NAMES`: the canonical `Task` tool and this build's `Agent` alias. Matched by
/// exact equality so the unrelated `TaskCreate`/`TaskUpdate`/`TaskList` todo tools never false-trigger.
const SUBAGENT_SPAWN_TOOL_NAMES: [&str; 2] = ["Task", "Agent"];

/// The assistant record's collapse key (`message.id`), or `None` for any record without one.
fn assistant_message_id(record: &Value) -> Option<&str> {
    record.get("message")?.get("id")?.as_str()
}

/// The record's `event_at` in epoch ms from its top-level `timestamp`, falling back to the session
/// start when a record omits or malforms it (real Claude records always carry one).
fn record_event_at(record: &Value, ctx: &SessionContext) -> i64 {
    record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(rfc3339_to_epoch_ms)
        .or(ctx.vendor_started_at)
        .unwrap_or(0)
}

/// True when a user record carries real user prose: a string `message.content`, or a content array
/// holding at least one `text` block. A content array of only `tool_result` blocks is a tool-result
/// carrier, not a user turn, and yields `false` so the caller skips it.
fn is_text_bearing_user(record: &Value) -> bool {
    match record.get("message").and_then(|m| m.get("content")) {
        Some(Value::String(_)) => true,
        Some(Value::Array(blocks)) => blocks
            .iter()
            .any(|b| b.get("type").and_then(Value::as_str) == Some("text")),
        _ => false,
    }
}

/// True when an assistant record's content holds a [`SUBAGENT_SPAWN_TOOL_NAMES`] `tool_use` block.
fn record_spawns_subagent(record: &Value) -> bool {
    let Some(Value::Array(blocks)) = record.get("message").and_then(|m| m.get("content")) else {
        return false;
    };
    blocks.iter().any(|block| {
        block.get("type").and_then(Value::as_str) == Some("tool_use")
            && block
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| SUBAGENT_SPAWN_TOOL_NAMES.contains(&name))
    })
}

/// The set of assistant `message.id`s whose turn spawns a sub-agent. Scanned across every record
/// because Claude may write the spawning `tool_use` in a later content-block record that shares the id
/// with the turn's first (representative) record — the one the fact is emitted from.
fn spawning_message_ids(records: &[Value]) -> HashSet<&str> {
    records
        .iter()
        .filter(|r| record_spawns_subagent(r))
        .filter_map(|r| assistant_message_id(r))
        .collect()
}

fn assistant_fact(
    record: &Value,
    usage: Option<&ClaudeMessageUsage>,
    turn_index: i64,
    is_spawn: bool,
    ctx: &SessionContext,
) -> AgentMessageFact {
    let u = usage.cloned().unwrap_or_default();
    let has_usage = usage.is_some();
    AgentMessageFact {
        vendor_session_id: ctx.vendor_session_id.clone(),
        vendor_message_id: assistant_message_id(record).map(str::to_string),
        turn_index,
        role: AgentMessageRole::Assistant,
        event_at: record_event_at(record, ctx),
        model: record
            .get("message")
            .and_then(|m| m.get("model"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_tokens: u.cache_read_tokens,
        cache_creation_tokens: u.cache_creation_tokens,
        cache_creation_5m_tokens: u.cache_creation_5m_tokens,
        cache_creation_1h_tokens: u.cache_creation_1h_tokens,
        // Claude folds extended-thinking tokens into output and emits no separate reasoning count.
        reasoning_tokens: u.reasoning_tokens,
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
        agent_depth: ctx.agent_depth,
        is_subagent_spawn: is_spawn,
        is_sidechain: record
            .get("isSidechain")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        agent_id: ctx.agent_id.clone(),
        normalized_git_remote: ctx.normalized_git_remote.clone(),
        repo_path_fallback: ctx.repo_path_fallback.clone(),
        git_branch: ctx.git_branch.clone(),
        git_head_sha: ctx.git_head_sha.clone(),
        vendor_started_at: ctx.vendor_started_at,
        // Message facts carry no free text; tool/file excerpts are redacted on their own facts.
        dropped_sensitive: 0,
    }
}

fn user_fact(record: &Value, turn_index: i64, ctx: &SessionContext) -> AgentMessageFact {
    AgentMessageFact {
        vendor_session_id: ctx.vendor_session_id.clone(),
        // A user turn has no model-assigned id; key it on the record `uuid` so the Worker's
        // `message_pk` is stable across re-parse (otherwise it falls back to the positional index).
        vendor_message_id: record
            .get("uuid")
            .and_then(Value::as_str)
            .map(str::to_string),
        turn_index,
        role: AgentMessageRole::User,
        event_at: record_event_at(record, ctx),
        // User turns name no model and carry no tokens; coverage is Missing, not zero-with-Full.
        model: String::new(),
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cache_creation_5m_tokens: 0,
        cache_creation_1h_tokens: 0,
        reasoning_tokens: 0,
        token_coverage: TokenCoverage::Missing,
        cache_coverage: CacheCoverage::Missing,
        agent_depth: ctx.agent_depth,
        is_subagent_spawn: false,
        is_sidechain: record
            .get("isSidechain")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        agent_id: ctx.agent_id.clone(),
        normalized_git_remote: ctx.normalized_git_remote.clone(),
        repo_path_fallback: ctx.repo_path_fallback.clone(),
        git_branch: ctx.git_branch.clone(),
        git_head_sha: ctx.git_head_sha.clone(),
        vendor_started_at: ctx.vendor_started_at,
        dropped_sensitive: 0,
    }
}

/// Emits one [`AgentMessageFact`] per Claude turn in file order: one per assistant `message.id` (usage
/// collapsed by [`session_message_usages`], so a turn written across many content-block records counts
/// once) and one per text-bearing user record. `turn_index` is the positional ordinal of the emitted
/// fact; identity rides on `vendor_message_id` (`message.id` for assistant, record `uuid` for user).
pub fn claude_message_facts(records: &[Value], ctx: &SessionContext) -> Vec<AgentMessageFact> {
    // `message.id -> collapsed usage`. Keyed by owned `String`; `get` takes the record's `&str` id via
    // `String: Borrow<str>`, so no allocation per lookup and the collapse in `claude_usage` is reused.
    let usage_by_id: HashMap<String, ClaudeMessageUsage> = session_message_usages(records.iter())
        .into_iter()
        .map(|u| (u.message_id.clone(), u))
        .collect();
    let spawns = spawning_message_ids(records);

    let mut facts = Vec::new();
    let mut seen_assistant_ids: HashSet<&str> = HashSet::new();
    let mut turn_index = 0i64;

    for record in records {
        match record.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                let Some(id) = assistant_message_id(record) else {
                    continue;
                };
                if !seen_assistant_ids.insert(id) {
                    continue;
                }
                let fact = assistant_fact(
                    record,
                    usage_by_id.get(id),
                    turn_index,
                    spawns.contains(id),
                    ctx,
                );
                facts.push(fact);
                turn_index += 1;
            }
            Some("user") if is_text_bearing_user(record) => {
                facts.push(user_fact(record, turn_index, ctx));
                turn_index += 1;
            }
            _ => {}
        }
    }
    facts
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx() -> SessionContext {
        SessionContext {
            vendor_session_id: "claude-sess-1".to_string(),
            agent_id: "agent-abc".to_string(),
            normalized_git_remote: "github.com/acme/trace-flow".to_string(),
            repo_path_fallback: "trace-flow".to_string(),
            git_branch: "main".to_string(),
            git_head_sha: "deadbeef".to_string(),
            vendor_started_at: Some(1_778_964_000_000),
            agent_depth: 0,
        }
    }

    fn usage(input: i64, output: i64, cache_read: i64, cache_creation: i64) -> Value {
        json!({
            "input_tokens": input,
            "output_tokens": output,
            "cache_read_input_tokens": cache_read,
            "cache_creation_input_tokens": cache_creation,
        })
    }

    fn text_block(text: &str) -> Value {
        json!({ "type": "text", "text": text })
    }

    fn tool_use(name: &str) -> Value {
        json!({ "type": "tool_use", "name": name, "input": {} })
    }

    fn assistant(id: &str, model: &str, ts: &str, content: Value, usage: Option<Value>) -> Value {
        let mut message =
            json!({ "id": id, "model": model, "role": "assistant", "content": content });
        if let Some(u) = usage {
            message["usage"] = u;
        }
        json!({ "type": "assistant", "timestamp": ts, "isSidechain": false, "message": message })
    }

    fn user_text(uuid: &str, ts: &str) -> Value {
        json!({
            "type": "user", "timestamp": ts, "uuid": uuid, "isSidechain": false,
            "message": { "role": "user", "content": "hello" }
        })
    }

    fn user_tool_result(uuid: &str, ts: &str) -> Value {
        json!({
            "type": "user", "timestamp": ts, "uuid": uuid, "isSidechain": false,
            "message": { "role": "user", "content": [{ "type": "tool_result", "content": "ok" }] }
        })
    }

    #[test]
    fn collapses_assistant_message_id_to_one_fact() {
        // Claude writes one record per content block, each repeating the id; collapse to one fact.
        let a = assistant(
            "msg_1",
            "claude-opus-4-7",
            "2026-05-25T23:37:23.355Z",
            json!([text_block("hi")]),
            Some(usage(10, 200, 1_000, 50)),
        );
        let records = [a.clone(), a];
        let facts = claude_message_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].vendor_message_id.as_deref(), Some("msg_1"));
        assert_eq!(facts[0].role, AgentMessageRole::Assistant);
        assert_eq!(
            facts[0].event_at,
            rfc3339_to_epoch_ms("2026-05-25T23:37:23.355Z").unwrap()
        );
    }

    #[test]
    fn assistant_fact_carries_collapsed_tokens_and_full_coverage() {
        let a = assistant(
            "msg_1",
            "claude-opus-4-7",
            "2026-05-25T23:37:23.355Z",
            json!([text_block("hi")]),
            Some(json!({
                "input_tokens": 10,
                "output_tokens": 200,
                "cache_read_input_tokens": 1_000,
                "cache_creation_input_tokens": 17_937,
                "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 17_937 },
            })),
        );
        let fact = &claude_message_facts(&[a], &ctx())[0];
        assert_eq!(fact.input_tokens, 10);
        assert_eq!(fact.output_tokens, 200);
        assert_eq!(fact.cache_read_tokens, 1_000);
        assert_eq!(fact.cache_creation_tokens, 17_937);
        assert_eq!(fact.cache_creation_1h_tokens, 17_937);
        // Claude folds reasoning into output.
        assert_eq!(fact.reasoning_tokens, 0);
        assert_eq!(fact.token_coverage, TokenCoverage::Full);
        assert_eq!(fact.cache_coverage, CacheCoverage::Full);
        assert_eq!(fact.model, "claude-opus-4-7");
    }

    #[test]
    fn assistant_without_usage_is_missing_coverage_but_still_emitted() {
        let a = assistant(
            "msg_partial",
            "claude-opus-4-7",
            "2026-05-25T23:37:23.355Z",
            json!([text_block("hi")]),
            None,
        );
        let fact = &claude_message_facts(&[a], &ctx())[0];
        assert_eq!(fact.token_coverage, TokenCoverage::Missing);
        assert_eq!(fact.cache_coverage, CacheCoverage::Missing);
        assert_eq!(fact.input_tokens, 0);
        assert_eq!(fact.model, "claude-opus-4-7");
    }

    #[test]
    fn user_text_record_emits_missing_coverage_fact_keyed_on_uuid() {
        let fact =
            &claude_message_facts(&[user_text("uuid-1", "2026-05-25T23:37:20.000Z")], &ctx())[0];
        assert_eq!(fact.role, AgentMessageRole::User);
        assert_eq!(fact.vendor_message_id.as_deref(), Some("uuid-1"));
        assert_eq!(fact.token_coverage, TokenCoverage::Missing);
        assert_eq!(fact.cache_coverage, CacheCoverage::Missing);
        assert_eq!(fact.model, "");
        assert_eq!(fact.input_tokens, 0);
    }

    #[test]
    fn tool_result_only_user_record_is_skipped() {
        let records = [user_tool_result("uuid-tr", "2026-05-25T23:37:21.000Z")];
        assert!(claude_message_facts(&records, &ctx()).is_empty());
    }

    #[test]
    fn user_array_with_a_text_block_is_emitted() {
        let u = json!({
            "type": "user", "timestamp": "2026-05-25T23:37:20.000Z", "uuid": "uuid-x",
            "message": { "role": "user", "content": [text_block("hi")] }
        });
        let facts = claude_message_facts(&[u], &ctx());
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].role, AgentMessageRole::User);
    }

    #[test]
    fn flags_subagent_spawn_for_task_and_agent_tools_only() {
        // An `Agent` tool_use marks a spawn; the unrelated `TaskCreate` todo tool must not.
        let spawner = assistant(
            "msg_spawn",
            "claude-opus-4-7",
            "2026-05-25T23:37:23.355Z",
            json!([text_block("delegating"), tool_use("Agent")]),
            Some(usage(1, 1, 0, 0)),
        );
        let todo = assistant(
            "msg_todo",
            "claude-opus-4-7",
            "2026-05-25T23:37:25.000Z",
            json!([tool_use("TaskCreate")]),
            Some(usage(1, 1, 0, 0)),
        );
        let facts = claude_message_facts(&[spawner, todo], &ctx());
        assert!(facts[0].is_subagent_spawn);
        assert!(!facts[1].is_subagent_spawn);
    }

    #[test]
    fn spawn_flag_set_when_tool_use_is_in_a_later_record_sharing_the_id() {
        // Representative record is text; the spawning tool_use lands in a later record with the same
        // id. The single emitted fact must still be flagged.
        let first = assistant(
            "msg_s",
            "claude-opus-4-7",
            "2026-05-25T23:37:23.355Z",
            json!([text_block("ok")]),
            Some(usage(1, 1, 0, 0)),
        );
        let second = assistant(
            "msg_s",
            "claude-opus-4-7",
            "2026-05-25T23:37:24.000Z",
            json!([tool_use("Task")]),
            Some(usage(1, 1, 0, 0)),
        );
        let facts = claude_message_facts(&[first, second], &ctx());
        assert_eq!(facts.len(), 1);
        assert!(facts[0].is_subagent_spawn);
    }

    #[test]
    fn is_sidechain_and_agent_depth_ride_onto_facts() {
        let mut a = assistant(
            "msg_sc",
            "claude-sonnet-4-6",
            "2026-05-25T23:37:23.355Z",
            json!([text_block("hi")]),
            Some(usage(1, 1, 0, 0)),
        );
        a["isSidechain"] = json!(true);
        let mut context = ctx();
        context.agent_depth = 2;
        let fact = &claude_message_facts(&[a], &context)[0];
        assert!(fact.is_sidechain);
        assert_eq!(fact.agent_depth, 2);
    }

    #[test]
    fn turn_index_increments_positionally_skipping_tool_result_records() {
        let records = [
            user_text("u1", "2026-05-25T23:37:20.000Z"),
            assistant(
                "msg_a",
                "claude-opus-4-7",
                "2026-05-25T23:37:23.000Z",
                json!([text_block("a")]),
                Some(usage(1, 1, 0, 0)),
            ),
            // Skipped: burns no turn index.
            user_tool_result("tr", "2026-05-25T23:37:24.000Z"),
            user_text("u2", "2026-05-25T23:37:25.000Z"),
        ];
        let idx: Vec<_> = claude_message_facts(&records, &ctx())
            .iter()
            .map(|f| (f.role, f.turn_index))
            .collect();
        assert_eq!(
            idx,
            [
                (AgentMessageRole::User, 0),
                (AgentMessageRole::Assistant, 1),
                (AgentMessageRole::User, 2),
            ]
        );
    }

    #[test]
    fn carries_session_context_onto_every_fact() {
        let records = [
            user_text("u1", "2026-05-25T23:37:20.000Z"),
            assistant(
                "msg_a",
                "claude-opus-4-7",
                "2026-05-25T23:37:23.000Z",
                json!([text_block("a")]),
                Some(usage(1, 1, 0, 0)),
            ),
        ];
        let context = ctx();
        for fact in claude_message_facts(&records, &context) {
            assert_eq!(fact.vendor_session_id, context.vendor_session_id);
            assert_eq!(fact.agent_id, context.agent_id);
            assert_eq!(fact.normalized_git_remote, context.normalized_git_remote);
            assert_eq!(fact.git_head_sha, context.git_head_sha);
            assert_eq!(fact.vendor_started_at, context.vendor_started_at);
        }
    }

    #[test]
    fn event_at_falls_back_to_session_start_when_timestamp_missing() {
        let a = json!({
            "type": "assistant",
            "message": {
                "id": "msg_nots", "model": "m", "role": "assistant",
                "content": [text_block("hi")],
                "usage": { "input_tokens": 1, "output_tokens": 1 },
            }
        });
        let fact = &claude_message_facts(&[a], &ctx())[0];
        assert_eq!(fact.event_at, 1_778_964_000_000);
    }

    #[test]
    fn empty_session_emits_no_facts() {
        assert!(claude_message_facts(&[], &ctx()).is_empty());
    }
}
