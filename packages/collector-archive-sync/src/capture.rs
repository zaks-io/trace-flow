use std::borrow::Cow;

use tokio_util::sync::CancellationToken;

use crate::ack::acknowledgement_matches;
use crate::bound::build_bounded_pending;
use crate::client::ArchiveUploader;
use crate::cycle::{record_error, ArchiveCycleReport, ArchiveSnapshot};
use crate::error::ArchiveSyncError;
use crate::history::read_capture_window;
use crate::key_store::ArchiveKeyStore;
use crate::policy::{policy_from_denial_reason, ArchivePolicy};
use crate::spool::{
    ArchiveSpool, BlockedArchiveRecord, PendingArchiveRequest, ARCHIVE_RECORD_POLICY_VERSION,
};

pub(crate) async fn capture_snapshot<U: ArchiveUploader>(
    uploader: &U,
    spool: &mut ArchiveSpool,
    key_store: &dyn ArchiveKeyStore,
    snapshot: &ArchiveSnapshot,
    report: &mut ArchiveCycleReport,
    cancel: Option<&CancellationToken>,
    prefetched_source_bytes: Option<&[u8]>,
) -> Result<(), &'static str> {
    if spool.cleanup_required() {
        match spool.finish_cleanup(key_store) {
            Ok(()) => return Err("purged"),
            Err(err) => {
                report.failed += 1;
                record_error(report, err.class());
                report.halted = true;
                return Err("halt");
            }
        }
    }
    let loaded_source_bytes;
    let source_bytes = match prefetched_source_bytes {
        Some(bytes) => bytes,
        None => {
            loaded_source_bytes = match snapshot_bytes(snapshot) {
                Ok(bytes) => bytes,
                Err(_) => {
                    report.failed += 1;
                    record_error(report, "archive_io");
                    return Err("archive_io");
                }
            };
            loaded_source_bytes.as_ref()
        }
    };
    if let Err(class) = persist_snapshot_bytes(spool, snapshot, source_bytes, report, cancel) {
        if class == "purged" || class == "halt" {
            return Err(class);
        }
    }
    if cancel.is_some_and(CancellationToken::is_cancelled) {
        return Ok(());
    }
    let slices = match spool.slices_for_part(
        snapshot.source,
        &snapshot.source_session_id,
        &snapshot.source_transcript_part_id,
    ) {
        Ok(slices) => slices,
        Err(err) => {
            report.failed += 1;
            record_error(report, err.class());
            return Ok(());
        }
    };
    for pending in slices {
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return Ok(());
        }
        match upload_pending(
            uploader,
            spool,
            key_store,
            &pending,
            Some(source_bytes),
            cancel,
        )
        .await
        {
            Ok(UploadOutcome::Advanced) => {
                report.uploaded += 1;
            }
            Ok(UploadOutcome::Blocked) => {
                report.blocked += 1;
                return Ok(());
            }
            Ok(UploadOutcome::Frozen) => {
                report.frozen = true;
                return Ok(());
            }
            Ok(UploadOutcome::Purged) => return Err("purged"),
            Ok(UploadOutcome::Halt(class)) => {
                report.failed += 1;
                record_error(report, class);
                report.halted = true;
                return Err("halt");
            }
            Err(class) => {
                report.failed += 1;
                record_error(report, class);
                return Err(class);
            }
        }
    }
    Ok(())
}

fn persist_observed_slices(
    spool: &ArchiveSpool,
    snapshot: &ArchiveSnapshot,
    bytes: &[u8],
    report: &mut ArchiveCycleReport,
    cancel: Option<&CancellationToken>,
) -> Result<u32, &'static str> {
    match spool.blocked_part(
        snapshot.source,
        &snapshot.source_session_id,
        &snapshot.source_transcript_part_id,
    ) {
        Ok(Some(blocked)) if blocked.matches_source(bytes) => {
            report.blocked += 1;
            return Ok(0);
        }
        Ok(Some(_)) => {
            if let Err(err) = spool.clear_blocked_part(
                snapshot.source,
                &snapshot.source_session_id,
                &snapshot.source_transcript_part_id,
            ) {
                report.failed += 1;
                record_error(report, err.class());
                return Err(err.class());
            }
        }
        Ok(None) => {}
        Err(err) => {
            report.failed += 1;
            record_error(report, err.class());
            return Err(err.class());
        }
    }
    let progress = match spool.progress_part(
        snapshot.source,
        &snapshot.source_session_id,
        &snapshot.source_transcript_part_id,
    ) {
        Ok(progress) => progress,
        Err(err) => {
            report.failed += 1;
            record_error(report, err.class());
            return Err(err.class());
        }
    };
    let existing = match spool.slices_for_part(
        snapshot.source,
        &snapshot.source_session_id,
        &snapshot.source_transcript_part_id,
    ) {
        Ok(existing) => existing,
        Err(err) => {
            report.failed += 1;
            record_error(report, err.class());
            return Err(err.class());
        }
    };
    let mut prior = match existing
        .iter()
        .max_by_key(|record| record.expected_record_count)
    {
        Some(last) => Some(pending_checkpoint(last)?),
        None => progress,
    };
    let mut persisted = 0u32;
    loop {
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            break;
        }
        let pending = match build_bounded_pending(
            snapshot.source,
            &snapshot.source_session_id,
            snapshot.transcript_part_identity.as_deref(),
            bytes,
            snapshot.observed_at,
            prior.as_ref(),
        ) {
            Ok(Some(pending)) => pending,
            Ok(None) => break,
            Err(ArchiveSyncError::RecordTooLarge {
                source_record_identity,
                record_size_bytes,
                limit_bytes,
            }) => {
                let blocked = BlockedArchiveRecord {
                    source: snapshot.source,
                    source_session_id: snapshot.source_session_id.clone(),
                    source_transcript_part_id: snapshot.source_transcript_part_id.clone(),
                    source_record_identity: Some(source_record_identity),
                    record_size_bytes: Some(record_size_bytes),
                    limit_bytes,
                    policy_version: ARCHIVE_RECORD_POLICY_VERSION.to_string(),
                    observed_file_size: bytes.len() as u64,
                    source_fingerprint_bytes: bytes.len() as u64,
                    observed_file_sha256: collector_archive::sha256(bytes).to_string(),
                    pending_body_sha256: None,
                };
                if let Err(err) = spool.persist_blocked_record(&blocked) {
                    report.failed += 1;
                    record_error(report, err.class());
                    return Err(err.class());
                }
                report.blocked += 1;
                report.failed += 1;
                record_error(report, "archive_record_too_large");
                return Ok(persisted);
            }
            Err(err) => {
                report.failed += 1;
                record_error(report, err.class());
                return Err(err.class());
            }
        };
        if existing
            .iter()
            .any(|record| record.expected_record_count == pending.expected_record_count)
        {
            prior = Some(pending_checkpoint(&pending)?);
            continue;
        }
        if let Err(err) = spool.persist_slice(&pending) {
            report.failed += 1;
            record_error(report, err.class());
            return Err(err.class());
        }
        persisted += 1;
        prior = Some(pending_checkpoint(&pending)?);
    }
    Ok(persisted)
}

pub(crate) fn persist_snapshot(
    spool: &ArchiveSpool,
    snapshot: &ArchiveSnapshot,
    report: &mut ArchiveCycleReport,
    cancel: Option<&CancellationToken>,
    prefetched_source_bytes: Option<&[u8]>,
) -> Result<(), &'static str> {
    let loaded_source_bytes;
    let source_bytes = match prefetched_source_bytes {
        Some(bytes) => bytes,
        None => {
            loaded_source_bytes = snapshot_bytes(snapshot).map_err(|_| {
                report.failed += 1;
                record_error(report, "archive_io");
                "archive_io"
            })?;
            loaded_source_bytes.as_ref()
        }
    };
    persist_snapshot_bytes(spool, snapshot, source_bytes, report, cancel)
}

fn persist_snapshot_bytes(
    spool: &ArchiveSpool,
    snapshot: &ArchiveSnapshot,
    bytes: &[u8],
    report: &mut ArchiveCycleReport,
    cancel: Option<&CancellationToken>,
) -> Result<(), &'static str> {
    let persisted = persist_observed_slices(spool, snapshot, bytes, report, cancel)?;
    report.captured += persisted;
    Ok(())
}

pub(crate) fn snapshot_bytes(snapshot: &ArchiveSnapshot) -> std::io::Result<Cow<'_, [u8]>> {
    match &snapshot.deferred_file {
        Some(deferred) => read_capture_window(
            &deferred.path,
            deferred.prior_offset,
            deferred.minimum_observed_size,
        )
        .map(Cow::Owned),
        None => Ok(Cow::Borrowed(&snapshot.bytes)),
    }
}

pub(crate) enum UploadOutcome {
    Advanced,
    Blocked,
    Frozen,
    Purged,
    Halt(&'static str),
}

pub(crate) async fn upload_pending<U: ArchiveUploader>(
    uploader: &U,
    spool: &mut ArchiveSpool,
    key_store: &dyn ArchiveKeyStore,
    pending: &PendingArchiveRequest,
    source_bytes: Option<&[u8]>,
    cancel: Option<&CancellationToken>,
) -> Result<UploadOutcome, &'static str> {
    if let Some(blocked) = spool
        .blocked_part(
            pending.source,
            &pending.source_session_id,
            &pending.source_transcript_part_id,
        )
        .map_err(|err| err.class())?
    {
        if blocked.matches_pending(pending) {
            if source_bytes.is_none_or(|bytes| blocked.matches_source(bytes)) {
                return Ok(UploadOutcome::Blocked);
            }
            spool
                .clear_blocked_part(
                    pending.source,
                    &pending.source_session_id,
                    &pending.source_transcript_part_id,
                )
                .map_err(|err| err.class())?;
        }
    }
    match uploader.upload(pending.source, &pending.body, cancel).await {
        Ok(ack) => {
            if !acknowledgement_matches(pending, &ack) {
                return Err(ArchiveSyncError::AcknowledgementMismatch.class());
            }
            let checkpoint = pending_checkpoint(pending)?;
            spool
                .commit_acknowledgement(pending, &checkpoint)
                .map_err(|err| err.class())?;
            Ok(UploadOutcome::Advanced)
        }
        Err(err) if err.class() == "archive_record_too_large" => {
            let blocked = blocked_from_rejected_pending(pending, source_bytes)?;
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
