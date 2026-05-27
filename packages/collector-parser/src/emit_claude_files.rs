// SPDX-License-Identifier: MIT
// Adapted from otto-parser/src/parser/claude_code/tools.rs file extractors (Read -> file_extractor,
// Edit/Write -> edit_extractor, MultiEdit -> multi_edit_extractor; all keyed on `input.file_path`)
// (~/src/otto, 2026-05-25). Reworked: otto threaded touched paths through its per-tool extractor map
// and stored otto's loose `~/`-fallback path; Trace Flow emits a standalone unpriced
// `AgentFileEventFact` per file-touching `tool_use` block, relativizes every path against the
// session's repo root (repo-relative or the `outside_repo` sentinel, never a home dir/username), and
// leaves `*_pk` to the ingest Worker. Trace Flow owns the contract, IDs, pricing, redaction, and
// storage around this code.

//! Claude Code `AgentFileEventFact` emission. [`claude_file_facts`] turns each file-touching
//! `tool_use` block (`Read`/`Write`/`Edit`/`MultiEdit`) into one [`AgentFileEventFact`] with a
//! repo-relative path. Identity (`file_event_pk`) hashes
//! `(source, vendor_session_id, vendor_message_id, normalized_repo_path, operation, source_block_index)`,
//! so `source_block_index` must separate two file ops that share a `message.id`, path, and operation
//! (e.g. two `Edit`s of one file in a single assistant turn). Claude writes one content block per
//! JSONL record, all sharing the turn's `message.id`, so a *within-record* block index is always `0`
//! and useless as that separator; instead each block is numbered by its position in the message's full
//! block stream in document order — immutable across re-sync, unique within the message.

use std::collections::HashMap;
use std::path::Path;

use collector_contracts::enums::AgentFileOperation;
use collector_contracts::facts::AgentFileEventFact;
use serde_json::Value;

use crate::paths::relativize_repo_path;
use crate::session_context::SessionContext;
use crate::timestamp::rfc3339_to_epoch_ms;

/// The file operation a `tool_use` block records, or `None` for a block that is not a file touch
/// (`thinking`/`text` blocks, and shell/search/web tools whose paths are derived on the tool event).
/// `MultiEdit` carries one `file_path` plus an `edits` array, so it folds to a single `Edit`.
fn file_operation(block: &Value) -> Option<AgentFileOperation> {
    if block.get("type").and_then(Value::as_str)? != "tool_use" {
        return None;
    }
    match block.get("name").and_then(Value::as_str)? {
        "Read" => Some(AgentFileOperation::Read),
        "Write" => Some(AgentFileOperation::Write),
        "Edit" | "MultiEdit" => Some(AgentFileOperation::Edit),
        _ => None,
    }
}

/// The assistant record's collapse key (`message.id`), or `None` for any record without one. File
/// `tool_use` blocks live only in assistant records, so a record with no id carries no file event.
fn assistant_message_id(record: &Value) -> Option<&str> {
    record.get("message")?.get("id")?.as_str()
}

/// The record's content blocks (`message.content`), or `None` when the record carries none.
fn content_blocks(record: &Value) -> Option<&Vec<Value>> {
    record.get("message")?.get("content")?.as_array()
}

/// The record's `event_at` in epoch ms from its top-level `timestamp`, falling back to the session
/// start when a record omits or malforms it (real Claude records always carry one). Triplicated from
/// [`emit_claude`](crate::emit_claude) and [`emit_codex`](crate::emit_codex) deliberately: hoisting it
/// to a shared module would edit those committed files, outside this task's lane. Future cleanup.
fn record_event_at(record: &Value, ctx: &SessionContext) -> i64 {
    record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(rfc3339_to_epoch_ms)
        .or(ctx.vendor_started_at)
        .unwrap_or(0)
}

/// Emits one [`AgentFileEventFact`] per file-touching `tool_use` block in document order. The path is
/// relativized against `ctx.repo_root`; a path outside the repo (or any path when `repo_root` is empty)
/// collapses to the `outside_repo` sentinel rather than leaking a local path. `source_block_index` is
/// the block's position in its message's full block stream, so two ops of the same kind on the same
/// path within one turn stay distinct rows.
pub fn claude_file_facts(records: &[Value], ctx: &SessionContext) -> Vec<AgentFileEventFact> {
    let repo_root = Path::new(&ctx.repo_root);
    // `message.id -> next logical block index`. The cursor persists across the records that share a
    // `message.id` (Claude splits a turn into one block per record), numbering every block in document
    // order so the file fact's `source_block_index` is unique within the message and stable on re-sync.
    let mut next_block_index: HashMap<&str, i64> = HashMap::new();
    let mut facts = Vec::new();

    for record in records {
        let Some(message_id) = assistant_message_id(record) else {
            continue;
        };
        let Some(blocks) = content_blocks(record) else {
            continue;
        };
        let cursor = next_block_index.entry(message_id).or_insert(0);
        for block in blocks {
            let block_index = *cursor;
            *cursor += 1;
            let Some(operation) = file_operation(block) else {
                continue;
            };
            let Some(path) = block
                .get("input")
                .and_then(|input| input.get("file_path"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            facts.push(AgentFileEventFact {
                vendor_session_id: ctx.vendor_session_id.clone(),
                vendor_message_id: Some(message_id.to_string()),
                source_block_index: block_index,
                normalized_repo_path: relativize_repo_path(repo_root, path),
                operation,
                event_at: record_event_at(record, ctx),
                // File facts carry no free text; the path is normalized, not redacted.
                dropped_sensitive: 0,
            });
        }
    }
    facts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::OUTSIDE_REPO;
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

    fn tool_use(name: &str, file_path: &str) -> Value {
        json!({ "type": "tool_use", "name": name, "input": { "file_path": file_path } })
    }

    fn assistant(id: &str, ts: &str, block: Value) -> Value {
        json!({ "type": "assistant", "timestamp": ts, "message": { "id": id, "content": [block] } })
    }

    #[test]
    fn maps_each_file_tool_to_its_operation() {
        let cases = [
            ("Read", AgentFileOperation::Read),
            ("Write", AgentFileOperation::Write),
            ("Edit", AgentFileOperation::Edit),
            ("MultiEdit", AgentFileOperation::Edit),
        ];
        for (tool, op) in cases {
            let records = [assistant(
                "msg_1",
                "2026-05-27T12:00:00Z",
                tool_use(tool, "/work/trace-flow/src/main.rs"),
            )];
            let facts = claude_file_facts(&records, &ctx());
            assert_eq!(facts.len(), 1, "{tool} should emit one fact");
            assert_eq!(facts[0].operation, op);
            assert_eq!(facts[0].normalized_repo_path, "src/main.rs");
            assert_eq!(facts[0].vendor_message_id.as_deref(), Some("msg_1"));
        }
    }

    #[test]
    fn non_file_tools_and_non_tool_blocks_emit_nothing() {
        let records = [
            assistant(
                "msg_1",
                "2026-05-27T12:00:00Z",
                tool_use("Bash", "/work/trace-flow/x"),
            ),
            assistant(
                "msg_2",
                "2026-05-27T12:00:01Z",
                json!({ "type": "tool_use", "name": "Grep", "input": { "pattern": "foo" } }),
            ),
            assistant(
                "msg_3",
                "2026-05-27T12:00:02Z",
                json!({ "type": "thinking", "thinking": "..." }),
            ),
        ];
        assert!(claude_file_facts(&records, &ctx()).is_empty());
    }

    #[test]
    fn user_tool_result_records_emit_nothing() {
        let records = [json!({
            "type": "user",
            "timestamp": "2026-05-27T12:00:00Z",
            "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1" }] }
        })];
        assert!(claude_file_facts(&records, &ctx()).is_empty());
    }

    #[test]
    fn block_without_file_path_is_skipped() {
        let records = [assistant(
            "msg_1",
            "2026-05-27T12:00:00Z",
            json!({ "type": "tool_use", "name": "Edit", "input": { "old_string": "a" } }),
        )];
        assert!(claude_file_facts(&records, &ctx()).is_empty());
    }

    #[test]
    fn two_edits_of_same_path_in_one_message_stay_distinct() {
        // Claude writes one block per record; both records share the turn's message.id. Without a
        // logical block index both would hash to the same file_event_pk and collapse to one row.
        let records = [
            assistant(
                "msg_1",
                "2026-05-27T12:00:00Z",
                tool_use("Edit", "/work/trace-flow/a.rs"),
            ),
            assistant(
                "msg_1",
                "2026-05-27T12:00:01Z",
                tool_use("Edit", "/work/trace-flow/a.rs"),
            ),
        ];
        let facts = claude_file_facts(&records, &ctx());
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].source_block_index, 0);
        assert_eq!(facts[1].source_block_index, 1);
        assert_ne!(facts[0].source_block_index, facts[1].source_block_index);
    }

    #[test]
    fn block_index_resets_across_distinct_messages() {
        let records = [
            assistant(
                "msg_1",
                "2026-05-27T12:00:00Z",
                tool_use("Read", "/work/trace-flow/a.rs"),
            ),
            assistant(
                "msg_2",
                "2026-05-27T12:00:01Z",
                tool_use("Read", "/work/trace-flow/b.rs"),
            ),
        ];
        let facts = claude_file_facts(&records, &ctx());
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].source_block_index, 0);
        assert_eq!(facts[1].source_block_index, 0);
    }

    #[test]
    fn non_file_blocks_still_advance_the_block_cursor() {
        // A thinking block precedes the edit in the same message, so the edit is logical block 1.
        let records = [
            assistant(
                "msg_1",
                "2026-05-27T12:00:00Z",
                json!({ "type": "thinking", "thinking": "plan" }),
            ),
            assistant(
                "msg_1",
                "2026-05-27T12:00:01Z",
                tool_use("Edit", "/work/trace-flow/a.rs"),
            ),
        ];
        let facts = claude_file_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].source_block_index, 1);
    }

    #[test]
    fn path_outside_repo_collapses_to_sentinel() {
        let records = [assistant(
            "msg_1",
            "2026-05-27T12:00:00Z",
            tool_use("Read", "/Users/janedoe/secrets/.env"),
        )];
        let facts = claude_file_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].normalized_repo_path, OUTSIDE_REPO);
        assert!(!facts[0].normalized_repo_path.contains("janedoe"));
    }

    #[test]
    fn empty_repo_root_collapses_every_absolute_path() {
        let mut c = ctx();
        c.repo_root = String::new();
        let records = [assistant(
            "msg_1",
            "2026-05-27T12:00:00Z",
            tool_use("Read", "/work/trace-flow/src/main.rs"),
        )];
        let facts = claude_file_facts(&records, &c);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].normalized_repo_path, OUTSIDE_REPO);
    }

    #[test]
    fn event_at_comes_from_the_record_timestamp() {
        let records = [assistant(
            "msg_1",
            "2026-05-27T12:00:00Z",
            tool_use("Read", "/work/trace-flow/src/main.rs"),
        )];
        let facts = claude_file_facts(&records, &ctx());
        assert_eq!(facts[0].event_at, 1_779_883_200_000);
        assert_eq!(facts[0].dropped_sensitive, 0);
    }

    #[test]
    fn missing_timestamp_falls_back_to_session_start() {
        let records = [json!({
            "type": "assistant",
            "message": { "id": "msg_1", "content": [tool_use("Read", "/work/trace-flow/a.rs")] }
        })];
        let facts = claude_file_facts(&records, &ctx());
        assert_eq!(facts[0].event_at, 1_778_964_000_000);
    }
}
