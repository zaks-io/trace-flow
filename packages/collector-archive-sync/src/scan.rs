use collector_archive::{
    claude_transcript_part_id, default_transcript_part_id, scan_claude_jsonl,
    scan_claude_jsonl_part, scan_codex_jsonl, ArchiveSource, CompletedScanCheckpoint, JsonlScan,
};
use serde_json::Value;

use crate::error::{ArchiveSyncError, ArchiveSyncResult};

pub fn archive_source_session_id(source: ArchiveSource, bytes: &[u8]) -> ArchiveSyncResult<String> {
    let records = jsonl_values(bytes);
    let session_id = match source {
        ArchiveSource::Claude => records
            .iter()
            .filter_map(|record| record.get("sessionId").and_then(Value::as_str))
            .map(str::trim)
            .find(|value| !value.is_empty())
            .map(str::to_string),
        ArchiveSource::Codex => records
            .iter()
            .find(|record| record.get("type").and_then(Value::as_str) == Some("session_meta"))
            .and_then(|record| record.get("payload"))
            .and_then(|payload| payload.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    };
    let session_id = session_id.ok_or(ArchiveSyncError::InvalidSession)?;
    crate::spool::validate_spool_session_id(&session_id)?;
    Ok(session_id)
}

/// Resolve Claude parent vs subagent part identity from the transcript path and records.
///
/// Parent files use [`scan_claude_jsonl`] (`claude:part:parent`). A `subagents/` path uses
/// [`scan_claude_jsonl_part`] with `agentId` when present, otherwise a stable path-derived
/// identity. Subagent paths never fall back to the parent part. Codex is always
/// `codex:part:primary`.
pub fn transcript_part_for(
    source: ArchiveSource,
    transcript_path: Option<&str>,
    bytes: &[u8],
) -> ArchiveSyncResult<(String, Option<String>)> {
    match source {
        ArchiveSource::Claude => {
            if transcript_path.is_some_and(claude_is_subagent_path) {
                let identity = claude_agent_id(bytes)
                    .or_else(|| transcript_path.and_then(claude_subagent_path_identity))
                    .ok_or(ArchiveSyncError::InvalidSession)?;
                return Ok((claude_transcript_part_id(&identity)?, Some(identity)));
            }
            Ok((default_transcript_part_id(ArchiveSource::Claude), None))
        }
        ArchiveSource::Codex => Ok((default_transcript_part_id(ArchiveSource::Codex), None)),
    }
}

pub fn scan_snapshot(
    source: ArchiveSource,
    source_session_id: &str,
    transcript_part_identity: Option<&str>,
    bytes: &[u8],
    observed_at: i64,
    prior: Option<&CompletedScanCheckpoint>,
) -> ArchiveSyncResult<JsonlScan> {
    let scan = match source {
        ArchiveSource::Claude => match transcript_part_identity {
            Some(identity) => {
                scan_claude_jsonl_part(source_session_id, identity, bytes, observed_at, prior)?
            }
            None => scan_claude_jsonl(source_session_id, bytes, observed_at, prior)?,
        },
        ArchiveSource::Codex => scan_codex_jsonl(source_session_id, bytes, observed_at, prior)?,
    };
    Ok(scan)
}

fn claude_is_subagent_path(path: &str) -> bool {
    path.split(['/', '\\'])
        .any(|segment| segment == "subagents")
}

fn claude_subagent_path_identity(path: &str) -> Option<String> {
    let segments: Vec<&str> = path
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
        .collect();
    let idx = segments
        .iter()
        .rposition(|segment| *segment == "subagents")?;
    let rest = &segments[idx + 1..];
    if rest.is_empty() {
        return None;
    }
    Some(format!("path:{}", rest.join("/")))
}

fn claude_agent_id(bytes: &[u8]) -> Option<String> {
    jsonl_values(bytes)
        .iter()
        .filter_map(|record| record.get("agentId").and_then(Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(str::to_string)
}

fn jsonl_values(bytes: &[u8]) -> Vec<Value> {
    let text = String::from_utf8_lossy(bytes);
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_claude_and_codex_session_ids() {
        let claude = br#"{"sessionId":"claude-session-001","uuid":"r1"}"#;
        assert_eq!(
            archive_source_session_id(ArchiveSource::Claude, claude).unwrap(),
            "claude-session-001"
        );
        let codex = br#"{"type":"session_meta","payload":{"id":"codex-session-001"}}"#;
        assert_eq!(
            archive_source_session_id(ArchiveSource::Codex, codex).unwrap(),
            "codex-session-001"
        );
    }

    #[test]
    fn missing_session_id_fails_loud() {
        assert!(archive_source_session_id(ArchiveSource::Claude, b"{\"uuid\":\"r1\"}").is_err());
    }

    #[test]
    fn path_escaping_session_id_fails_loud() {
        assert!(
            archive_source_session_id(ArchiveSource::Claude, br#"{"sessionId":"../escape"}"#)
                .is_err()
        );
        assert!(
            archive_source_session_id(ArchiveSource::Claude, br#"{"sessionId":"nested/id"}"#)
                .is_err()
        );
    }

    #[test]
    fn parent_and_subagent_paths_resolve_distinct_parts() {
        let parent = br#"{"sessionId":"session-1","uuid":"p1"}"#;
        let subagent = br#"{"sessionId":"session-1","uuid":"s1","agentId":"agent-001"}"#;
        let (parent_part, parent_identity) = transcript_part_for(
            ArchiveSource::Claude,
            Some("/home/.claude/projects/p/session-1.jsonl"),
            parent,
        )
        .unwrap();
        let (sub_part, sub_identity) = transcript_part_for(
            ArchiveSource::Claude,
            Some("/home/.claude/projects/p/session-1/subagents/agent.jsonl"),
            subagent,
        )
        .unwrap();
        assert_eq!(
            parent_part,
            default_transcript_part_id(ArchiveSource::Claude)
        );
        assert!(parent_identity.is_none());
        assert_eq!(sub_identity.as_deref(), Some("agent-001"));
        assert_ne!(parent_part, sub_part);
        assert_eq!(sub_part, claude_transcript_part_id("agent-001").unwrap());
    }

    #[test]
    fn missing_or_empty_agent_id_subagent_never_uses_parent_part() {
        let parent = br#"{"sessionId":"session-1","uuid":"p1"}"#;
        let missing = br#"{"sessionId":"session-1","uuid":"s1"}"#;
        let empty = br#"{"sessionId":"session-1","uuid":"s2","agentId":"   "}"#;
        let parent_part = default_transcript_part_id(ArchiveSource::Claude);
        let (resolved_parent, parent_identity) = transcript_part_for(
            ArchiveSource::Claude,
            Some("/home/.claude/projects/p/session-1.jsonl"),
            parent,
        )
        .unwrap();
        assert_eq!(resolved_parent, parent_part);
        assert!(parent_identity.is_none());

        for (path, bytes, expected_identity) in [
            (
                "/home/.claude/projects/p/session-1/subagents/child.jsonl",
                missing.as_slice(),
                "path:child.jsonl",
            ),
            (
                "/home/.claude/projects/p/session-1/subagents/empty.jsonl",
                empty.as_slice(),
                "path:empty.jsonl",
            ),
        ] {
            let (part, identity) = transcript_part_for(ArchiveSource::Claude, Some(path), bytes)
                .expect("subagent path must keep a distinct part identity");
            assert_eq!(identity.as_deref(), Some(expected_identity));
            assert_eq!(part, claude_transcript_part_id(expected_identity).unwrap());
            assert_ne!(part, parent_part);
        }
    }

    #[test]
    fn subagent_path_without_identity_fails_isolated() {
        let bytes = br#"{"sessionId":"session-1","uuid":"s1"}"#;
        let err = transcript_part_for(
            ArchiveSource::Claude,
            Some("/home/.claude/projects/p/session-1/subagents"),
            bytes,
        )
        .expect_err("a subagents/ path with no file identity must not fall back to parent");
        assert!(matches!(err, ArchiveSyncError::InvalidSession));
    }
}
