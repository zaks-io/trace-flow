use collector_archive::ArchiveSource;
use serde::Deserialize;

use crate::spool::PendingArchiveRequest;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ArchiveAcknowledgement {
    pub status: String,
    #[serde(default)]
    pub duplicate: bool,
    pub source: ArchiveSource,
    pub source_session_id: String,
    #[serde(default)]
    pub contribution_id: String,
    #[serde(default)]
    pub appended_records: u64,
    #[serde(default)]
    pub appended_checkpoint: bool,
    pub record_count: u64,
    #[serde(default)]
    pub generation: u64,
    #[serde(default)]
    pub chain_head: String,
    #[serde(default)]
    pub manifest_key: String,
    #[serde(default)]
    pub chunk_keys: Vec<String>,
}

/// Advance only when the acknowledgement names the pending session and committed record count.
pub fn acknowledgement_matches(
    pending: &PendingArchiveRequest,
    ack: &ArchiveAcknowledgement,
) -> bool {
    ack.status == "acknowledged"
        && ack.source == pending.source
        && ack.source_session_id == pending.source_session_id
        && ack.record_count == pending.expected_record_count
}

#[cfg(test)]
mod tests {
    use super::*;
    use collector_archive::ArchiveSource;

    fn pending() -> PendingArchiveRequest {
        PendingArchiveRequest {
            source: ArchiveSource::Claude,
            source_session_id: "session-1".to_string(),
            expected_record_count: 2,
            body: b"{}".to_vec(),
        }
    }

    fn ack() -> ArchiveAcknowledgement {
        ArchiveAcknowledgement {
            status: "acknowledged".to_string(),
            duplicate: false,
            source: ArchiveSource::Claude,
            source_session_id: "session-1".to_string(),
            contribution_id: "con_1".to_string(),
            appended_records: 2,
            appended_checkpoint: true,
            record_count: 2,
            generation: 1,
            chain_head: "sha256:00".to_string(),
            manifest_key: "m".to_string(),
            chunk_keys: vec![],
        }
    }

    #[test]
    fn matching_ack_advances() {
        assert!(acknowledgement_matches(&pending(), &ack()));
    }

    #[test]
    fn session_or_count_mismatch_does_not_advance() {
        let mut wrong_session = ack();
        wrong_session.source_session_id = "other".to_string();
        assert!(!acknowledgement_matches(&pending(), &wrong_session));

        let mut wrong_count = ack();
        wrong_count.record_count = 1;
        assert!(!acknowledgement_matches(&pending(), &wrong_count));

        let mut not_ack = ack();
        not_ack.status = "pending".to_string();
        assert!(!acknowledgement_matches(&pending(), &not_ack));
    }
}
