// SPDX-License-Identifier: MIT
// Original Trace Flow code. The per-source fan-out that turns one parsed session into the typed
// `AgentIngestFacts` bundle the collector-sync uploader (3b) wraps in an `AgentIngestEnvelope`.
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Per-session fact assembly.
//!
//! [`session_facts`] is the collector-parser's public entrypoint: given one session's transcript
//! records and its [`SessionContext`], it dispatches on [`AgentSource`] and runs every emitter for
//! that source, collecting the results into a single [`AgentIngestFacts`] bundle. It is a pure
//! fan-out — each field is exactly the matching emitter's output, so the bundle's identity,
//! redaction, and token rules stay entirely the emitters' (this layer adds none of its own).
//!
//! Source coverage:
//! - **Claude Code** emits messages, tool events, file events, and PR links. It has no capability
//!   snapshots — that signal is Codex `session_meta`-only — so `capability_snapshots` is empty by
//!   design, not a missing emitter.
//! - **Codex CLI** emits all five fact kinds.
//! - **Cursor** has no parser yet (fast-follow `3a*`); its arm returns an empty bundle so the
//!   uploader can treat every source uniformly. Swap in the real emitters when `3a*` lands.

use collector_contracts::enums::AgentSource;
use collector_contracts::envelope::AgentIngestFacts;
use serde_json::Value;

use crate::emit_claude::claude_message_facts;
use crate::emit_claude_files::claude_file_facts;
use crate::emit_claude_tools::claude_tool_facts;
use crate::emit_codex::codex_message_facts;
use crate::emit_codex_caps::codex_capability_facts;
use crate::emit_codex_files::codex_file_facts;
use crate::emit_codex_tools::codex_tool_facts;
use crate::emit_pr_links::{claude_pr_link_facts, codex_pr_link_facts};
use crate::session_context::SessionContext;

/// Run every emitter for `source` over one session's `records` and collect the typed
/// [`AgentIngestFacts`] bundle. Pure fan-out: see the module docs for the per-source coverage.
pub fn session_facts(
    source: AgentSource,
    records: &[Value],
    ctx: &SessionContext,
) -> AgentIngestFacts {
    match source {
        AgentSource::Claude => AgentIngestFacts {
            messages: claude_message_facts(records, ctx),
            tool_events: claude_tool_facts(records, ctx),
            file_events: claude_file_facts(records, ctx),
            capability_snapshots: Vec::new(),
            pull_request_links: claude_pr_link_facts(records, ctx),
        },
        AgentSource::Codex => AgentIngestFacts {
            messages: codex_message_facts(records, ctx),
            tool_events: codex_tool_facts(records, ctx),
            file_events: codex_file_facts(records, ctx),
            capability_snapshots: codex_capability_facts(records, ctx),
            pull_request_links: codex_pr_link_facts(records, ctx),
        },
        AgentSource::Cursor => empty_facts(),
    }
}

/// The all-empty bundle. The Cursor arm returns this until the Cursor parser (`3a*`) exists.
fn empty_facts() -> AgentIngestFacts {
    AgentIngestFacts {
        messages: Vec::new(),
        tool_events: Vec::new(),
        file_events: Vec::new(),
        capability_snapshots: Vec::new(),
        pull_request_links: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx() -> SessionContext {
        SessionContext {
            vendor_session_id: "sess-1".to_string(),
            agent_id: "agent-abc".to_string(),
            normalized_git_remote: "github.com/acme/trace-flow".to_string(),
            repo_path_fallback: "trace-flow".to_string(),
            git_branch: "main".to_string(),
            git_head_sha: "deadbeef".to_string(),
            vendor_started_at: Some(1_778_964_000_000),
            agent_depth: 0,
            repo_root: "/work/trace-flow".to_string(),
        }
    }

    /// An assistant record (text with a PR link, a Bash call, an Edit with a file path) plus the
    /// Bash tool_result sidecar — enough to populate messages, tool events, file events, and PR
    /// links at once. The block shapes match the per-emitter test fixtures they exercise.
    fn claude_session() -> Vec<Value> {
        json!([
            {
                "type": "assistant",
                "timestamp": "2026-05-25T23:37:23.355Z",
                "isSidechain": false,
                "message": {
                    "id": "msg_1",
                    "model": "claude-opus-4-7",
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": "opened github.com/acme/trace-flow/pull/42" },
                        { "type": "tool_use", "id": "t1", "name": "Bash",
                          "input": { "command": "ls" } },
                        { "type": "tool_use", "id": "t2", "name": "Edit",
                          "input": { "file_path": "/work/trace-flow/src/lib.rs" } }
                    ],
                    "usage": {
                        "input_tokens": 10, "output_tokens": 200,
                        "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 50
                    }
                }
            },
            {
                "type": "user",
                "timestamp": "2026-05-25T23:37:24.000Z",
                "message": { "content": [{
                    "type": "tool_result", "tool_use_id": "t1", "is_error": false, "content": "ok"
                }] },
                "toolUseResult": { "stdout": "done", "durationMs": 42, "interrupted": false }
            }
        ])
        .as_array()
        .unwrap()
        .clone()
    }

    /// A Codex session with a `session_meta` (capabilities) and an assistant message carrying a PR
    /// link — enough to populate messages, capability snapshots, and PR links.
    fn codex_session() -> Vec<Value> {
        json!([
            {
                "type": "session_meta",
                "timestamp": "2026-05-25T23:37:23.355Z",
                "payload": {
                    "id": "codex-sess-1",
                    "base_instructions": { "text": "You are Codex." },
                    "dynamic_tools": [
                        { "name": "shell", "namespace": "codex_app",
                          "description": "runs shell", "inputSchema": { "type": "object" } }
                    ]
                }
            },
            {
                "type": "response_item",
                "timestamp": "2026-05-25T23:37:24.000Z",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        { "type": "output_text", "text": "see github.com/acme/trace-flow/pull/7" }
                    ]
                }
            }
        ])
        .as_array()
        .unwrap()
        .clone()
    }

    #[test]
    fn claude_fans_out_to_every_emitter_and_omits_capabilities() {
        let records = claude_session();
        let c = ctx();
        let facts = session_facts(AgentSource::Claude, &records, &c);

        assert_eq!(facts.messages, claude_message_facts(&records, &c));
        assert_eq!(facts.tool_events, claude_tool_facts(&records, &c));
        assert_eq!(facts.file_events, claude_file_facts(&records, &c));
        assert_eq!(facts.pull_request_links, claude_pr_link_facts(&records, &c));
        // Capabilities are Codex-only; Claude must always assemble an empty vec, never call an emitter.
        assert!(facts.capability_snapshots.is_empty());

        // The fixture is wired so the fan-out is observably non-trivial, not just empty == empty.
        assert!(!facts.messages.is_empty());
        assert!(!facts.tool_events.is_empty());
        assert!(!facts.file_events.is_empty());
        assert!(!facts.pull_request_links.is_empty());
    }

    #[test]
    fn codex_fans_out_to_every_emitter_including_capabilities() {
        let records = codex_session();
        let c = ctx();
        let facts = session_facts(AgentSource::Codex, &records, &c);

        assert_eq!(facts.messages, codex_message_facts(&records, &c));
        assert_eq!(facts.tool_events, codex_tool_facts(&records, &c));
        assert_eq!(facts.file_events, codex_file_facts(&records, &c));
        assert_eq!(
            facts.capability_snapshots,
            codex_capability_facts(&records, &c)
        );
        assert_eq!(facts.pull_request_links, codex_pr_link_facts(&records, &c));

        assert!(!facts.messages.is_empty());
        assert!(!facts.capability_snapshots.is_empty());
        assert!(!facts.pull_request_links.is_empty());
    }

    #[test]
    fn claude_records_under_codex_source_route_to_codex_emitters() {
        // Dispatch is keyed on `source`, never sniffed from the records: Claude-shaped records read
        // through the Codex arm produce the Codex emitters' (here empty) output, not Claude's.
        let records = claude_session();
        let c = ctx();
        let facts = session_facts(AgentSource::Codex, &records, &c);
        assert_eq!(facts.messages, codex_message_facts(&records, &c));
        assert_eq!(facts.file_events, codex_file_facts(&records, &c));
    }

    #[test]
    fn cursor_is_an_empty_bundle_until_its_parser_lands() {
        let facts = session_facts(AgentSource::Cursor, &codex_session(), &ctx());
        assert!(facts.messages.is_empty());
        assert!(facts.tool_events.is_empty());
        assert!(facts.file_events.is_empty());
        assert!(facts.capability_snapshots.is_empty());
        assert!(facts.pull_request_links.is_empty());
    }
}
