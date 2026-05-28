// SPDX-License-Identifier: MIT
// Original Trace Flow code. Codex stores session identity + git facts in a single `session_meta`
// record's `payload`, unlike Claude (which repeats `sessionId`/`cwd`/`gitBranch` on every line). This
// is the Codex counterpart to `claude_session`. Trace Flow owns the contract, IDs, pricing, redaction,
// and storage around this code.

//! Codex session-field extraction.
//!
//! Codex rollouts open with one `session_meta` record whose `payload` carries the session id, the
//! working directory, and — unlike Claude — the git facts inline: `payload.git.repository_url`,
//! `payload.git.branch`, `payload.git.commit_hash`. So a Codex session resolves its repo from the
//! transcript itself and does not depend on the `cwd` still being a live git checkout at sync time
//! (which is why the Claude path's `git` shell-out misattributed Codex sessions to a path
//! fingerprint). `cwd` is still surfaced as the `repo_root` anchor for path relativization.

use serde_json::Value;

use collector_parser::timestamp::rfc3339_to_epoch_ms;

use crate::claude_session::ClaudeSessionFields;
use crate::git::GitMetadata;

/// What a Codex `session_meta` record yields: the same identity fields as Claude, plus the git facts
/// Codex embeds in the transcript. The embedded git stands in for the live `git` resolve.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexSessionFields {
    pub fields: ClaudeSessionFields,
    /// Git facts read straight from `session_meta.payload.git`, when present. Used in place of the
    /// live filesystem resolve so a moved/removed checkout cannot drop a Codex session's repo.
    pub embedded_git: Option<GitMetadata>,
    /// `payload.git.commit_hash` — the HEAD sha Codex records (Claude transcripts carry none).
    pub git_head_sha: Option<String>,
}

/// Extract Codex session identity + embedded git from a parsed transcript's `records`. Reads the first
/// `session_meta` record; everything is optional, so a transcript without one yields defaults and the
/// ingest Worker resolves whatever `*_pk` it can from what is present.
pub fn codex_session_fields(records: &[Value]) -> CodexSessionFields {
    let meta = records
        .iter()
        .find(|r| r.get("type").and_then(Value::as_str) == Some("session_meta"))
        .and_then(|r| r.get("payload"));

    let Some(payload) = meta else {
        // No session_meta: fall back to the earliest timestamp so the start instant is still correct.
        return CodexSessionFields {
            fields: ClaudeSessionFields {
                vendor_started_at: earliest_timestamp(records),
                ..ClaudeSessionFields::default()
            },
            ..CodexSessionFields::default()
        };
    };

    let git = payload.get("git");
    let remote = git
        .and_then(|g| g.get("repository_url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let branch = git
        .and_then(|g| g.get("branch"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let head_sha = git
        .and_then(|g| g.get("commit_hash"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let cwd = nonempty_str(payload, "cwd");

    // Build embedded git metadata only when there is something to attribute. `git_root` anchors path
    // relativization; with no live resolve, the recorded `cwd` is the best available root.
    let embedded_git = if remote.is_some() || branch.is_some() {
        Some(GitMetadata {
            git_root: cwd.clone().unwrap_or_default(),
            git_remote_url: remote.map(str::to_string),
            git_branch: branch.map(str::to_string),
        })
    } else {
        None
    };

    CodexSessionFields {
        fields: ClaudeSessionFields {
            vendor_session_id: nonempty_str(payload, "id").unwrap_or_default(),
            // Prefer the session_meta timestamp; fall back to the earliest record timestamp.
            vendor_started_at: payload
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(rfc3339_to_epoch_ms)
                .or_else(|| earliest_timestamp(records)),
            cwd,
            git_branch: branch.map(str::to_string),
        },
        embedded_git,
        git_head_sha: head_sha,
    }
}

/// A trimmed, non-blank string field of `obj`, or `None`.
fn nonempty_str(obj: &Value, key: &str) -> Option<String> {
    obj.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Earliest parseable `timestamp` across all records — mirrors the Claude extractor so the session
/// start instant is correct even without a `session_meta` record.
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

    fn recs(v: Value) -> Vec<Value> {
        v.as_array().unwrap().clone()
    }

    fn session_meta() -> Value {
        json!({
            "type": "session_meta",
            "timestamp": "2026-05-18T21:35:06.549Z",
            "payload": {
                "id": "019e3d03-6b35-74c0-9dd1-c40bdbb6af72",
                "cwd": "/Users/x/src/t3code",
                "timestamp": "2026-05-18T21:34:54.800Z",
                "git": {
                    "commit_hash": "d1e85c4e8fdef82fbaded9539532b754080419e0",
                    "branch": "main",
                    "repository_url": "https://github.com/pingdotgg/t3code.git"
                }
            }
        })
    }

    #[test]
    fn reads_id_cwd_and_embedded_git_remote() {
        let f = codex_session_fields(&recs(json!([session_meta()])));
        assert_eq!(f.fields.vendor_session_id, "019e3d03-6b35-74c0-9dd1-c40bdbb6af72");
        assert_eq!(f.fields.cwd.as_deref(), Some("/Users/x/src/t3code"));
        assert_eq!(f.fields.git_branch.as_deref(), Some("main"));
        let g = f.embedded_git.expect("embedded git present");
        assert_eq!(
            g.git_remote_url.as_deref(),
            Some("https://github.com/pingdotgg/t3code.git")
        );
        assert_eq!(g.git_root, "/Users/x/src/t3code");
        assert_eq!(g.git_branch.as_deref(), Some("main"));
        assert_eq!(
            f.git_head_sha.as_deref(),
            Some("d1e85c4e8fdef82fbaded9539532b754080419e0")
        );
    }

    #[test]
    fn prefers_session_meta_payload_timestamp_for_started_at() {
        let f = codex_session_fields(&recs(json!([session_meta()])));
        // 2026-05-18T21:34:54.800Z
        assert_eq!(f.fields.vendor_started_at, Some(1_779_140_094_800));
    }

    #[test]
    fn no_session_meta_falls_back_to_earliest_record_timestamp_and_no_git() {
        let f = codex_session_fields(&recs(json!([
            { "type": "response_item", "timestamp": "2026-05-18T21:40:00.000Z", "payload": {} },
            { "type": "event_msg", "timestamp": "2026-05-18T21:39:00.000Z", "payload": {} }
        ])));
        assert_eq!(f.fields.vendor_session_id, "");
        assert_eq!(f.embedded_git, None);
        assert_eq!(f.git_head_sha, None);
        assert_eq!(f.fields.vendor_started_at, Some(1_779_140_340_000));
    }

    #[test]
    fn missing_git_block_yields_no_embedded_git_but_keeps_id_and_cwd() {
        let meta = json!({
            "type": "session_meta",
            "payload": { "id": "abc", "cwd": "/work/repo", "timestamp": "2026-05-18T21:34:54.800Z" }
        });
        let f = codex_session_fields(&recs(json!([meta])));
        assert_eq!(f.fields.vendor_session_id, "abc");
        assert_eq!(f.fields.cwd.as_deref(), Some("/work/repo"));
        assert_eq!(f.embedded_git, None);
    }
}
