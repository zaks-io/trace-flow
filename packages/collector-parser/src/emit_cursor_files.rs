// SPDX-License-Identifier: Apache-2.0
// Original Trace Flow code. One unpriced `AgentFileEventFact` per Cursor file-tool call, with the
// touched path relativized against the session's repo root (repo-relative or the `outside_repo`
// sentinel, never a home dir/username). Trace Flow owns the contract, IDs, pricing, redaction, and
// storage around this code.

//! Cursor `AgentFileEventFact` emission. [`cursor_file_facts`] turns each file-touching `toolFormerData`
//! block into one [`AgentFileEventFact`]. Cursor names the file operation by the *tool*, not a patch verb
//! (`read_file_v2` → `Read`, `edit_file_v2` / `search_replace` → `Edit`, `create_file` → `Create`,
//! `delete_file` → `Delete`), and carries the path in the tool's `params.targetFile` / `effectiveUri`.
//! `targetFile` and `effectiveUri` paths are absolute (`/Users/<name>/…`), while newer Cursor records
//! some paths as repo-relative `relativeWorkspacePath`. Every path passes through
//! [`relativize_repo_path`]. An absolute path with no usable session repo root collapses to
//! [`OUTSIDE_REPO`](crate::paths::OUTSIDE_REPO), while a safe relative path stays relative. A tool with
//! no touched path (a terminal command, a search) emits no file fact; tool events still capture it.

use std::path::Path;

use collector_contracts::enums::AgentFileOperation;
use collector_contracts::facts::AgentFileEventFact;
use serde_json::Value;

use crate::cursor_records::{bubble_id, composer_id, tool_block};
use crate::paths::relativize_repo_path;
use crate::session_context::SessionContext;
use crate::timestamp::rfc3339_to_epoch_ms;

/// The file operation a Cursor tool denotes, or `None` for a tool that touches no file (terminal,
/// search, web, …). Cursor versions its tools (`_v2` suffixes) and uses a few names for one operation,
/// so the match keys on a contained verb rather than an exact name — `search_replace` and `edit_file_v2`
/// both edit, `read_file` and `read_file_v2` both read.
fn file_operation(tool_name: &str) -> Option<AgentFileOperation> {
    let name = tool_name.to_ascii_lowercase();
    if name.contains("delete") {
        Some(AgentFileOperation::Delete)
    } else if name.contains("create") || name.contains("new_file") {
        Some(AgentFileOperation::Create)
    } else if name.contains("edit") || name.contains("search_replace") || name.contains("write") {
        Some(AgentFileOperation::Edit)
    } else if name.contains("read_file") {
        Some(AgentFileOperation::Read)
    } else {
        None
    }
}

/// The bubble's `event_at` in epoch ms from its ISO-8601 `createdAt`, falling back to the session start.
fn bubble_event_at(record: &Value, ctx: &SessionContext) -> i64 {
    record
        .get("createdAt")
        .and_then(|created| {
            created
                .as_str()
                .and_then(rfc3339_to_epoch_ms)
                .or_else(|| created.as_i64())
        })
        .or(ctx.vendor_started_at)
        .unwrap_or(0)
}

/// Emits one [`AgentFileEventFact`] per file-touching tool call, in the reader's bubble order. The path is
/// relativized against `ctx.repo_root`. Existing `targetFile` / `effectiveUri` facts retain their legacy
/// session-global `source_block_index`. A newly recognized `relativeWorkspacePath` fact uses zero because
/// a Cursor bubble contains one tool block and its stable `bubbleId` already scopes the ingest identity.
///
/// # Panics
/// Never. A malformed or unexpected record yields no fact (best-effort), not a panic.
pub fn cursor_file_facts(records: &[Value], ctx: &SessionContext) -> Vec<AgentFileEventFact> {
    let repo_root = Path::new(&ctx.repo_root);
    let mut block_index = 0i64;
    let mut facts = Vec::new();

    for record in records {
        let Some(block) = tool_block(record) else {
            continue;
        };
        let Some(operation) = file_operation(block.name) else {
            continue;
        };
        let Some(raw_path) = block.target_file.as_deref() else {
            continue;
        };
        let source_block_index = if block.target_file_is_relative_workspace_path {
            0
        } else {
            block_index
        };
        facts.push(AgentFileEventFact {
            vendor_session_id: composer_id(record)
                .unwrap_or(&ctx.vendor_session_id)
                .to_string(),
            vendor_message_id: bubble_id(record).map(str::to_string),
            source_block_index,
            normalized_repo_path: relativize_repo_path(repo_root, raw_path),
            operation,
            event_at: bubble_event_at(record, ctx),
            // The path is normalized, not redacted; nothing else is emitted.
            dropped_sensitive: 0,
        });
        if !block.target_file_is_relative_workspace_path {
            block_index += 1;
        }
    }
    facts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor_records::tests::bubble;
    use crate::paths::OUTSIDE_REPO;
    use serde_json::json;

    const REPO_ROOT: &str = "/work/trace-flow";

    fn ctx_with_root(root: &str) -> SessionContext {
        SessionContext {
            vendor_session_id: "comp-1".to_string(),
            agent_id: "agent-abc".to_string(),
            normalized_git_remote: "github.com/acme/trace-flow".to_string(),
            repo_path_fallback: "trace-flow".to_string(),
            git_branch: "main".to_string(),
            git_head_sha: "deadbeef".to_string(),
            vendor_started_at: Some(1_778_964_000_000),
            agent_depth: 0,
            repo_root: root.to_string(),
        }
    }

    fn file_tool(name: &str, target: &str) -> Value {
        file_tool_with_bubble_id(name, target, "bub-1")
    }

    fn file_tool_with_bubble_id(name: &str, target: &str, bubble_id: &str) -> Value {
        let params = serde_json::to_string(&json!({ "targetFile": target })).unwrap();
        bubble(
            "comp-1",
            "gpt-5.2",
            2,
            json!({
                "bubbleId": bubble_id,
                "toolFormerData": { "name": name, "status": "completed", "params": params }
            }),
        )
    }

    #[test]
    fn maps_each_tool_to_its_operation_and_relativizes_the_path() {
        let records = [
            file_tool("read_file_v2", "/work/trace-flow/src/a.rs"),
            file_tool("edit_file_v2", "/work/trace-flow/src/b.rs"),
            file_tool("search_replace", "/work/trace-flow/src/c.rs"),
        ];
        let facts = cursor_file_facts(&records, &ctx_with_root(REPO_ROOT));
        let shape: Vec<_> = facts
            .iter()
            .map(|f| (f.operation, f.normalized_repo_path.as_str()))
            .collect();
        assert_eq!(
            shape,
            [
                (AgentFileOperation::Read, "src/a.rs"),
                (AgentFileOperation::Edit, "src/b.rs"),
                (AgentFileOperation::Edit, "src/c.rs"),
            ]
        );
    }

    #[test]
    fn an_absolute_home_path_with_no_repo_root_collapses_to_the_sentinel() {
        // The common Cursor case: no session cwd → empty repo_root → every absolute path is outside.
        let records = [file_tool("read_file_v2", "/Users/janedoe/secret/.env")];
        let f = &cursor_file_facts(&records, &ctx_with_root(""))[0];
        assert_eq!(f.normalized_repo_path, OUTSIDE_REPO);
        assert!(!f.normalized_repo_path.contains("janedoe"));
    }

    #[test]
    fn relative_workspace_edit_emits_a_safe_repo_relative_file_fact() {
        let params = serde_json::to_string(&json!({
            "relativeWorkspacePath": "src/auth.rs"
        }))
        .unwrap();
        let records = [bubble(
            "comp-1",
            "gpt-5.2",
            2,
            json!({ "toolFormerData": {
                "name": "edit_file_v2",
                "status": "completed",
                "params": params,
            } }),
        )];

        let facts = cursor_file_facts(&records, &ctx_with_root(REPO_ROOT));
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].operation, AgentFileOperation::Edit);
        assert_eq!(facts[0].normalized_repo_path, "src/auth.rs");
        assert_eq!(facts[0].source_block_index, 0);
    }

    #[test]
    fn relative_workspace_fact_does_not_rekey_existing_file_facts() {
        let existing = [
            file_tool_with_bubble_id("edit_file_v2", "/work/trace-flow/src/a.rs", "bub-a"),
            file_tool_with_bubble_id("delete_file", "/work/trace-flow/src/b.rs", "bub-b"),
        ];
        let baseline = cursor_file_facts(&existing, &ctx_with_root(REPO_ROOT));

        let params = serde_json::to_string(&json!({
            "relativeWorkspacePath": "src/new.rs"
        }))
        .unwrap();
        let added = bubble(
            "comp-1",
            "gpt-5.2",
            2,
            json!({
                "bubbleId": "bub-new",
                "toolFormerData": {
                    "name": "edit_file_v2",
                    "status": "completed",
                    "params": params,
                }
            }),
        );
        let records = [added, existing[0].clone(), existing[1].clone()];
        let with_added = cursor_file_facts(&records, &ctx_with_root(REPO_ROOT));

        assert_eq!(with_added[0].source_block_index, 0);
        assert_eq!(with_added[1..], baseline);
    }

    #[test]
    fn unsafe_relative_workspace_paths_do_not_escape_into_file_facts() {
        let params = serde_json::to_string(&json!({
            "relativeWorkspacePath": "../../Users/janedoe/secret/.env"
        }))
        .unwrap();
        let absolute = serde_json::to_string(&json!({
            "relativeWorkspacePath": "/Users/janedoe/secret/.env"
        }))
        .unwrap();
        let records = [
            bubble(
                "comp-1",
                "gpt-5.2",
                2,
                json!({ "toolFormerData": {
                    "name": "edit_file_v2",
                    "status": "completed",
                    "params": params,
                } }),
            ),
            bubble(
                "comp-1",
                "gpt-5.2",
                2,
                json!({ "toolFormerData": {
                    "name": "edit_file_v2",
                    "status": "completed",
                    "params": absolute,
                } }),
            ),
        ];

        let facts = cursor_file_facts(&records, &ctx_with_root(REPO_ROOT));
        assert_eq!(facts.len(), 2);
        for fact in facts {
            assert_eq!(fact.normalized_repo_path, OUTSIDE_REPO);
            assert!(!fact.normalized_repo_path.contains("janedoe"));
        }
    }

    #[test]
    fn a_terminal_or_search_tool_emits_no_file_fact() {
        let cmd = serde_json::to_string(&json!({ "command": "ls" })).unwrap();
        let records = [bubble(
            "comp-1",
            "gpt-5.2",
            2,
            json!({ "toolFormerData": { "name": "run_terminal_command_v2", "status": "completed", "params": cmd } }),
        )];
        assert!(cursor_file_facts(&records, &ctx_with_root(REPO_ROOT)).is_empty());
    }

    #[test]
    fn two_edits_of_one_file_stay_distinct_via_block_index() {
        let records = [
            file_tool("edit_file_v2", "/work/trace-flow/src/auth.rs"),
            file_tool("edit_file_v2", "/work/trace-flow/src/auth.rs"),
        ];
        let facts = cursor_file_facts(&records, &ctx_with_root(REPO_ROOT));
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].source_block_index, 0);
        assert_eq!(facts[1].source_block_index, 1);
        assert_ne!(facts[0].source_block_index, facts[1].source_block_index);
    }

    #[test]
    fn empty_session_emits_no_facts() {
        assert!(cursor_file_facts(&[], &ctx_with_root(REPO_ROOT)).is_empty());
    }
}
