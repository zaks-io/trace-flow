// SPDX-License-Identifier: Apache-2.0
// Adapted from otto-parser/src/parser/codex_cli/blocks.rs `extract_patch_files` + the apply_patch arm
// of `codex_tool_use` (~/src/otto, 2026-05-25). Reworked: otto attached touched paths to its normalized
// tool event; Trace Flow emits a standalone unpriced `AgentFileEventFact` per file the patch touches,
// carries the per-file operation (Add/Update/Delete), relativizes every path against the session's repo
// root (repo-relative or the `outside_repo` sentinel, never a home dir/username), and leaves `*_pk` to
// the ingest Worker. Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Codex CLI `AgentFileEventFact` emission. [`codex_file_facts`] turns each `apply_patch` function call
//! into one [`AgentFileEventFact`] per file the patch touches, mapping the patch verb to an operation
//! (`Add File:` → `Create`, `Update File:` → `Edit`, `Delete File:` → `Delete`). The touched paths come
//! from the `*** <verb> File: <path>` markers in the patch text (`arguments.input`); Codex paths are
//! already repo-relative, and [`relativize_repo_path`] keeps a clean one while collapsing anything that
//! climbs out or carries a home marker to [`OUTSIDE_REPO`](crate::paths::OUTSIDE_REPO).
//!
//! Scope: `apply_patch` only. Codex *can* also mutate files through raw `exec_command` shell text
//! (`cat > f`, `sed -i`, …), but parsing file paths out of arbitrary shell is fragile and explicitly
//! deferred (see the tool emitter), so those are captured as tool events, not file events. Unlike
//! Claude, Codex emits no per-message vendor ID, so `vendor_message_id` is `None` on every file fact and
//! `source_block_index` is a session-global document-order counter — the only field left to keep two
//! events with the same path and operation (two files in one patch, or the same file across two patches)
//! distinct under `file_event_pk`. It is stable across a re-parse of the same session.

use std::path::Path;
use std::sync::LazyLock;

use collector_contracts::enums::AgentFileOperation;
use collector_contracts::facts::AgentFileEventFact;
use regex::Regex;
use serde_json::Value;

use crate::paths::relativize_repo_path;
use crate::session_context::SessionContext;
use crate::timestamp::rfc3339_to_epoch_ms;

/// The `*** Add|Update|Delete File: <path>` markers an apply_patch body carries, one per touched file.
/// Anchored per line (multiline) so the surrounding `*** Begin Patch` / hunk / `+`/`-` lines are
/// ignored. Capture 1 is the verb, capture 2 the path.
static PATCH_FILE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\*\*\* (Add|Update|Delete) File: (.+)$").expect("patch file pattern")
});

/// The record's `payload.type`, or `None`.
fn payload_type(record: &Value) -> Option<&str> {
    record.get("payload")?.get("type")?.as_str()
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

/// The patch text from an `apply_patch` call's `arguments`. Codex encodes it as `{"input": "<patch>"}`;
/// the other arms tolerate a bare JSON string, or raw (non-JSON) arguments that are themselves the
/// patch. A JSON object without an `input` string yields `None` (an unknown shape degrades to no files).
fn apply_patch_text(record: &Value) -> Option<String> {
    let raw = record.get("payload")?.get("arguments")?.as_str()?;
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => map.get("input").and_then(Value::as_str).map(str::to_string),
        Ok(Value::String(text)) => Some(text),
        Ok(_) => None,
        Err(_) => Some(raw.to_string()),
    }
}

/// The `(operation, path)` of every file marker in a patch body, in document order.
fn patch_files(patch: &str) -> Vec<(AgentFileOperation, String)> {
    PATCH_FILE_PATTERN
        .captures_iter(patch)
        .filter_map(|caps| {
            let operation = match caps.get(1)?.as_str() {
                "Add" => AgentFileOperation::Create,
                "Update" => AgentFileOperation::Edit,
                "Delete" => AgentFileOperation::Delete,
                _ => return None,
            };
            let path = caps.get(2)?.as_str().trim();
            (!path.is_empty()).then(|| (operation, path.to_string()))
        })
        .collect()
}

/// Emits one [`AgentFileEventFact`] per file touched by an `apply_patch` call, in document order. Each
/// path is relativized against `ctx.repo_root` (repo-relative or the `outside_repo` sentinel, never a
/// home dir/username). `source_block_index` is a session-global counter, so two ops of the same kind on
/// the same path stay distinct rows even though Codex file facts share an empty `vendor_message_id`.
pub fn codex_file_facts(records: &[Value], ctx: &SessionContext) -> Vec<AgentFileEventFact> {
    let repo_root = Path::new(&ctx.repo_root);
    let mut block_index = 0i64;
    let mut facts = Vec::new();

    for record in records {
        if payload_type(record) != Some("function_call") {
            continue;
        }
        if record
            .get("payload")
            .and_then(|p| p.get("name"))
            .and_then(Value::as_str)
            != Some("apply_patch")
        {
            continue;
        }
        let Some(patch) = apply_patch_text(record) else {
            continue;
        };
        let event_at = record_event_at(record, ctx);
        for (operation, raw_path) in patch_files(&patch) {
            facts.push(AgentFileEventFact {
                vendor_session_id: ctx.vendor_session_id.clone(),
                // Codex emits no per-message vendor ID; identity rides path + operation + block index.
                vendor_message_id: None,
                source_block_index: block_index,
                normalized_repo_path: relativize_repo_path(repo_root, &raw_path),
                operation,
                event_at,
                // File facts carry no free text; the path is normalized, not redacted.
                dropped_sensitive: 0,
            });
            block_index += 1;
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
            vendor_session_id: "codex-sess-1".to_string(),
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

    /// An apply_patch call whose `arguments` is the canonical `{"input": "<patch>"}` JSON string.
    fn apply_patch(patch: &str, ts: &str) -> Value {
        let arguments = serde_json::to_string(&json!({ "input": patch })).unwrap();
        json!({
            "type": "response_item",
            "timestamp": ts,
            "payload": { "type": "function_call", "name": "apply_patch", "arguments": arguments, "call_id": "c1" }
        })
    }

    #[test]
    fn maps_each_patch_verb_to_its_operation() {
        let patch = "*** Begin Patch\n*** Add File: src/new.rs\n+fn a() {}\n*** Update File: src/lib.rs\n@@\n-old\n+new\n*** Delete File: src/old.rs\n*** End Patch\n";
        let facts = codex_file_facts(&[apply_patch(patch, "2026-05-16T20:53:00.000Z")], &ctx());
        let shape: Vec<_> = facts
            .iter()
            .map(|f| (f.operation, f.normalized_repo_path.as_str()))
            .collect();
        assert_eq!(
            shape,
            [
                (AgentFileOperation::Create, "src/new.rs"),
                (AgentFileOperation::Edit, "src/lib.rs"),
                (AgentFileOperation::Delete, "src/old.rs"),
            ]
        );
    }

    #[test]
    fn each_touched_file_gets_a_distinct_block_index() {
        let patch = "*** Add File: a.rs\n*** Add File: b.rs\n*** Add File: c.rs\n";
        let facts = codex_file_facts(&[apply_patch(patch, "2026-05-16T20:53:00.000Z")], &ctx());
        let idx: Vec<_> = facts.iter().map(|f| f.source_block_index).collect();
        assert_eq!(idx, [0, 1, 2]);
    }

    #[test]
    fn same_path_and_op_across_two_patches_stay_distinct() {
        // Codex file facts share an empty vendor_message_id, so only the session-global block index
        // keeps two Updates of one file from colliding under file_event_pk.
        let records = [
            apply_patch(
                "*** Update File: src/auth.rs\n@@\n-x\n+y\n",
                "2026-05-16T20:53:00.000Z",
            ),
            apply_patch(
                "*** Update File: src/auth.rs\n@@\n-y\n+z\n",
                "2026-05-16T20:54:00.000Z",
            ),
        ];
        let facts = codex_file_facts(&records, &ctx());
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].source_block_index, 0);
        assert_eq!(facts[1].source_block_index, 1);
        assert_ne!(facts[0].source_block_index, facts[1].source_block_index);
        assert_eq!(facts[0].vendor_message_id, None);
    }

    #[test]
    fn path_outside_repo_collapses_to_sentinel() {
        let patch = "*** Update File: ../other-repo/secrets.rs\n";
        let f = &codex_file_facts(&[apply_patch(patch, "2026-05-16T20:53:00.000Z")], &ctx())[0];
        assert_eq!(f.normalized_repo_path, OUTSIDE_REPO);
    }

    #[test]
    fn absolute_home_path_does_not_leak() {
        let patch = "*** Update File: /Users/janedoe/secrets/.env\n";
        let f = &codex_file_facts(&[apply_patch(patch, "2026-05-16T20:53:00.000Z")], &ctx())[0];
        assert_eq!(f.normalized_repo_path, OUTSIDE_REPO);
        assert!(!f.normalized_repo_path.contains("janedoe"));
    }

    #[test]
    fn bare_string_arguments_are_treated_as_the_patch() {
        // Some apply_patch variants pass the patch as a bare JSON string rather than {"input": ...}.
        let arguments = serde_json::to_string("*** Add File: src/x.rs\n+y\n").unwrap();
        let record = json!({
            "type": "response_item",
            "timestamp": "2026-05-16T20:53:00.000Z",
            "payload": { "type": "function_call", "name": "apply_patch", "arguments": arguments, "call_id": "c1" }
        });
        let f = &codex_file_facts(&[record], &ctx())[0];
        assert_eq!(f.operation, AgentFileOperation::Create);
        assert_eq!(f.normalized_repo_path, "src/x.rs");
    }

    #[test]
    fn non_json_arguments_fall_back_to_raw_patch_text() {
        let record = json!({
            "type": "response_item",
            "timestamp": "2026-05-16T20:53:00.000Z",
            "payload": {
                "type": "function_call",
                "name": "apply_patch",
                "arguments": "*** Update File: src/raw.rs\n@@\n-a\n+b\n",
                "call_id": "c1"
            }
        });
        let f = &codex_file_facts(&[record], &ctx())[0];
        assert_eq!(f.operation, AgentFileOperation::Edit);
        assert_eq!(f.normalized_repo_path, "src/raw.rs");
    }

    #[test]
    fn exec_command_and_other_calls_emit_no_file_facts() {
        let exec = json!({
            "type": "response_item",
            "timestamp": "2026-05-16T20:53:00.000Z",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"sed -i s/a/b/ src/main.rs\"}",
                "call_id": "c1"
            }
        });
        assert!(codex_file_facts(&[exec], &ctx()).is_empty());
    }

    #[test]
    fn event_at_comes_from_the_record_timestamp() {
        let f = &codex_file_facts(
            &[apply_patch(
                "*** Add File: a.rs\n",
                "2026-05-16T20:53:00.000Z",
            )],
            &ctx(),
        )[0];
        assert_eq!(f.event_at, 1_778_964_780_000);
        assert_eq!(f.dropped_sensitive, 0);
    }

    #[test]
    fn apply_patch_with_no_file_markers_emits_nothing() {
        let f = codex_file_facts(
            &[apply_patch(
                "*** Begin Patch\n*** End Patch\n",
                "2026-05-16T20:53:00.000Z",
            )],
            &ctx(),
        );
        assert!(f.is_empty());
    }

    #[test]
    fn empty_session_emits_no_facts() {
        assert!(codex_file_facts(&[], &ctx()).is_empty());
    }
}
