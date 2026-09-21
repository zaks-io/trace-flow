use std::collections::HashSet;

use tokio_util::sync::CancellationToken;

use crate::ack::{acknowledgement_matches, ArchiveAcknowledgement};
use crate::client::ArchiveUploader;
use crate::error::ArchiveSyncError;
use crate::key_store::ArchiveKeyStore;
use crate::policy::{policy_from_denial_reason, ArchivePolicy};
use crate::spool::{
    ArchiveSpool, BlockedArchiveRecord, PendingArchiveRequest, ARCHIVE_RECORD_POLICY_VERSION,
};
use crate::{ArchiveClientError, ArchiveHistoryPlan};

pub(crate) use crate::source_capture::persist_snapshot;

#[derive(Debug, Clone)]
pub struct PreparedArchiveUpload {
    pending: PendingArchiveRequest,
}

impl PreparedArchiveUpload {
    pub fn source(&self) -> collector_archive::ArchiveSource {
        self.pending.source
    }

    pub fn body(&self) -> &[u8] {
        &self.pending.body
    }

    pub fn id(&self) -> String {
        collector_archive::sha256(&self.pending.body).to_string()
    }
}

pub type ArchiveUploadResponse = Result<ArchiveAcknowledgement, ArchiveClientError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadOutcome {
    Advanced,
    Blocked,
    Frozen,
    Purged,
    Halt(&'static str),
}

pub fn prepare_next_archive_upload(
    spool: &ArchiveSpool,
    plan: &ArchiveHistoryPlan,
    policy: ArchivePolicy,
) -> Result<Option<PreparedArchiveUpload>, &'static str> {
    prepare_next_archive_upload_excluding(spool, plan, policy, &HashSet::new())
}

pub fn prepare_next_archive_upload_excluding(
    spool: &ArchiveSpool,
    plan: &ArchiveHistoryPlan,
    policy: ArchivePolicy,
    excluded: &HashSet<String>,
) -> Result<Option<PreparedArchiveUpload>, &'static str> {
    if !policy.uploads() || spool.cleanup_required() {
        return Ok(None);
    }
    let mut skipped = excluded.clone();
    let mut first_error = None;
    loop {
        let selected = spool
            .next_pending_candidate(
                |source, session| plan.pending_selection(source, session),
                |id| skipped.contains(id),
            )
            .map_err(|err| err.class())?;
        first_error = first_error.or(selected.first_error);
        let Some(pending) = selected.pending else {
            return match first_error {
                Some(class) => Err(class),
                None => Ok(None),
            };
        };
        match spool.blocked_part(
            pending.source,
            &pending.source_session_id,
            &pending.source_transcript_part_id,
        ) {
            Ok(Some(blocked)) if blocked.matches_pending(&pending) => {
                skipped.insert(collector_archive::sha256(&pending.body).to_string());
            }
            Ok(_) => return Ok(Some(PreparedArchiveUpload { pending })),
            Err(err) => return Err(err.class()),
        }
    }
}

pub async fn send_prepared_archive_upload<U: ArchiveUploader>(
    uploader: &U,
    prepared: &PreparedArchiveUpload,
    cancel: Option<&CancellationToken>,
) -> ArchiveUploadResponse {
    uploader
        .upload(prepared.pending.source, &prepared.pending.body, cancel)
        .await
}

pub fn apply_archive_upload_response(
    spool: &mut ArchiveSpool,
    key_store: &dyn ArchiveKeyStore,
    prepared: &PreparedArchiveUpload,
    response: ArchiveUploadResponse,
) -> Result<UploadOutcome, &'static str> {
    let pending = &prepared.pending;
    let remains_pending = spool
        .pending_slice_exists_exact(pending)
        .map_err(|err| err.class())?;
    if !remains_pending {
        return Err(ArchiveSyncError::AcknowledgementMismatch.class());
    }
    match response {
        Ok(ack) => {
            if !acknowledgement_matches(pending, &ack) {
                return Err(ArchiveSyncError::AcknowledgementMismatch.class());
            }
            let checkpoint = pending_checkpoint(pending)?;
            spool
                .commit_verified_acknowledgement(pending, &checkpoint, &ack)
                .map_err(|err| err.class())?;
            Ok(UploadOutcome::Advanced)
        }
        Err(err) if err.class() == "archive_record_too_large" => {
            let blocked = blocked_from_rejected_pending(pending, None)?;
            spool
                .persist_blocked_record(&blocked)
                .map_err(|error| error.class())?;
            Err(err.class())
        }
        Err(err) => match err.denial_reason().and_then(policy_from_denial_reason) {
            Some(ArchivePolicy::Revoked) => {
                spool
                    .persist_terminal_revocation()
                    .map_err(|err| err.class())?;
                match spool.finish_cleanup(key_store) {
                    Ok(()) => Ok(UploadOutcome::Purged),
                    Err(err) => Ok(UploadOutcome::Halt(err.class())),
                }
            }
            Some(ArchivePolicy::Inactive)
            | Some(ArchivePolicy::Frozen)
            | Some(ArchivePolicy::Grace) => Ok(UploadOutcome::Frozen),
            _ => Err(err.class()),
        },
    }
}

fn pending_checkpoint(
    pending: &PendingArchiveRequest,
) -> Result<collector_archive::CompletedScanCheckpoint, &'static str> {
    let value: serde_json::Value =
        serde_json::from_slice(&pending.body).map_err(|_| "archive_state")?;
    serde_json::from_value(value.get("checkpoint").cloned().ok_or("archive_state")?)
        .map_err(|_| "archive_state")
}

fn blocked_from_rejected_pending(
    pending: &PendingArchiveRequest,
    source_bytes: Option<&[u8]>,
) -> Result<BlockedArchiveRecord, &'static str> {
    let value: serde_json::Value =
        serde_json::from_slice(&pending.body).map_err(|_| "archive_state")?;
    let observations = value["observations"].as_array().ok_or("archive_state")?;
    let (source_record_identity, record_size_bytes) = match observations.as_slice() {
        [observation] => (
            observation["source_record_identity"]
                .as_str()
                .map(str::to_string),
            rejected_record_size(&value, observation),
        ),
        _ => (None, None),
    };
    let checkpoint_file_size = value["checkpoint"]["observed_file_size"]
        .as_u64()
        .ok_or("archive_state")?;
    let checkpoint_prefix_bytes = value["checkpoint"]["last_complete_byte_offset"]
        .as_u64()
        .ok_or("archive_state")?;
    let (observed_file_size, source_fingerprint_bytes, observed_file_sha256) = match source_bytes {
        Some(bytes) => (
            bytes.len() as u64,
            bytes.len() as u64,
            collector_archive::sha256(bytes).to_string(),
        ),
        None => (
            checkpoint_file_size,
            checkpoint_prefix_bytes,
            value["checkpoint"]["complete_prefix_sha256"]
                .as_str()
                .ok_or("archive_state")?
                .to_string(),
        ),
    };
    Ok(BlockedArchiveRecord {
        source: pending.source,
        source_session_id: pending.source_session_id.clone(),
        source_transcript_part_id: pending.source_transcript_part_id.clone(),
        source_record_identity,
        record_size_bytes,
        limit_bytes: collector_archive::MAX_CHUNK_BYTES,
        policy_version: ARCHIVE_RECORD_POLICY_VERSION.to_string(),
        observed_file_size,
        source_fingerprint_bytes,
        observed_file_sha256,
        pending_body_sha256: Some(collector_archive::sha256(&pending.body).to_string()),
    })
}

fn rejected_record_size(value: &serde_json::Value, observation: &serde_json::Value) -> Option<u64> {
    if let Ok(observation) =
        serde_json::from_value::<collector_archive::ArchiveObservation>(observation.clone())
    {
        return observation
            .payload_bytes()
            .ok()
            .map(|bytes| bytes.len() as u64);
    }
    let proof = value["complete_prefix_utf8"]
        .as_str()
        .or_else(|| value["append_proof"]["appended_prefix_utf8"].as_str())?;
    first_nonblank_jsonl_line(proof.as_bytes()).map(|line| line.len() as u64)
}

fn first_nonblank_jsonl_line(bytes: &[u8]) -> Option<&[u8]> {
    let mut start = 0;
    for end in 0..=bytes.len() {
        if end != bytes.len() && bytes[end] != b'\n' {
            continue;
        }
        let line = &bytes[start..end];
        if !line
            .iter()
            .all(|byte| matches!(byte, b'\t' | 0x0c | b'\r' | b' '))
        {
            return Some(line);
        }
        start = end.saturating_add(1);
    }
    None
}
