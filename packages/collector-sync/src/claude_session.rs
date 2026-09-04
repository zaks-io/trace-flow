// SPDX-License-Identifier: Apache-2.0
// Original Trace Flow code. The Claude record field names read here (`sessionId`, `timestamp`, `cwd`,
// `gitBranch`, `agentId`) match what otto-parser/src/parser/claude_code/mod.rs reads
// (~/src/otto, 2026-05-25), but otto read them per-event inside its parser; here the sync layer
// resolves them once per session to seed a `SessionContext`. Trace Flow owns the contract, IDs,
// pricing, redaction, and storage around this code.

//! Claude session-field extraction.
//!
//! The record-reading half of building a session's
//! [`SessionContext`](collector_parser::session_context::SessionContext): given one Claude transcript's
//! parsed records, [`claude_session_fields`] pulls out the per-session identity the emitters need but
//! the records repeat on every line — the vendor session id, Claude sub-agent id, the session start
//! instant, and the working directory + branch hint that seed git resolution. The async git resolution
//! and `SyncUnit` assembly are the next 3d leaf; this module is pure and reads records only, never the
//! filesystem.
//!
//! Every field is taken from the *first* record that carries a usable value (sessions repeat `sessionId`
//! / `agentId` / `cwd` / `gitBranch` on every line; the freeze cache keys on the first `cwd`, so
//! picking the first here matches it). `vendor_started_at` is the *earliest* parseable `timestamp`, so
//! it is correct even if a leading summary record is undated or the file is not strictly time-ordered.

use serde_json::Value;

use collector_parser::timestamp::rfc3339_to_epoch_ms;

/// The session-identity fields carried by a Claude transcript's records (as opposed to the git facts,
/// which the next leaf resolves by shelling out). All optional: an absent value stays `None`/empty and
/// the ingest Worker resolves the final `*_pk` from whatever is present.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClaudeSessionFields {
    pub vendor_session_id: String,
    pub agent_id: String,
    pub vendor_started_at: Option<i64>,
    /// The session's working directory — the input to git resolution and the `repo_root` anchor.
    pub cwd: Option<String>,
    /// The branch the record recorded, used only as a fallback when live git resolution finds none.
    pub git_branch: Option<String>,
}

/// Extract the per-session identity fields from one Claude transcript's `records`. Pure: see the module
/// docs for the first-value / earliest-timestamp rules.
pub fn claude_session_fields(records: &[Value]) -> ClaudeSessionFields {
    ClaudeSessionFields {
        vendor_session_id: first_nonempty_str(records, "sessionId").unwrap_or_default(),
        agent_id: first_nonempty_str(records, "agentId").unwrap_or_default(),
        vendor_started_at: earliest_timestamp(records),
        cwd: first_nonempty_str(records, "cwd"),
        git_branch: first_nonempty_str(records, "gitBranch"),
    }
}

/// The transcript's nesting depth from its file path: `0` for a top-level session, `1` for a sub-agent
/// transcript Claude writes under a `subagents/` directory beside the parent session file. Per-record
/// `isSidechain` is a separate signal the emitters ride onto each fact; this is the whole-file depth.
/// The exact on-disk nesting layout is confirmed against real transcripts at the 3d E2E leaf.
pub fn agent_depth_from_transcript_path(path: &str) -> i64 {
    // Capped at 1: today's Claude layout nests sub-agents exactly one level. If the E2E leaf finds
    // deeper nesting, count the `subagents` segments here instead of short-circuiting to 1.
    if path
        .split(['/', '\\'])
        .any(|segment| segment == "subagents")
    {
        1
    } else {
        0
    }
}

/// First record whose `key` is a non-blank string, trimmed.
fn first_nonempty_str(records: &[Value], key: &str) -> Option<String> {
    records
        .iter()
        .filter_map(|record| record.get(key).and_then(Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(str::to_string)
}

/// Earliest parseable `timestamp` across all records — the session start instant. Records without a
/// parseable timestamp are ignored rather than failing the whole session.
fn earliest_timestamp(records: &[Value]) -> Option<i64> {
    records
        .iter()
        .filter_map(|record| record.get("timestamp").and_then(Value::as_str))
        .filter_map(rfc3339_to_epoch_ms)
        .min()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn records(values: Value) -> Vec<Value> {
        values.as_array().unwrap().clone()
    }

    #[test]
    fn extracts_session_id_agent_id_started_at_cwd_and_branch() {
        let recs = records(json!([
            {
                "type": "user",
                "sessionId": "11111111-2222-3333-4444-555555555555",
                "agentId": "agent-a4816690be3dffb45",
                "cwd": "/work/trace-flow",
                "gitBranch": "main",
                "timestamp": "2026-05-26T16:38:59.892Z"
            }
        ]));
        let fields = claude_session_fields(&recs);
        assert_eq!(
            fields.vendor_session_id,
            "11111111-2222-3333-4444-555555555555"
        );
        assert_eq!(fields.agent_id, "agent-a4816690be3dffb45");
        assert_eq!(fields.cwd.as_deref(), Some("/work/trace-flow"));
        assert_eq!(fields.git_branch.as_deref(), Some("main"));
        assert_eq!(fields.vendor_started_at, Some(1_779_813_539_892));
    }

    #[test]
    fn earliest_timestamp_wins_regardless_of_record_order() {
        let recs = records(json!([
            { "type": "assistant", "timestamp": "2026-05-26T16:39:00.000Z" },
            { "type": "user", "timestamp": "2026-05-26T16:38:59.892Z" },
            { "type": "assistant", "timestamp": "2026-05-26T16:40:00.000Z" }
        ]));
        assert_eq!(
            claude_session_fields(&recs).vendor_started_at,
            Some(1_779_813_539_892)
        );
    }

    #[test]
    fn missing_fields_default_to_empty_or_none() {
        let fields = claude_session_fields(&[]);
        assert_eq!(fields, ClaudeSessionFields::default());
        assert_eq!(fields.vendor_session_id, "");
        assert_eq!(fields.agent_id, "");
        assert_eq!(fields.vendor_started_at, None);
        assert_eq!(fields.cwd, None);
        assert_eq!(fields.git_branch, None);
    }

    #[test]
    fn blank_strings_are_skipped_for_the_first_real_value() {
        let recs = records(json!([
            { "sessionId": "   ", "agentId": " ", "cwd": "" },
            { "sessionId": "real-session", "agentId": "agent-real", "cwd": "/work/repo" }
        ]));
        let fields = claude_session_fields(&recs);
        assert_eq!(fields.vendor_session_id, "real-session");
        assert_eq!(fields.agent_id, "agent-real");
        assert_eq!(fields.cwd.as_deref(), Some("/work/repo"));
    }

    #[test]
    fn unparseable_timestamps_are_ignored() {
        let recs = records(json!([
            { "timestamp": "not-a-timestamp" },
            { "timestamp": "2026-05-26T16:38:59.892Z" }
        ]));
        assert_eq!(
            claude_session_fields(&recs).vendor_started_at,
            Some(1_779_813_539_892)
        );
    }

    #[test]
    fn agent_depth_is_zero_for_top_level_and_one_under_subagents() {
        assert_eq!(
            agent_depth_from_transcript_path("/Users/x/.claude/projects/p/abc.jsonl"),
            0
        );
        assert_eq!(
            agent_depth_from_transcript_path("/Users/x/.claude/projects/p/subagents/def.jsonl"),
            1
        );
        // A file merely named with the substring is not a sub-agent transcript.
        assert_eq!(
            agent_depth_from_transcript_path("/Users/x/.claude/projects/p/subagents-notes.jsonl"),
            0
        );
    }
}
