// SPDX-License-Identifier: MIT
// Original Trace Flow code. One unpriced `AgentToolEventFact` per Cursor `toolFormerData` block, with a
// structurally-classified shell command and redacted capped excerpts only. Trace Flow owns the contract,
// IDs, pricing, redaction, and storage around this code.

//! Cursor `AgentToolEventFact` emission. [`cursor_tool_facts`] emits one fact per bubble that carries a
//! `toolFormerData` block (a tool invocation). Unlike Codex — where success rides a parsed process exit
//! code — Cursor records a `status` string (`completed` / `error` / `cancelled` / `loading` / `""`), so
//! `status` maps directly: `completed` is success, `error` is failure, anything else (in-flight,
//! cancelled, or absent) is unknown. Only the terminal tools (`run_terminal_command_v2`, …) carry a
//! shell `command` to classify; file tools (`read_file_v2`, `edit_file_v2`) carry a `targetFile`, which
//! is the file emitter's concern. `exit_code` and `duration_ms` have no Cursor source, so they ship as
//! `None`. Provider/repo/PR and sub-agent enrichment columns ship empty, matching the JSONL emitters.

use collector_contracts::enums::AgentEventStatus;
use collector_contracts::facts::AgentToolEventFact;
use serde_json::Value;

use crate::command::classify_command;
use crate::cursor_records::{bubble_id, composer_id, tool_block, ToolBlock};
use crate::redaction::redact_field;
use crate::session_context::SessionContext;
use crate::timestamp::rfc3339_to_epoch_ms;

/// ADR caps: `command_excerpt` <= 1 KB, `error_excerpt` <= 4 KB. Mirrors the JSONL tool emitters.
const COMMAND_EXCERPT_CAP_BYTES: usize = 1024;
const ERROR_EXCERPT_CAP_BYTES: usize = 4096;

/// Truncates `text` to at most `max_bytes` bytes on a UTF-8 char boundary (never splits a code point).
/// Duplicated from the Codex/Claude tool emitters deliberately — hoisting it would edit those committed
/// files, outside this task's lane. Future cleanup: a shared excerpt module.
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

/// Cursor records a tool's outcome as a status string, not a process exit code: `completed` succeeds,
/// `error` fails, and anything else — an in-flight `loading`, a `cancelled`, or an absent status — is
/// unknown (counted, but excluded from failure-rate denominators downstream).
fn status_from_cursor(status: &str) -> AgentEventStatus {
    match status {
        "completed" => AgentEventStatus::Success,
        "error" => AgentEventStatus::Failure,
        _ => AgentEventStatus::Unknown,
    }
}

/// The bubble's `event_at` in epoch ms from its ISO-8601 `createdAt`, falling back to the session start.
fn bubble_event_at(record: &Value, ctx: &SessionContext) -> i64 {
    record
        .get("createdAt")
        .and_then(Value::as_str)
        .and_then(rfc3339_to_epoch_ms)
        .or(ctx.vendor_started_at)
        .unwrap_or(0)
}

fn tool_fact(
    record: &Value,
    block: &ToolBlock,
    block_index: i64,
    ctx: &SessionContext,
) -> AgentToolEventFact {
    let command = block.command.as_deref();
    let classification = command.map(classify_command).unwrap_or_default();
    let (command_excerpt, command_dropped) = excerpt(command, COMMAND_EXCERPT_CAP_BYTES);

    let status = status_from_cursor(block.status);
    // The tool's own result text is the diagnostic for a failed call; on success there is no error.
    let error_source = (status == AgentEventStatus::Failure)
        .then_some(block.result)
        .flatten();
    let (error_excerpt, error_dropped) = excerpt(error_source, ERROR_EXCERPT_CAP_BYTES);

    AgentToolEventFact {
        vendor_session_id: composer_id(record)
            .unwrap_or(&ctx.vendor_session_id)
            .to_string(),
        // Cursor bubbles carry a stable id; the tool belongs to its bubble's message.
        vendor_message_id: bubble_id(record).map(str::to_string),
        // The tool's own call id when present; absent ids fall back to the positional block index for
        // distinctness, exactly like the id-less Codex path.
        tool_use_id: block.tool_call_id.map(str::to_string),
        source_block_index: block_index,
        event_at: bubble_event_at(record, ctx),
        tool_name: block.name.to_string(),
        command_family: classification.family,
        command_program: classification.program,
        command_subcommand: classification.subcommand,
        status,
        // Cursor records no process exit code or call duration.
        exit_code: None,
        duration_ms: None,
        // File paths a tool touched are the file emitter's concern, not duplicated here.
        repo_relative_paths: Vec::new(),
        // Deferred enrichment: no parser algorithm in the ADR; PR links are a separate fact.
        extracted_provider: String::new(),
        extracted_repo: String::new(),
        extracted_pr_number: None,
        command_excerpt,
        error_excerpt,
        extracted_subagent_agent_id: String::new(),
        extracted_subagent_model: String::new(),
        extracted_subagent_input_tokens: 0,
        extracted_subagent_output_tokens: 0,
        extracted_subagent_cache_read_tokens: 0,
        extracted_subagent_cache_creation_tokens: 0,
        dropped_sensitive: command_dropped + error_dropped,
    }
}

/// Emits one [`AgentToolEventFact`] per bubble carrying a `toolFormerData` block, in the reader's bubble
/// order. `source_block_index` is the tool's 0-based position among the session's tool calls (stable on
/// re-parse); identity rides `tool_use_id` (the call id) plus the bubble's `vendor_message_id`.
pub fn cursor_tool_facts(records: &[Value], ctx: &SessionContext) -> Vec<AgentToolEventFact> {
    let mut block_index = 0i64;
    let mut facts = Vec::new();
    for record in records {
        let Some(block) = tool_block(record) else {
            continue;
        };
        // A `toolFormerData` with no name is not a usable tool event; skip it without consuming an index.
        if block.name.is_empty() {
            continue;
        }
        facts.push(tool_fact(record, &block, block_index, ctx));
        block_index += 1;
    }
    facts
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

    fn terminal_tool(command: &str, status: &str, result: Option<&str>) -> Value {
        let params = serde_json::to_string(&json!({ "command": command })).unwrap();
        let mut tool = json!({
            "name": "run_terminal_command_v2",
            "toolCallId": "call-1",
            "status": status,
            "params": params,
        });
        if let (Value::Object(map), Some(text)) = (&mut tool, result) {
            map.insert("result".to_string(), json!(text));
        }
        bubble("comp-1", "gpt-5.2", 2, json!({ "toolFormerData": tool }))
    }

    #[test]
    fn a_completed_terminal_command_classifies_and_succeeds() {
        let records = [terminal_tool("git push origin HEAD", "completed", None)];
        let facts = cursor_tool_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        let f = &facts[0];
        assert_eq!(f.tool_name, "run_terminal_command_v2");
        assert_eq!(f.command_program, "git");
        assert_eq!(f.command_family, "git");
        assert_eq!(f.command_subcommand, "push");
        assert_eq!(f.status, AgentEventStatus::Success);
        assert_eq!(f.command_excerpt, "git push origin HEAD");
        assert_eq!(f.exit_code, None);
        assert_eq!(f.duration_ms, None);
        assert_eq!(f.tool_use_id.as_deref(), Some("call-1"));
        assert_eq!(f.vendor_message_id.as_deref(), Some("bub-1"));
    }

    #[test]
    fn an_error_status_is_a_failure_and_takes_the_result_as_error() {
        let records = [terminal_tool(
            "cargo build",
            "error",
            Some("error[E0425]: cannot find value"),
        )];
        let f = &cursor_tool_facts(&records, &ctx())[0];
        assert_eq!(f.status, AgentEventStatus::Failure);
        assert!(f.error_excerpt.contains("error[E0425]"));
    }

    #[test]
    fn a_loading_or_cancelled_status_is_unknown() {
        for status in ["loading", "cancelled", ""] {
            let records = [terminal_tool("sleep 99", status, None)];
            let f = &cursor_tool_facts(&records, &ctx())[0];
            assert_eq!(f.status, AgentEventStatus::Unknown, "status {status:?}");
        }
    }

    #[test]
    fn a_file_tool_carries_no_command_classification() {
        let params =
            serde_json::to_string(&json!({ "targetFile": "/work/repo/src/a.rs" })).unwrap();
        let records = [bubble(
            "comp-1",
            "gpt-5.2",
            2,
            json!({ "toolFormerData": { "name": "read_file_v2", "status": "completed", "params": params } }),
        )];
        let f = &cursor_tool_facts(&records, &ctx())[0];
        assert_eq!(f.tool_name, "read_file_v2");
        assert_eq!(f.command_family, "");
        assert_eq!(f.command_excerpt, "");
    }

    #[test]
    fn command_excerpt_redaction_drops_a_secret_and_counts_it() {
        let token = format!("ghp_{}", "0".repeat(36));
        let records = [terminal_tool(
            &format!("deploy --token={token}"),
            "completed",
            None,
        )];
        let f = &cursor_tool_facts(&records, &ctx())[0];
        assert!(f.dropped_sensitive >= 1);
        assert!(!f.command_excerpt.contains("ghp_"));
    }

    #[test]
    fn error_excerpt_masks_a_home_path() {
        let records = [terminal_tool(
            "cat config",
            "error",
            Some("failed reading /Users/janedoe/.aws/credentials"),
        )];
        let f = &cursor_tool_facts(&records, &ctx())[0];
        assert!(f.error_excerpt.contains("failed reading"));
        assert!(!f.error_excerpt.contains("janedoe"));
    }

    #[test]
    fn block_index_tracks_tool_position_and_skips_non_tool_bubbles() {
        let records = [
            bubble("comp-1", "gpt-5.2", 1, json!({})), // a plain message, no tool
            terminal_tool("ls", "completed", None),
            bubble("comp-1", "gpt-5.2", 2, json!({})), // another plain message
            terminal_tool("pwd", "completed", None),
        ];
        let facts = cursor_tool_facts(&records, &ctx());
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].source_block_index, 0);
        assert_eq!(facts[1].source_block_index, 1);
    }

    #[test]
    fn command_excerpt_is_capped_at_one_kilobyte() {
        let records = [terminal_tool(&"a".repeat(5000), "completed", None)];
        let f = &cursor_tool_facts(&records, &ctx())[0];
        assert_eq!(f.command_excerpt.len(), COMMAND_EXCERPT_CAP_BYTES);
    }

    #[test]
    fn empty_session_emits_no_facts() {
        assert!(cursor_tool_facts(&[], &ctx()).is_empty());
    }
}
