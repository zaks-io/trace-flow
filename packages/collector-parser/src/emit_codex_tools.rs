// SPDX-License-Identifier: Apache-2.0
// Adapted from otto-parser/src/parser/codex_cli/blocks.rs tool extraction (~/src/otto, 2026-05-25).
// Reworked: otto emitted the tool_use and the tool_result as two separate NormalizedToolEvents; Trace
// Flow folds the Codex `function_call`/`function_call_output` pair (joined by `call_id`) into ONE
// unpriced `AgentToolEventFact`, classifies the `exec_command` shell command structurally, parses the
// process exit code from the output text, and ships redacted capped excerpts only.
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Codex CLI `AgentToolEventFact` emission. [`codex_tool_facts`] emits one fact per `function_call`
//! record, joined to its `function_call_output` by `call_id`. Unlike Claude's Bash sidecar — which
//! records only `interrupted`/`stderr`/`stdout` — a Codex exec output carries a `Process exited with
//! code N` line, so `exit_code` is populated and `status` rides it: exit `0` is success, non-zero is
//! failure, and a call with no parseable code (a dangling call, or an MCP tool whose output carries no
//! process code) is `Unknown`. `duration_ms` is the wall-clock gap between the call record and its
//! output record. Only `exec_command` carries a shell command to classify; extracting touched files
//! from `apply_patch` shell text is the file emitter's job, so `repo_relative_paths` ships empty here.
//! Provider/repo/PR and sub-agent enrichment are deferred (the ADR names the columns but gives no
//! parser algorithm), so those columns ship empty.

use std::collections::HashMap;
use std::sync::LazyLock;

use collector_contracts::enums::AgentEventStatus;
use collector_contracts::facts::AgentToolEventFact;
use regex::Regex;
use serde_json::Value;

use crate::command::classify_command;
use crate::redaction::redact_field;
use crate::session_context::SessionContext;
use crate::timestamp::rfc3339_to_epoch_ms;
use crate::tool_signals::{classify_navigation, classify_tool_error};

/// ADR caps: command <= 1 KB, error <= 4 KB, and navigation hints consume only the remaining 5 KB
/// budget.
const COMMAND_EXCERPT_CAP_BYTES: usize = 1024;
const ERROR_EXCERPT_CAP_BYTES: usize = 4096;
const NAVIGATION_HINT_CAP_BYTES: usize = 256;
const TOOL_EXCERPT_TOTAL_CAP_BYTES: usize = 5 * 1024;

/// Clock-skew guard: a call→output gap outside `0..=30 days` is treated as unknown duration, never
/// stored. Mirrors otto's `MAX_TOOL_DURATION_MS` bound.
const MAX_DURATION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Codex appends a `Process exited with code N` line to an exec output. Anchored per-line
/// (case-insensitive, multiline) so it matches the status line, not an occurrence inside command text.
static EXIT_CODE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)^Process exited with code (-?\d+)[ \t]*$").expect("exit code pattern")
});

/// The record's `payload.type` (`function_call`, `function_call_output`, `message`, …), or `None`.
fn payload_type(record: &Value) -> Option<&str> {
    record.get("payload")?.get("type")?.as_str()
}

/// The record's `payload.call_id` — the join key between a `function_call` and its output.
fn call_id(record: &Value) -> Option<&str> {
    record.get("payload")?.get("call_id")?.as_str()
}

/// The record's `event_at` in epoch ms from its top-level RFC3339 `timestamp`, falling back to the
/// session start when a record omits or malforms it (real Codex records always carry one).
fn record_event_at(record: &Value, ctx: &SessionContext) -> i64 {
    record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(rfc3339_to_epoch_ms)
        .or(ctx.vendor_started_at)
        .unwrap_or(0)
}

/// A `function_call`'s `arguments` (a JSON-encoded string) parsed back to a `Value`, or `Null` when it
/// is absent or not valid JSON. `exec_command` carries `{cmd, workdir, …}` here.
fn parse_arguments(record: &Value) -> Value {
    record
        .get("payload")
        .and_then(|p| p.get("arguments"))
        .and_then(Value::as_str)
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .unwrap_or(Value::Null)
}

/// The text body of a `function_call_output`. Real Codex builds store a plain string; the object arm
/// covers a build that wraps the result as `{output, metadata}`.
fn output_text(output_record: &Value) -> Option<String> {
    let raw = output_record.get("payload")?.get("output")?;
    match raw {
        Value::String(text) => Some(text.clone()),
        Value::Object(_) => raw
            .get("output")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

/// The first `Process exited with code N` line in the output text, or `None` when none is present (a
/// dangling call, or an MCP tool whose output carries no process code). Codex writes the status line in
/// the preamble (before the `Output:` body), so the first match is the authoritative one; a later
/// occurrence echoed by the command's own output is ignored.
fn exit_code_from_output(output: Option<&str>) -> Option<i64> {
    let text = output?;
    EXIT_CODE_PATTERN
        .captures_iter(text)
        .filter_map(|caps| caps.get(1)?.as_str().parse::<i64>().ok())
        .next()
}

/// Codex success/failure is the process exit code: `0` succeeds, non-zero fails, absent is unknown
/// (counted, but excluded from failure-rate denominators downstream).
fn status_from_exit_code(exit_code: Option<i64>) -> AgentEventStatus {
    match exit_code {
        Some(0) => AgentEventStatus::Success,
        Some(_) => AgentEventStatus::Failure,
        None => AgentEventStatus::Unknown,
    }
}

/// The wall-clock gap (ms) between a call and its output record, or `None` when the call has no output
/// or the gap is negative / beyond [`MAX_DURATION_MS`] (clock skew).
fn call_duration_ms(
    call_at: i64,
    output_record: Option<&Value>,
    ctx: &SessionContext,
) -> Option<i64> {
    let delta = record_event_at(output_record?, ctx) - call_at;
    (0..=MAX_DURATION_MS).contains(&delta).then_some(delta)
}

/// Truncates `text` to at most `max_bytes` bytes on a UTF-8 char boundary (never splits a code point).
/// Duplicated from the Claude tool emitter deliberately — hoisting it would edit that committed file,
/// outside this task's lane. Future cleanup: a shared excerpt module.
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

/// Emits one [`AgentToolEventFact`] per Codex `function_call` record in file order, joined to its
/// `function_call_output` by `call_id`. `source_block_index` is the call's 0-based position among the
/// session's function calls (ordering metadata, stable on re-parse); identity rides on `tool_use_id`
/// (the `call_id`), so the index is not part of the pk.
pub fn codex_tool_facts(records: &[Value], ctx: &SessionContext) -> Vec<AgentToolEventFact> {
    // `call_id -> output record`. The result side is a separate top-level record, joined by call_id.
    let outputs: HashMap<&str, &Value> = records
        .iter()
        .filter(|record| payload_type(record) == Some("function_call_output"))
        .filter_map(|record| Some((call_id(record)?, record)))
        .collect();

    let mut block_index = 0i64;
    let mut facts = Vec::new();
    for record in records {
        if payload_type(record) != Some("function_call") {
            continue;
        }
        let payload = record.get("payload");
        // Identity rides on `call_id`; a `function_call` without one can't form a stable
        // `tool_use_id`, and several such records would all collapse to `None` and collide. Skip it.
        let Some(id) = payload
            .and_then(|p| p.get("call_id"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let tool_name = payload
            .and_then(|p| p.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default();

        let arguments = parse_arguments(record);
        // Only `exec_command` carries a shell command; MCP tools (get_issue, …) and write_stdin do not.
        let command = (tool_name == "exec_command")
            .then(|| arguments.get("cmd").and_then(Value::as_str))
            .flatten();
        let classification = command.map(classify_command).unwrap_or_default();
        let (command_excerpt, command_dropped) = excerpt(command, COMMAND_EXCERPT_CAP_BYTES);

        let output_record = outputs.get(id).copied();
        let out_text = output_record.and_then(output_text);
        let exit_code = exit_code_from_output(out_text.as_deref());
        let status = status_from_exit_code(exit_code);
        // The exec output is the diagnostic text for a failed call; on success there is no error.
        let error_source = (status == AgentEventStatus::Failure)
            .then_some(out_text.as_deref())
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
        remaining_hint_budget = remaining_hint_budget.saturating_sub(navigation_path_hint.len());
        let (navigation_pattern_hint, navigation_pattern_dropped) = excerpt(
            (!navigation.pattern_hint.is_empty()).then_some(navigation.pattern_hint.as_str()),
            remaining_hint_budget.min(NAVIGATION_HINT_CAP_BYTES),
        );

        let event_at = record_event_at(record, ctx);

        facts.push(AgentToolEventFact {
            vendor_session_id: ctx.vendor_session_id.clone(),
            // Codex emits no per-message vendor ID; tool identity rides `tool_use_id` (the call_id).
            vendor_message_id: None,
            tool_use_id: Some(id.to_string()),
            source_block_index: block_index,
            event_at,
            tool_name: tool_name.to_string(),
            command_family: classification.family,
            command_program: classification.program,
            command_subcommand: classification.subcommand,
            status,
            error_category: error_classification.category,
            error_category_coverage: error_classification.coverage,
            exit_code,
            duration_ms: call_duration_ms(event_at, output_record, ctx),
            is_navigation: navigation.is_navigation,
            navigation_kind: navigation.kind,
            navigation_hint_coverage: navigation.hint_coverage,
            navigation_path_hint,
            navigation_pattern_hint,
            // Codex function calls carry no structured file path; extracting touched files from
            // `apply_patch` shell text is the file emitter's job.
            repo_relative_paths: Vec::new(),
            // Deferred enrichment: no parser algorithm in the ADR; PR links are a separate fact.
            extracted_provider: String::new(),
            extracted_repo: String::new(),
            extracted_pr_number: None,
            command_excerpt,
            error_excerpt,
            // A spawned sub-agent's tokens live in its own transcript's facts, not double-counted here.
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
        block_index += 1;
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
            repo_root: String::new(),
        }
    }

    fn exec_call(call_id: &str, cmd: &str, ts: &str) -> Value {
        let arguments = serde_json::to_string(&json!({
            "cmd": cmd,
            "workdir": "/work/trace-flow",
            "yield_time_ms": 1000,
            "max_output_tokens": 20000,
        }))
        .unwrap();
        json!({
            "type": "response_item",
            "timestamp": ts,
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "arguments": arguments,
                "call_id": call_id,
            }
        })
    }

    fn named_call(call_id: &str, name: &str, ts: &str) -> Value {
        json!({
            "type": "response_item",
            "timestamp": ts,
            "payload": { "type": "function_call", "name": name, "arguments": "{}", "call_id": call_id }
        })
    }

    fn output(call_id: &str, text: &str, ts: &str) -> Value {
        json!({
            "type": "response_item",
            "timestamp": ts,
            "payload": { "type": "function_call_output", "call_id": call_id, "output": text }
        })
    }

    /// An exec output framed the way Codex writes it: preamble, the `Process exited` status line, body.
    fn exec_output(exit_code: i64, body: &str) -> String {
        format!(
            "Chunk ID: abc123\nWall time: 0.0000 seconds\nProcess exited with code {exit_code}\nOutput:\n{body}\n"
        )
    }

    #[test]
    fn exec_command_success_classifies_and_carries_exit_code_zero() {
        let records = [
            exec_call("c1", "git push origin HEAD", "2026-05-16T20:53:00.000Z"),
            output("c1", &exec_output(0, "done"), "2026-05-16T20:53:01.200Z"),
        ];
        let facts = codex_tool_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        let f = &facts[0];
        assert_eq!(f.tool_name, "exec_command");
        assert_eq!(f.command_program, "git");
        assert_eq!(f.command_family, "git");
        assert_eq!(f.command_subcommand, "push");
        assert_eq!(f.status, AgentEventStatus::Success);
        assert_eq!(f.error_category, AgentToolErrorCategory::Unknown);
        assert_eq!(
            f.error_category_coverage,
            AgentToolErrorCoverage::NotApplicable
        );
        assert_eq!(f.exit_code, Some(0));
        assert!(!f.is_navigation);
        assert_eq!(f.navigation_kind, AgentNavigationKind::None);
        assert_eq!(
            f.navigation_hint_coverage,
            AgentNavigationHintCoverage::Unknown
        );
        assert_eq!(f.command_excerpt, "git push origin HEAD");
        assert_eq!(f.error_excerpt, "");
        assert!(f.repo_relative_paths.is_empty());
        assert_eq!(f.vendor_message_id, None);
        assert_eq!(f.tool_use_id.as_deref(), Some("c1"));
        assert_eq!(f.dropped_sensitive, 0);
    }

    #[test]
    fn nonzero_exit_code_is_a_failure_and_takes_the_output_as_error() {
        let records = [
            exec_call("c1", "cargo build", "2026-05-16T20:53:00.000Z"),
            output(
                "c1",
                &exec_output(1, "error[E0425]: cannot find value"),
                "2026-05-16T20:53:09.000Z",
            ),
        ];
        let f = &codex_tool_facts(&records, &ctx())[0];
        assert_eq!(f.status, AgentEventStatus::Failure);
        assert_eq!(f.exit_code, Some(1));
        assert!(f.error_excerpt.contains("error[E0425]"));
    }

    #[test]
    fn nonzero_exit_code_carries_bounded_error_category() {
        let records = [
            exec_call("c1", "cat missing.txt", "2026-05-16T20:53:00.000Z"),
            output(
                "c1",
                &exec_output(1, "cat: missing.txt: No such file or directory"),
                "2026-05-16T20:53:01.000Z",
            ),
        ];
        let f = &codex_tool_facts(&records, &ctx())[0];
        assert_eq!(f.status, AgentEventStatus::Failure);
        assert_eq!(f.error_category, AgentToolErrorCategory::MissingFile);
        assert_eq!(
            f.error_category_coverage,
            AgentToolErrorCoverage::Classified
        );
    }

    #[test]
    fn exec_search_command_carries_navigation_hints() {
        let records = [exec_call(
            "c1",
            "sed -n '1,120p' packages/types/src/agent-ingest.ts",
            "2026-05-16T20:53:00.000Z",
        )];
        let f = &codex_tool_facts(&records, &ctx())[0];
        assert!(f.is_navigation);
        assert_eq!(f.navigation_kind, AgentNavigationKind::FileRead);
        assert_eq!(
            f.navigation_hint_coverage,
            AgentNavigationHintCoverage::Structured
        );
        assert_eq!(f.navigation_pattern_hint, "1,120p");
        assert_eq!(f.navigation_path_hint, "packages/types/src/agent-ingest.ts");
    }

    #[test]
    fn git_exit_code_128_is_a_failure() {
        let records = [
            exec_call("c1", "git rebase main", "2026-05-16T20:53:00.000Z"),
            output(
                "c1",
                &exec_output(128, "fatal: no rebase in progress"),
                "2026-05-16T20:53:01.000Z",
            ),
        ];
        let f = &codex_tool_facts(&records, &ctx())[0];
        assert_eq!(f.exit_code, Some(128));
        assert_eq!(f.status, AgentEventStatus::Failure);
    }

    #[test]
    fn the_preamble_status_line_wins_over_an_echo_in_the_body() {
        // The real status line sits in the preamble (before `Output:`); a command that prints the
        // phrase in its own output must not shadow it.
        let body = "Process exited with code 1\nthat was the inner program";
        let records = [
            exec_call("c1", "bash run.sh", "2026-05-16T20:53:00.000Z"),
            output("c1", &exec_output(0, body), "2026-05-16T20:53:01.000Z"),
        ];
        let f = &codex_tool_facts(&records, &ctx())[0];
        assert_eq!(f.exit_code, Some(0));
        assert_eq!(f.status, AgentEventStatus::Success);
    }

    #[test]
    fn dangling_call_with_no_output_is_unknown() {
        let records = [exec_call("c1", "sleep 999", "2026-05-16T20:53:00.000Z")];
        let f = &codex_tool_facts(&records, &ctx())[0];
        assert_eq!(f.status, AgentEventStatus::Unknown);
        assert_eq!(f.exit_code, None);
        assert_eq!(f.duration_ms, None);
        assert_eq!(f.error_excerpt, "");
    }

    #[test]
    fn mcp_tool_without_a_process_code_is_unknown_with_no_command() {
        let records = [
            named_call("c1", "get_issue", "2026-05-16T20:53:00.000Z"),
            output(
                "c1",
                "{\"id\":\"TRA-1\",\"title\":\"x\"}",
                "2026-05-16T20:53:00.400Z",
            ),
        ];
        let f = &codex_tool_facts(&records, &ctx())[0];
        assert_eq!(f.tool_name, "get_issue");
        assert_eq!(f.status, AgentEventStatus::Unknown);
        assert_eq!(f.exit_code, None);
        assert_eq!(f.command_family, "");
        assert_eq!(f.command_excerpt, "");
    }

    #[test]
    fn write_stdin_carries_no_command_classification() {
        let records = [named_call("c1", "write_stdin", "2026-05-16T20:53:00.000Z")];
        let f = &codex_tool_facts(&records, &ctx())[0];
        assert_eq!(f.tool_name, "write_stdin");
        assert_eq!(f.command_family, "");
        assert_eq!(f.command_program, "");
        assert_eq!(f.command_excerpt, "");
    }

    #[test]
    fn command_excerpt_redaction_drops_a_secret_and_counts_it() {
        // Assembled at runtime so the fixture exercises the redaction path without committing a
        // PAT-shaped literal that trips secret scanners. 36 chars matches the `ghp_` drop matcher.
        let token = format!("ghp_{}", "0".repeat(36));
        let records = [exec_call(
            "c1",
            &format!("deploy --token={token}"),
            "2026-05-16T20:53:00.000Z",
        )];
        let f = &codex_tool_facts(&records, &ctx())[0];
        assert!(f.dropped_sensitive >= 1);
        assert!(!f.command_excerpt.contains("ghp_"));
    }

    #[test]
    fn error_excerpt_masks_a_home_path() {
        let records = [
            exec_call("c1", "cat config", "2026-05-16T20:53:00.000Z"),
            output(
                "c1",
                &exec_output(1, "failed reading /Users/janedoe/.aws/credentials"),
                "2026-05-16T20:53:01.000Z",
            ),
        ];
        let f = &codex_tool_facts(&records, &ctx())[0];
        assert!(f.error_excerpt.contains("failed reading"));
        assert!(!f.error_excerpt.contains("janedoe"));
    }

    #[test]
    fn command_excerpt_is_capped_at_one_kilobyte() {
        let long = "a".repeat(5000);
        let records = [exec_call("c1", &long, "2026-05-16T20:53:00.000Z")];
        let f = &codex_tool_facts(&records, &ctx())[0];
        assert_eq!(f.command_excerpt.len(), COMMAND_EXCERPT_CAP_BYTES);
    }

    #[test]
    fn error_excerpt_is_capped_at_four_kilobytes() {
        let long = "e".repeat(9000);
        let records = [
            exec_call("c1", "boom", "2026-05-16T20:53:00.000Z"),
            output("c1", &exec_output(1, &long), "2026-05-16T20:53:01.000Z"),
        ];
        let f = &codex_tool_facts(&records, &ctx())[0];
        assert_eq!(f.error_excerpt.len(), ERROR_EXCERPT_CAP_BYTES);
    }

    #[test]
    fn duration_is_the_call_to_output_gap() {
        let records = [
            exec_call("c1", "ls", "2026-05-16T20:53:00.000Z"),
            output("c1", &exec_output(0, "x"), "2026-05-16T20:53:02.500Z"),
        ];
        let f = &codex_tool_facts(&records, &ctx())[0];
        assert_eq!(f.duration_ms, Some(2500));
    }

    #[test]
    fn block_index_tracks_call_position_and_skips_non_calls() {
        let records = [
            json!({ "type": "response_item", "payload": { "type": "reasoning" } }),
            exec_call("c1", "ls", "2026-05-16T20:53:00.000Z"),
            json!({ "type": "event_msg", "payload": { "type": "token_count" } }),
            exec_call("c2", "pwd", "2026-05-16T20:53:01.000Z"),
        ];
        let facts = codex_tool_facts(&records, &ctx());
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].source_block_index, 0);
        assert_eq!(facts[1].source_block_index, 1);
        assert_eq!(facts[0].event_at, 1_778_964_780_000);
    }

    #[test]
    fn function_call_without_a_call_id_is_skipped() {
        // No `call_id` means no stable identity; emitting a `tool_use_id: None` fact would collide with
        // any other id-less call. The valid call keeps index 0 — the malformed one consumes no position.
        let records = [
            json!({
                "type": "response_item",
                "timestamp": "2026-05-16T20:53:00.000Z",
                "payload": { "type": "function_call", "name": "exec_command", "arguments": "{}" }
            }),
            exec_call("c1", "ls", "2026-05-16T20:53:01.000Z"),
        ];
        let facts = codex_tool_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].tool_use_id.as_deref(), Some("c1"));
        assert_eq!(facts[0].source_block_index, 0);
    }

    #[test]
    fn empty_session_emits_no_facts() {
        assert!(codex_tool_facts(&[], &ctx()).is_empty());
    }
}
