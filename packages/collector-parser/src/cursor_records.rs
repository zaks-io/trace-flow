// SPDX-License-Identifier: MIT
// Original Trace Flow code. The one place that knows the shape of a Cursor `bubbleId:` record, so the
// four Cursor emitters read it through named accessors instead of each re-deriving the `cursorDiskKV`
// JSON layout. Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Cursor bubble-record accessors.
//!
//! The `collector-sync` reader normalizes one `bubbleId:` row into one [`Value`] per message: the raw
//! bubble JSON, with the session's `composerData:` id stamped on as `__composer_id` and the session-grain
//! model copied on as `__model` (the bubble itself carries neither — the composer key holds the id and
//! `modelConfig.modelName` holds the model). This module is the single reader of that shape, so the
//! emitters depend on field names like `tokenCount.inputTokens` or `toolFormerData.params.targetFile` in
//! exactly one place; a Cursor schema drift is a change here, not in five files.
//!
//! Everything is best-effort: a missing or wrongly-typed field yields `None`/empty, never a panic, so a
//! schema change degrades coverage instead of dropping a session.

use serde_json::Value;

/// Cursor bubble `type`: `1` is a user turn, `2` is an assistant turn. Any other value is unknown.
pub const BUBBLE_TYPE_USER: i64 = 1;
pub const BUBBLE_TYPE_ASSISTANT: i64 = 2;

/// The reader-injected session id (`__composer_id`) — the `composerData:` id this bubble belongs to.
pub fn composer_id(record: &Value) -> Option<&str> {
    record.get("__composer_id").and_then(Value::as_str)
}

/// The reader-injected session-grain model (`__model`, the composer's `modelConfig.modelName`). Cursor
/// records no per-bubble model, so this one value tags every message of the session.
pub fn bubble_model(record: &Value) -> Option<&str> {
    record.get("__model").and_then(Value::as_str)
}

/// The bubble's own stable id (`bubbleId`) — the per-message vendor id the ingest Worker keys on.
pub fn bubble_id(record: &Value) -> Option<&str> {
    record.get("bubbleId").and_then(Value::as_str)
}

/// The bubble's `type` discriminator (`1` user / `2` assistant), or `None` when absent/non-numeric.
pub fn bubble_type(record: &Value) -> Option<i64> {
    record.get("type").and_then(Value::as_i64)
}

/// The bubble's assistant/user text body, or `None` when it has none.
pub fn bubble_text(record: &Value) -> Option<&str> {
    record
        .get("text")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
}

/// `(input_tokens, output_tokens)` from the bubble's `tokenCount`, or `None` when the bubble carries no
/// token count at all. Cursor populates `tokenCount` on only ~1% of bubbles; the rest have none, which
/// the message emitter classifies as `Missing` coverage.
pub fn bubble_tokens(record: &Value) -> Option<(i64, i64)> {
    let tc = record.get("tokenCount")?;
    let input = tc.get("inputTokens").and_then(Value::as_i64).unwrap_or(0);
    let output = tc.get("outputTokens").and_then(Value::as_i64).unwrap_or(0);
    Some((input, output))
}

/// One tool invocation pulled from a bubble's `toolFormerData`. `params`/`rawArgs` are JSON-encoded
/// strings in the store; the structured pieces the emitters need (`target_file`, `command`) are parsed
/// out here so each emitter reads a flat struct, never the nested store shape.
pub struct ToolBlock<'a> {
    /// `toolFormerData.name` (e.g. `read_file_v2`, `run_terminal_command_v2`), or `""`.
    pub name: &'a str,
    /// `toolFormerData.toolCallId` — the stable per-call id, or `None` (then the emitter falls back to a
    /// positional index, like the Codex no-call-id path).
    pub tool_call_id: Option<&'a str>,
    /// `toolFormerData.status`: `completed` / `error` / `cancelled` / `loading` / `""`.
    pub status: &'a str,
    /// The absolute file path a file tool targeted (`params.targetFile` or `.effectiveUri`), or `None`.
    pub target_file: Option<String>,
    /// The shell command a terminal tool ran (`params.command`), or `None`.
    pub command: Option<String>,
    /// The tool's raw result text, when present — diagnostic output for a failed call.
    pub result: Option<&'a str>,
}

/// `params` (a JSON-encoded string) parsed back to a `Value`, or `Null` when absent / not valid JSON.
fn parse_params(tool: &Value) -> Value {
    tool.get("params")
        .and_then(Value::as_str)
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .unwrap_or(Value::Null)
}

/// The single tool invocation on a bubble (`toolFormerData`), or `None` when the bubble ran no tool.
pub fn tool_block(record: &Value) -> Option<ToolBlock<'_>> {
    let tool = record.get("toolFormerData")?;
    if !tool.is_object() {
        return None;
    }
    let params = parse_params(tool);
    let target_file = params
        .get("targetFile")
        .or_else(|| params.get("effectiveUri"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let command = params
        .get("command")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(ToolBlock {
        name: tool.get("name").and_then(Value::as_str).unwrap_or_default(),
        tool_call_id: tool.get("toolCallId").and_then(Value::as_str),
        status: tool
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        target_file,
        command,
        result: tool.get("result").and_then(Value::as_str),
    })
}

/// Every tool block on a bubble, as a 0-or-1 iterator (a bubble carries at most one `toolFormerData`).
/// Returning an iterator keeps the call sites uniform with the multi-block JSONL emitters.
pub fn tool_blocks(record: &Value) -> impl Iterator<Item = ToolBlock<'_>> {
    tool_block(record).into_iter()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    /// Build a reader-normalized bubble record: the raw bubble `extra` JSON, plus the `__composer_id` /
    /// `__model` the reader injects and the `type`/`bubbleId`/`createdAt` every bubble carries.
    pub(crate) fn bubble(composer: &str, model: &str, bubble_type: i64, extra: Value) -> Value {
        let mut record = json!({
            "__composer_id": composer,
            "__model": model,
            "type": bubble_type,
            "bubbleId": "bub-1",
            "createdAt": "2026-05-25T23:37:23.355Z",
        });
        if let (Value::Object(base), Value::Object(more)) = (&mut record, extra) {
            for (k, v) in more {
                base.insert(k, v);
            }
        }
        record
    }

    /// Stamp a reader-injected `__started_at` (the composer's `createdAt`) onto a record.
    pub(crate) fn with_started_at(mut record: Value, started_at: i64) -> Value {
        if let Value::Object(map) = &mut record {
            map.insert("__started_at".to_string(), json!(started_at));
        }
        record
    }

    #[test]
    fn reads_injected_session_fields() {
        let r = bubble("comp-9", "gpt-5.2", BUBBLE_TYPE_ASSISTANT, json!({}));
        assert_eq!(composer_id(&r), Some("comp-9"));
        assert_eq!(bubble_model(&r), Some("gpt-5.2"));
        assert_eq!(bubble_type(&r), Some(BUBBLE_TYPE_ASSISTANT));
        assert_eq!(bubble_id(&r), Some("bub-1"));
    }

    #[test]
    fn token_count_is_none_when_absent_and_partial_when_present() {
        let none = bubble("c", "m", 2, json!({}));
        assert_eq!(bubble_tokens(&none), None);
        let some = bubble(
            "c",
            "m",
            2,
            json!({ "tokenCount": { "inputTokens": 26069, "outputTokens": 911 } }),
        );
        assert_eq!(bubble_tokens(&some), Some((26069, 911)));
    }

    #[test]
    fn tool_block_parses_a_file_targets_params_json_string() {
        let r = bubble(
            "c",
            "m",
            2,
            json!({ "toolFormerData": {
                "name": "read_file_v2",
                "toolCallId": "call-7",
                "status": "completed",
                "params": "{\"targetFile\":\"/work/repo/src/a.rs\",\"effectiveUri\":\"/work/repo/src/a.rs\"}",
            } }),
        );
        let block = tool_block(&r).unwrap();
        assert_eq!(block.name, "read_file_v2");
        assert_eq!(block.tool_call_id, Some("call-7"));
        assert_eq!(block.status, "completed");
        assert_eq!(block.target_file.as_deref(), Some("/work/repo/src/a.rs"));
    }

    #[test]
    fn tool_block_parses_a_terminal_command() {
        let r = bubble(
            "c",
            "m",
            2,
            json!({ "toolFormerData": {
                "name": "run_terminal_command_v2",
                "status": "completed",
                "params": "{\"command\":\"git push origin HEAD\"}",
            } }),
        );
        let block = tool_block(&r).unwrap();
        assert_eq!(block.command.as_deref(), Some("git push origin HEAD"));
        assert_eq!(block.target_file, None);
    }

    #[test]
    fn no_tool_data_yields_no_block() {
        assert!(tool_block(&bubble("c", "m", 1, json!({}))).is_none());
    }
}
