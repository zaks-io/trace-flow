// SPDX-License-Identifier: Apache-2.0
// Adapted from otto-parser/src/parser/claude_code/{mod.rs,tools.rs} tool emission (~/src/otto,
// 2026-05-25). Reworked: otto emitted the tool_use and tool_result as two priced facts; Trace Flow
// emits ONE unpriced `AgentToolEventFact` per call (the use/result join lives in `tool_fold`),
// classifies the command structurally, relativizes touched paths, and ships redacted capped excerpts
// only. Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Claude Code `AgentToolEventFact` emission. [`claude_tool_facts`] emits one fact per `tool_use`
//! block. The result side (outcome, duration, error text) is the cross-record join done by
//! [`fold_tool_events`], looked up here by `tool_use_id`; the use side (message id, event time,
//! command, touched path, block position) is read from the assistant record this walk visits. Claude
//! transcripts carry no process exit code (the Bash sidecar holds only `interrupted`/`stderr`/`stdout`),
//! so `exit_code` is always `None` and `status` rides the folded outcome. Provider/repo/PR and
//! sub-agent token enrichment are deferred (the ADR names the columns but gives no parser algorithm,
//! and a spawned sub-agent's economics live in its own separate transcript's facts, not double-counted
//! here), so those columns ship empty.

use std::collections::HashMap;
use std::path::Path;

use collector_contracts::enums::AgentEventStatus;
use collector_contracts::facts::AgentToolEventFact;
use serde_json::Value;

use crate::command::classify_command;
use crate::paths::relativize_repo_path;
use crate::redaction::redact_field;
use crate::session_context::SessionContext;
use crate::timestamp::rfc3339_to_epoch_ms;
use crate::tool_fold::{fold_tool_events, FoldedToolEvent, ToolOutcome};
use crate::tool_signals::{classify_navigation, classify_tool_error};

/// ADR caps: command <= 1 KB, error <= 4 KB, and navigation hints consume only the remaining 5 KB
/// budget.
const COMMAND_EXCERPT_CAP_BYTES: usize = 1024;
const ERROR_EXCERPT_CAP_BYTES: usize = 4096;
const NAVIGATION_HINT_CAP_BYTES: usize = 256;
const TOOL_EXCERPT_TOTAL_CAP_BYTES: usize = 5 * 1024;

/// The assistant record's `message.id`, or `None` for any record without one. Tool-use blocks live only
/// in assistant records, so a record with no id carries no tool event.
fn assistant_message_id(record: &Value) -> Option<&str> {
    record.get("message")?.get("id")?.as_str()
}

/// The record's content blocks (`message.content`), or `None` when the record carries none.
fn content_blocks(record: &Value) -> Option<&Vec<Value>> {
    record.get("message")?.get("content")?.as_array()
}

/// The record's `event_at` in epoch ms from its top-level `timestamp`, falling back to the session
/// start when a record omits or malforms it. Triplicated from the sibling Claude emitters deliberately;
/// hoisting it would edit those committed files, outside this task's lane. Future cleanup.
fn record_event_at(record: &Value, ctx: &SessionContext) -> i64 {
    record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(rfc3339_to_epoch_ms)
        .or(ctx.vendor_started_at)
        .unwrap_or(0)
}

fn status_from_outcome(outcome: ToolOutcome) -> AgentEventStatus {
    match outcome {
        ToolOutcome::Success => AgentEventStatus::Success,
        ToolOutcome::Failure => AgentEventStatus::Failure,
        ToolOutcome::Unknown => AgentEventStatus::Unknown,
    }
}

/// Truncates `text` to at most `max_bytes` bytes on a UTF-8 char boundary (never splits a code point).
fn cap_bytes(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// Redacts then caps a free-text excerpt, returning the stored value and how many fields the redactor
/// dropped. Redaction runs before the cap so a secret never survives by straddling the byte boundary.
fn excerpt(raw: Option<&str>, cap: usize) -> (String, i64) {
    match raw {
        Some(text) => {
            let redacted = redact_field(text);
            (cap_bytes(&redacted.value, cap), i64::from(redacted.dropped))
        }
        None => (String::new(), 0),
    }
}

/// Emits one [`AgentToolEventFact`] per `tool_use` block in document order. `source_block_index` is the
/// block's position in its message's full block stream (document order, stable on re-sync); identity
/// rides on `tool_use_id`, so the index is ordering metadata, not part of the pk.
pub fn claude_tool_facts(records: &[Value], ctx: &SessionContext) -> Vec<AgentToolEventFact> {
    let repo_root = Path::new(&ctx.repo_root);
    // `tool_use_id -> folded result`. The cross-record use/result join lives in `fold_tool_events`; we
    // consume only its result side here and read the use side from the records we walk below.
    let folded: HashMap<String, FoldedToolEvent> = fold_tool_events(records.iter())
        .into_iter()
        .map(|event| (event.tool_use_id.clone(), event))
        .collect();
    let mut next_block_index: HashMap<&str, i64> = HashMap::new();
    let mut facts = Vec::new();

    for record in records {
        let Some(message_id) = assistant_message_id(record) else {
            continue;
        };
        let Some(blocks) = content_blocks(record) else {
            continue;
        };
        let event_at = record_event_at(record, ctx);
        let cursor = next_block_index.entry(message_id).or_insert(0);
        for block in blocks {
            let block_index = *cursor;
            *cursor += 1;
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let Some(tool_use_id) = block.get("id").and_then(Value::as_str) else {
                continue;
            };
            let result = folded.get(tool_use_id);
            let command = block
                .get("input")
                .and_then(|input| input.get("command"))
                .and_then(Value::as_str);
            let classification = command.map(classify_command).unwrap_or_default();
            let (command_excerpt, command_dropped) = excerpt(command, COMMAND_EXCERPT_CAP_BYTES);
            let status = status_from_outcome(result.map_or(ToolOutcome::Unknown, |r| r.outcome));
            // Only a failed call has error text; on success the folded stderr (e.g. git/curl
            // progress) is not an error. Mirror the Codex/Cursor emitters and gate on Failure.
            let error_source = (status == AgentEventStatus::Failure)
                .then_some(result.and_then(|r| r.error_text.as_deref()))
                .flatten();
            let error_classification = classify_tool_error(status, error_source);
            let (error_excerpt, error_dropped) = excerpt(error_source, ERROR_EXCERPT_CAP_BYTES);
            let navigation = classify_navigation(command);
            let mut remaining_hint_budget = TOOL_EXCERPT_TOTAL_CAP_BYTES
                .saturating_sub(command_excerpt.len() + error_excerpt.len());
            let (navigation_path_hint, navigation_path_dropped) = excerpt(
                (!navigation.path_hint.is_empty()).then_some(navigation.path_hint.as_str()),
                remaining_hint_budget.min(NAVIGATION_HINT_CAP_BYTES),
            );
            remaining_hint_budget =
                remaining_hint_budget.saturating_sub(navigation_path_hint.len());
            let (navigation_pattern_hint, navigation_pattern_dropped) = excerpt(
                (!navigation.pattern_hint.is_empty()).then_some(navigation.pattern_hint.as_str()),
                remaining_hint_budget.min(NAVIGATION_HINT_CAP_BYTES),
            );
            let repo_relative_paths = block
                .get("input")
                .and_then(|input| input.get("file_path"))
                .and_then(Value::as_str)
                .map(|path| vec![relativize_repo_path(repo_root, path)])
                .unwrap_or_default();

            facts.push(AgentToolEventFact {
                vendor_session_id: ctx.vendor_session_id.clone(),
                vendor_message_id: Some(message_id.to_string()),
                tool_use_id: Some(tool_use_id.to_string()),
                source_block_index: block_index,
                event_at,
                tool_name: block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                command_family: classification.family,
                command_program: classification.program,
                command_subcommand: classification.subcommand,
                status,
                error_category: error_classification.category,
                error_category_coverage: error_classification.coverage,
                // Claude transcripts record no process exit code; status carries success/failure.
                exit_code: None,
                duration_ms: result.and_then(|r| r.duration_ms),
                is_navigation: navigation.is_navigation,
                navigation_kind: navigation.kind,
                navigation_hint_coverage: navigation.hint_coverage,
                navigation_path_hint,
                navigation_pattern_hint,
                repo_relative_paths,
                // Deferred enrichment: no parser algorithm in the ADR; PR links are a separate fact.
                extracted_provider: String::new(),
                extracted_repo: String::new(),
                extracted_pr_number: None,
                command_excerpt,
                error_excerpt,
                // A spawned sub-agent's tokens live in its own transcript's facts, not double-counted.
                extracted_subagent_agent_id: String::new(),
                extracted_subagent_model: String::new(),
                extracted_subagent_input_tokens: 0,
                extracted_subagent_output_tokens: 0,
                extracted_subagent_cache_read_tokens: 0,
                extracted_subagent_cache_creation_tokens: 0,
                dropped_sensitive: command_dropped
                    + error_dropped
                    + navigation_path_dropped
                    + navigation_pattern_dropped,
            });
        }
    }
    facts
}

#[cfg(test)]
mod tests {
    use super::*;
    use collector_contracts::enums::{
        AgentNavigationHintCoverage, AgentNavigationKind, AgentToolErrorCategory,
        AgentToolErrorCoverage,
    };
    use serde_json::json;

    const REPO_ROOT: &str = "/work/trace-flow";

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
            repo_root: REPO_ROOT.to_string(),
        }
    }

    fn bash_use(id: &str, command: &str) -> Value {
        json!({
            "type": "assistant",
            "timestamp": "2026-05-27T12:00:00Z",
            "message": { "id": "msg_1", "content": [
                { "type": "tool_use", "id": id, "name": "Bash", "input": { "command": command } }
            ] }
        })
    }

    fn read_use(id: &str, file_path: &str) -> Value {
        json!({
            "type": "assistant",
            "timestamp": "2026-05-27T12:00:00Z",
            "message": { "id": "msg_1", "content": [
                { "type": "tool_use", "id": id, "name": "Read", "input": { "file_path": file_path } }
            ] }
        })
    }

    fn result(id: &str, is_error: bool, sidecar: Value) -> Value {
        json!({
            "type": "user",
            "timestamp": "2026-05-27T12:00:01Z",
            "message": { "content": [{
                "type": "tool_result", "tool_use_id": id, "is_error": is_error, "content": "ok"
            }] },
            "toolUseResult": sidecar,
        })
    }

    #[test]
    fn bash_success_classifies_and_carries_no_exit_code() {
        let records = [
            bash_use("t1", "git push origin HEAD"),
            result(
                "t1",
                false,
                json!({ "stdout": "done", "durationMs": 42, "interrupted": false }),
            ),
        ];
        let facts = claude_tool_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        let f = &facts[0];
        assert_eq!(f.tool_name, "Bash");
        assert_eq!(f.command_program, "git");
        assert_eq!(f.command_family, "git");
        assert_eq!(f.command_subcommand, "push");
        assert_eq!(f.status, AgentEventStatus::Success);
        assert_eq!(f.error_category, AgentToolErrorCategory::Unknown);
        assert_eq!(
            f.error_category_coverage,
            AgentToolErrorCoverage::NotApplicable
        );
        assert_eq!(f.exit_code, None);
        assert_eq!(f.duration_ms, Some(42));
        assert!(!f.is_navigation);
        assert_eq!(f.navigation_kind, AgentNavigationKind::None);
        assert_eq!(
            f.navigation_hint_coverage,
            AgentNavigationHintCoverage::Unknown
        );
        assert_eq!(f.command_excerpt, "git push origin HEAD");
        assert_eq!(f.error_excerpt, "");
        assert!(f.repo_relative_paths.is_empty());
        assert_eq!(f.vendor_message_id.as_deref(), Some("msg_1"));
        assert_eq!(f.tool_use_id.as_deref(), Some("t1"));
        assert_eq!(f.dropped_sensitive, 0);
    }

    #[test]
    fn enrichment_columns_ship_empty() {
        let records = [bash_use("t1", "ls")];
        let f = &claude_tool_facts(&records, &ctx())[0];
        assert_eq!(f.extracted_provider, "");
        assert_eq!(f.extracted_repo, "");
        assert_eq!(f.extracted_pr_number, None);
        assert_eq!(f.extracted_subagent_agent_id, "");
        assert_eq!(f.extracted_subagent_input_tokens, 0);
        assert_eq!(f.extracted_subagent_cache_creation_tokens, 0);
    }

    #[test]
    fn failed_call_takes_the_redacted_stderr_excerpt() {
        let records = [
            bash_use("t1", "curl https://api"),
            result(
                "t1",
                true,
                json!({ "stderr": "failed for user /Users/janedoe/x", "interrupted": false }),
            ),
        ];
        let f = &claude_tool_facts(&records, &ctx())[0];
        assert_eq!(f.status, AgentEventStatus::Failure);
        assert!(f.error_excerpt.contains("failed for user"));
        assert!(!f.error_excerpt.contains("janedoe"));
    }

    #[test]
    fn failed_call_carries_bounded_error_category() {
        let records = [
            bash_use("t1", "cat missing.txt"),
            result(
                "t1",
                true,
                json!({ "stderr": "cat: missing.txt: No such file or directory", "interrupted": false }),
            ),
        ];
        let f = &claude_tool_facts(&records, &ctx())[0];
        assert_eq!(f.status, AgentEventStatus::Failure);
        assert_eq!(f.error_category, AgentToolErrorCategory::MissingFile);
        assert_eq!(
            f.error_category_coverage,
            AgentToolErrorCoverage::Classified
        );
    }

    #[test]
    fn bash_search_command_carries_navigation_hints() {
        let records = [bash_use("t1", "rg -n \"AgentToolEventFact\" packages")];
        let f = &claude_tool_facts(&records, &ctx())[0];
        assert!(f.is_navigation);
        assert_eq!(f.navigation_kind, AgentNavigationKind::Search);
        assert_eq!(
            f.navigation_hint_coverage,
            AgentNavigationHintCoverage::Structured
        );
        assert_eq!(f.navigation_pattern_hint, "AgentToolEventFact");
        assert_eq!(f.navigation_path_hint, "packages");
    }

    #[test]
    fn read_tool_records_the_relativized_path_and_no_command() {
        let records = [read_use("t1", "/work/trace-flow/src/main.rs")];
        let f = &claude_tool_facts(&records, &ctx())[0];
        assert_eq!(f.tool_name, "Read");
        assert_eq!(f.repo_relative_paths, vec!["src/main.rs".to_string()]);
        assert_eq!(f.command_excerpt, "");
        assert_eq!(f.command_family, "");
    }

    #[test]
    fn read_outside_repo_path_collapses_to_sentinel() {
        let records = [read_use("t1", "/Users/janedoe/secrets/.env")];
        let f = &claude_tool_facts(&records, &ctx())[0];
        assert_eq!(f.repo_relative_paths, vec!["outside_repo".to_string()]);
    }

    #[test]
    fn command_excerpt_redaction_drops_a_secret_and_counts_it() {
        // Assembled at runtime so the fixture exercises the redaction path without committing a
        // PAT-shaped literal that trips secret scanners. 36 chars matches the `ghp_` drop matcher.
        let token = format!("ghp_{}", "0".repeat(36));
        let records = [bash_use("t1", &format!("deploy --token={token}"))];
        let f = &claude_tool_facts(&records, &ctx())[0];
        assert!(f.dropped_sensitive >= 1);
        assert!(!f.command_excerpt.contains("ghp_"));
    }

    #[test]
    fn command_excerpt_is_capped_at_one_kilobyte() {
        let long = "a".repeat(5000);
        let records = [bash_use("t1", &long)];
        let f = &claude_tool_facts(&records, &ctx())[0];
        assert_eq!(f.command_excerpt.len(), COMMAND_EXCERPT_CAP_BYTES);
    }

    #[test]
    fn error_excerpt_is_capped_at_four_kilobytes() {
        let long = "e".repeat(9000);
        let records = [
            bash_use("t1", "boom"),
            result("t1", true, json!({ "stderr": long, "interrupted": false })),
        ];
        let f = &claude_tool_facts(&records, &ctx())[0];
        assert_eq!(f.error_excerpt.len(), ERROR_EXCERPT_CAP_BYTES);
    }

    #[test]
    fn navigation_hints_use_only_the_remaining_excerpt_budget() {
        let pattern = "p".repeat(2000);
        let path = "d".repeat(2000);
        let command = format!("rg {pattern} {path}");
        let records = [
            bash_use("t1", &command),
            result(
                "t1",
                true,
                json!({ "stderr": "e".repeat(9000), "interrupted": false }),
            ),
        ];
        let f = &claude_tool_facts(&records, &ctx())[0];
        assert_eq!(f.command_excerpt.len(), COMMAND_EXCERPT_CAP_BYTES);
        assert_eq!(f.error_excerpt.len(), ERROR_EXCERPT_CAP_BYTES);
        assert_eq!(f.navigation_path_hint, "");
        assert_eq!(f.navigation_pattern_hint, "");
        assert!(
            f.command_excerpt.len()
                + f.error_excerpt.len()
                + f.navigation_path_hint.len()
                + f.navigation_pattern_hint.len()
                <= TOOL_EXCERPT_TOTAL_CAP_BYTES
        );
    }

    #[test]
    fn dangling_tool_use_with_no_result_is_unknown() {
        let records = [bash_use("t1", "sleep 999")];
        let f = &claude_tool_facts(&records, &ctx())[0];
        assert_eq!(f.status, AgentEventStatus::Unknown);
        assert_eq!(f.duration_ms, None);
        assert_eq!(f.error_excerpt, "");
    }

    #[test]
    fn block_index_tracks_position_within_the_message() {
        let records = [json!({
            "type": "assistant",
            "timestamp": "2026-05-27T12:00:00Z",
            "message": { "id": "msg_1", "content": [
                { "type": "thinking", "thinking": "plan" },
                { "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } }
            ] }
        })];
        let f = &claude_tool_facts(&records, &ctx())[0];
        assert_eq!(f.source_block_index, 1);
        assert_eq!(f.event_at, 1_779_883_200_000);
    }

    #[test]
    fn non_assistant_and_non_tool_blocks_emit_nothing() {
        let records = [
            json!({ "type": "user", "message": { "content": [{ "type": "text", "text": "hi" }] } }),
            json!({
                "type": "assistant",
                "message": { "id": "msg_1", "content": [{ "type": "text", "text": "ok" }] }
            }),
        ];
        assert!(claude_tool_facts(&records, &ctx()).is_empty());
    }
}
