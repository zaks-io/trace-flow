use collector_archive::{
    scan_claude_jsonl, scan_codex_jsonl, ArchiveSource, CompletedScanCheckpoint, JsonlScan,
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

pub fn scan_snapshot(
    source: ArchiveSource,
    source_session_id: &str,
    bytes: &[u8],
    observed_at: i64,
    prior: Option<&CompletedScanCheckpoint>,
) -> ArchiveSyncResult<JsonlScan> {
    let scan = match source {
        ArchiveSource::Claude => scan_claude_jsonl(source_session_id, bytes, observed_at, prior)?,
        ArchiveSource::Codex => scan_codex_jsonl(source_session_id, bytes, observed_at, prior)?,
    };
    Ok(scan)
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
}
