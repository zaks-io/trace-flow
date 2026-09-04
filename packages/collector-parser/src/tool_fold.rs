// SPDX-License-Identifier: Apache-2.0
// Adapted from otto-parser/src/parser/claude_code/{mod.rs,tools.rs} (~/src/otto, 2026-05-25).
// Reworked: otto emits a separate fact for the tool_use block and again for the tool_result block;
// Trace Flow folds the two (same tool_use_id) into ONE Tool Event, as the ADR requires, so a call and
// its outcome are a single row. The cross-record join is the hard part — the tool_use block lives in an
// assistant record while its tool_result block and the Claude-Code `toolUseResult` sidecar (duration,
// interrupted, stderr) live in a later user record — so this resolves results first, then walks
// tool_use blocks in document order. Command classification, path relativization, redaction, excerpt
// truncation, and the epoch timestamp stay with the downstream emitter; this module only pairs and
// derives the outcome.
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Claude Code tool-call folding. `fold_tool_events` pairs each `tool_use` block with its matching
//! `tool_result` block (by `tool_use_id`) and that result record's `toolUseResult` sidecar into one
//! [`FoldedToolEvent`] per call — the pre-emitter shape of an `AgentToolEventFact`.

use std::collections::HashMap;

use serde_json::Value;

/// The derived outcome of a tool call. Maps onto the contract's `AgentEventStatus` at emit time.
///
/// `Unknown` is the honest state when the outcome was never observed: a `tool_use` with no matching
/// `tool_result` (the session ended mid-call) or an interrupted call (the user aborted it), neither of
/// which is a success or a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolOutcome {
    Success,
    Failure,
    Unknown,
}

/// One folded tool call: the `tool_use` side (name, command, position) joined with its resolved result
/// (outcome, duration, error text). Text fields are raw — the emitter redacts, truncates, and
/// classifies. `command` is `Some` only for shell-style tools that carry `input.command`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoldedToolEvent {
    pub tool_use_id: String,
    pub tool_name: String,
    pub source_block_index: i64,
    pub command: Option<String>,
    pub outcome: ToolOutcome,
    pub duration_ms: Option<i64>,
    pub error_text: Option<String>,
}

/// The result side of a call, resolved from the `tool_result` block plus its record's `toolUseResult`
/// sidecar.
struct ResultInfo {
    is_error: bool,
    interrupted: bool,
    duration_ms: Option<i64>,
    error_text: Option<String>,
}

fn content_blocks(record: &Value) -> Option<&Vec<Value>> {
    record.get("message")?.get("content")?.as_array()
}

fn trim_non_empty(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Stringifies a `tool_result` block's `content`, which Claude writes either as a plain string or as an
/// array of `{type:"text", text}` parts.
fn result_content_text(block: &Value) -> Option<String> {
    match block.get("content") {
        Some(Value::String(s)) => trim_non_empty(s),
        Some(Value::Array(parts)) => {
            let joined = parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            trim_non_empty(&joined)
        }
        _ => None,
    }
}

/// Resolves every `tool_result` in the session to its [`ResultInfo`], keyed by `tool_use_id`. The
/// `toolUseResult` sidecar shares the result block's record, so it is read per record.
fn resolve_results<'a, I>(records: I) -> HashMap<String, ResultInfo>
where
    I: IntoIterator<Item = &'a Value>,
{
    let mut results = HashMap::new();
    for record in records {
        let Some(blocks) = content_blocks(record) else {
            continue;
        };
        let sidecar = record.get("toolUseResult").filter(|v| v.is_object());
        let interrupted = sidecar
            .and_then(|s| s.get("interrupted"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let duration_ms = sidecar
            .and_then(|s| s.get("durationMs"))
            .and_then(Value::as_i64);
        let stderr = sidecar
            .and_then(|s| s.get("stderr"))
            .and_then(Value::as_str)
            .and_then(trim_non_empty);
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
                continue;
            };
            let is_error = block
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            // Prefer the structured stderr; fall back to the result body only when the call errored.
            let error_text = stderr.clone().or_else(|| {
                if is_error {
                    result_content_text(block)
                } else {
                    None
                }
            });
            results.insert(
                id.to_string(),
                ResultInfo {
                    is_error,
                    interrupted,
                    duration_ms,
                    error_text,
                },
            );
        }
    }
    results
}

/// Folds a session's JSONL records into one [`FoldedToolEvent`] per `tool_use` block, in document
/// order. Each call's outcome is resolved from its matching `tool_result`: a call the user interrupted
/// or one with no result at all is [`ToolOutcome::Unknown`]; an `is_error` result is
/// [`ToolOutcome::Failure`]; otherwise [`ToolOutcome::Success`].
pub fn fold_tool_events<'a, I>(records: I) -> Vec<FoldedToolEvent>
where
    I: IntoIterator<Item = &'a Value> + Clone,
{
    let results = resolve_results(records.clone());
    let mut events = Vec::new();
    for record in records {
        let Some(blocks) = content_blocks(record) else {
            continue;
        };
        for (index, block) in blocks.iter().enumerate() {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let Some(id) = block.get("id").and_then(Value::as_str) else {
                continue;
            };
            let tool_name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let command = block
                .get("input")
                .and_then(|i| i.get("command"))
                .and_then(Value::as_str)
                .and_then(trim_non_empty);
            let result = results.get(id);
            let outcome = match result {
                None => ToolOutcome::Unknown,
                Some(r) if r.interrupted => ToolOutcome::Unknown,
                Some(r) if r.is_error => ToolOutcome::Failure,
                Some(_) => ToolOutcome::Success,
            };
            events.push(FoldedToolEvent {
                tool_use_id: id.to_string(),
                tool_name,
                source_block_index: index as i64,
                command,
                outcome,
                duration_ms: result.and_then(|r| r.duration_ms),
                error_text: result.and_then(|r| r.error_text.clone()),
            });
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool_use(id: &str, name: &str, command: Option<&str>) -> Value {
        let mut block = json!({ "type": "tool_use", "id": id, "name": name, "input": {} });
        if let Some(cmd) = command {
            block["input"] = json!({ "command": cmd });
        }
        json!({ "type": "assistant", "message": { "content": [block] } })
    }

    /// A user record carrying a tool_result block and the co-located `toolUseResult` sidecar.
    fn tool_result(id: &str, is_error: bool, sidecar: Value) -> Value {
        json!({
            "type": "user",
            "message": { "content": [{
                "type": "tool_result",
                "tool_use_id": id,
                "is_error": is_error,
                "content": "ok",
            }] },
            "toolUseResult": sidecar,
        })
    }

    #[test]
    fn folds_a_use_and_result_into_one_success_event() {
        let records = [
            tool_use("toolu_1", "Bash", Some("git status")),
            tool_result(
                "toolu_1",
                false,
                json!({ "stdout": "clean", "interrupted": false }),
            ),
        ];
        let events = fold_tool_events(records.iter());
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.tool_use_id, "toolu_1");
        assert_eq!(e.tool_name, "Bash");
        assert_eq!(e.command.as_deref(), Some("git status"));
        assert_eq!(e.outcome, ToolOutcome::Success);
        assert_eq!(e.source_block_index, 0);
    }

    #[test]
    fn an_is_error_result_is_a_failure_and_keeps_stderr() {
        let records = [
            tool_use("toolu_2", "Bash", Some("false")),
            tool_result(
                "toolu_2",
                true,
                json!({ "stderr": "command failed", "interrupted": false }),
            ),
        ];
        let e = &fold_tool_events(records.iter())[0];
        assert_eq!(e.outcome, ToolOutcome::Failure);
        assert_eq!(e.error_text.as_deref(), Some("command failed"));
    }

    #[test]
    fn an_interrupted_call_is_unknown_not_failure() {
        let records = [
            tool_use("toolu_3", "Bash", Some("sleep 999")),
            tool_result(
                "toolu_3",
                false,
                json!({ "interrupted": true, "stderr": "" }),
            ),
        ];
        assert_eq!(
            fold_tool_events(records.iter())[0].outcome,
            ToolOutcome::Unknown
        );
    }

    #[test]
    fn a_dangling_tool_use_with_no_result_is_unknown() {
        // Session ended after the call was issued but before its result was written.
        let records = [tool_use("toolu_4", "Bash", Some("git push"))];
        let e = &fold_tool_events(records.iter())[0];
        assert_eq!(e.outcome, ToolOutcome::Unknown);
        assert_eq!(e.duration_ms, None);
        assert_eq!(e.error_text, None);
    }

    #[test]
    fn captures_duration_from_the_sidecar() {
        let records = [
            tool_use("toolu_5", "Read", None),
            tool_result(
                "toolu_5",
                false,
                json!({ "durationMs": 42, "numFiles": 1, "interrupted": false }),
            ),
        ];
        let e = &fold_tool_events(records.iter())[0];
        assert_eq!(e.duration_ms, Some(42));
        assert_eq!(e.command, None); // Read carries no input.command
        assert_eq!(e.tool_name, "Read");
    }

    #[test]
    fn falls_back_to_result_body_for_error_text_when_no_stderr() {
        let records = [
            tool_use("toolu_6", "Bash", Some("nope")),
            json!({
                "type": "user",
                "message": { "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_6",
                    "is_error": true,
                    "content": "boom: not found",
                }] },
                "toolUseResult": { "interrupted": false },
            }),
        ];
        let e = &fold_tool_events(records.iter())[0];
        assert_eq!(e.outcome, ToolOutcome::Failure);
        assert_eq!(e.error_text.as_deref(), Some("boom: not found"));
    }

    #[test]
    fn joins_text_array_result_content() {
        let records = [
            tool_use("toolu_7", "Bash", Some("oops")),
            json!({
                "type": "user",
                "message": { "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_7",
                    "is_error": true,
                    "content": [{ "type": "text", "text": "line one" }, { "type": "text", "text": "line two" }],
                }] },
                "toolUseResult": { "interrupted": false },
            }),
        ];
        assert_eq!(
            fold_tool_events(records.iter())[0].error_text.as_deref(),
            Some("line one\nline two")
        );
    }

    #[test]
    fn preserves_document_order_and_block_index_across_records() {
        let records = [
            json!({ "type": "assistant", "message": { "content": [
                { "type": "text", "text": "running two tools" },
                { "type": "tool_use", "id": "toolu_a", "name": "Bash", "input": { "command": "a" } },
                { "type": "tool_use", "id": "toolu_b", "name": "Bash", "input": { "command": "b" } },
            ] } }),
            tool_result("toolu_a", false, json!({ "interrupted": false })),
            tool_result("toolu_b", false, json!({ "interrupted": false })),
        ];
        let events = fold_tool_events(records.iter());
        let ids: Vec<_> = events.iter().map(|e| e.tool_use_id.as_str()).collect();
        assert_eq!(ids, ["toolu_a", "toolu_b"]);
        // Block indices reflect position within the message content array (text block at 0).
        assert_eq!(events[0].source_block_index, 1);
        assert_eq!(events[1].source_block_index, 2);
    }

    #[test]
    fn empty_session_yields_no_events() {
        assert!(fold_tool_events([].iter()).is_empty());
    }
}
