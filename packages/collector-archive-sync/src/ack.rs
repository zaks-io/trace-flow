use collector_archive::ArchiveSource;
use serde::{Deserialize, Serialize};

use crate::spool::PendingArchiveRequest;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ArchiveAcknowledgement {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
    #[serde(default)]
    pub request_sha256: Option<String>,
    #[serde(default)]
    pub captured_byte_offset: Option<u64>,
    #[serde(default)]
    pub captured_prefix_sha256: Option<String>,
    pub status: String,
    #[serde(default)]
    pub duplicate: bool,
    pub source: ArchiveSource,
    pub source_session_id: String,
    #[serde(default)]
    pub source_transcript_part_id: Option<String>,
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

/// Byte captures require an exact request digest and captured-prefix receipt.
/// Legacy requests retain their original aggregate-count acknowledgement contract.
pub fn acknowledgement_matches(
    pending: &PendingArchiveRequest,
    ack: &ArchiveAcknowledgement,
) -> bool {
    if ack.status != "acknowledged"
        || ack.source != pending.source
        || ack.source_session_id != pending.source_session_id
    {
        return false;
    }
    if let Some(part) = ack
        .source_transcript_part_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        if part != pending.source_transcript_part_id {
            return false;
        }
    }
    let body: serde_json::Value = match serde_json::from_slice(&pending.body) {
        Ok(value) => value,
        Err(_) => return counts_match(pending, ack),
    };
    if body["checkpoint"]["archive_format_version"].as_u64() == Some(2) {
        if ack.relative_path.as_deref() != body["relative_path"].as_str() {
            return false;
        }
        return ack.request_sha256.as_deref()
            == Some(
                collector_archive::sha256(&pending.body)
                    .to_string()
                    .as_str(),
            )
            && ack.source_transcript_part_id.as_deref()
                == Some(pending.source_transcript_part_id.as_str())
            && ack.captured_byte_offset
                == body["checkpoint"]["last_complete_byte_offset"].as_u64()
            && ack.captured_prefix_sha256.as_deref()
                == body["checkpoint"]["complete_prefix_sha256"].as_str()
            && ack.generation > 0
            && !ack.manifest_key.is_empty()
            && serde_json::from_value::<collector_archive::Sha256Digest>(
                serde_json::Value::String(ack.chain_head.clone()),
            )
            .is_ok();
    }
    counts_match(pending, ack)
}

fn counts_match(pending: &PendingArchiveRequest, ack: &ArchiveAcknowledgement) -> bool {
    if ack.record_count == pending.expected_record_count {
        return true;
    }
    if pending.expected_appended_records > 0
        && ack.appended_records == pending.expected_appended_records
    {
        return true;
    }
    // Archive API session-aggregate duplicate: no part field, appended_records=0,
    // record_count is the whole-session ledger (parent + subagent).
    ack.appended_records == 0 && ack.record_count >= pending.expected_record_count
}

#[cfg(test)]
mod tests {
    use super::*;
    use collector_archive::default_transcript_part_id;

    fn pending() -> PendingArchiveRequest {
        PendingArchiveRequest {
            capture_authorization: None,
            predecessor_part_id: None,
            source: ArchiveSource::Claude,
            source_session_id: "session-1".to_string(),
            source_transcript_part_id: default_transcript_part_id(ArchiveSource::Claude),
            expected_record_count: 2,
            expected_appended_records: 2,
            body: b"{}".to_vec(),
        }
    }

    fn ack() -> ArchiveAcknowledgement {
        ArchiveAcknowledgement {
            relative_path: None,
            request_sha256: None,
            captured_byte_offset: None,
            captured_prefix_sha256: None,
            status: "acknowledged".to_string(),
            duplicate: false,
            source: ArchiveSource::Claude,
            source_session_id: "session-1".to_string(),
            source_transcript_part_id: None,
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
    fn byte_capture_requires_the_exact_request_and_checkpoint_receipt() {
        let pending = crate::build_bounded_pending_for_part(
            ArchiveSource::Claude,
            "session-1",
            "claude:part:parent",
            b"{partial\xff",
            10,
            None,
        )
        .unwrap()
        .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&pending.body).unwrap();
        let mut receipt = ack();
        receipt.source_transcript_part_id = Some(pending.source_transcript_part_id.clone());
        receipt.request_sha256 = Some(collector_archive::sha256(&pending.body).to_string());
        receipt.captured_byte_offset = body["checkpoint"]["last_complete_byte_offset"].as_u64();
        receipt.captured_prefix_sha256 = body["checkpoint"]["complete_prefix_sha256"]
            .as_str()
            .map(str::to_owned);
        receipt.chain_head = collector_archive::sha256(b"chain").to_string();
        assert!(acknowledgement_matches(&pending, &receipt));
        let mut wrong = receipt.clone();
        wrong.request_sha256 = Some(collector_archive::sha256(b"different request").to_string());
        assert!(!acknowledgement_matches(&pending, &wrong));
        wrong = receipt.clone();
        wrong.captured_byte_offset = Some(0);
        assert!(!acknowledgement_matches(&pending, &wrong));
        wrong = receipt.clone();
        wrong.captured_prefix_sha256 = None;
        assert!(!acknowledgement_matches(&pending, &wrong));
        wrong = receipt;
        wrong.source_transcript_part_id = None;
        assert!(!acknowledgement_matches(&pending, &wrong));
    }

    #[test]
    fn session_wide_record_count_matches_via_appended_records() {
        let mut later_part = ack();
        later_part.record_count = 4;
        later_part.appended_records = 2;
        assert!(acknowledgement_matches(&pending(), &later_part));
    }

    #[test]
    fn part_mismatch_does_not_advance() {
        let mut wrong_part = ack();
        wrong_part.source_transcript_part_id = Some(
            "claude:part:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_string(),
        );
        assert!(!acknowledgement_matches(&pending(), &wrong_part));
    }

    #[test]
    fn session_aggregate_duplicate_parent_rescan_matches() {
        let pending = PendingArchiveRequest {
            capture_authorization: None,
            predecessor_part_id: None,
            source: ArchiveSource::Claude,
            source_session_id: "session-1".to_string(),
            source_transcript_part_id: default_transcript_part_id(ArchiveSource::Claude),
            expected_record_count: 1,
            expected_appended_records: 1,
            body: b"{}".to_vec(),
        };
        let ack = ArchiveAcknowledgement {
            relative_path: None,
            request_sha256: None,
            captured_byte_offset: None,
            captured_prefix_sha256: None,
            status: "acknowledged".to_string(),
            duplicate: false,
            source: ArchiveSource::Claude,
            source_session_id: "session-1".to_string(),
            source_transcript_part_id: None,
            contribution_id: "con_1".to_string(),
            appended_records: 0,
            appended_checkpoint: false,
            record_count: 3,
            generation: 1,
            chain_head: "sha256:00".to_string(),
            manifest_key: "m".to_string(),
            chunk_keys: vec![],
        };
        assert!(acknowledgement_matches(&pending, &ack));
    }

    #[test]
    fn session_or_count_mismatch_does_not_advance() {
        let mut wrong_session = ack();
        wrong_session.source_session_id = "other".to_string();
        assert!(!acknowledgement_matches(&pending(), &wrong_session));

        let mut wrong_count = ack();
        wrong_count.record_count = 1;
        wrong_count.appended_records = 1;
        assert!(!acknowledgement_matches(&pending(), &wrong_count));

        let mut aggregate_too_small = ack();
        aggregate_too_small.record_count = 0;
        aggregate_too_small.appended_records = 0;
        assert!(!acknowledgement_matches(&pending(), &aggregate_too_small));

        let mut not_ack = ack();
        not_ack.status = "pending".to_string();
        assert!(!acknowledgement_matches(&pending(), &not_ack));
    }
}
