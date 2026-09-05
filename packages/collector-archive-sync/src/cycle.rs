use std::collections::HashSet;

use collector_archive::ArchiveSource;
use tokio_util::sync::CancellationToken;

use crate::ack::acknowledgement_matches;
use crate::bound::build_bounded_pending;
use crate::client::ArchiveUploader;
use crate::error::ArchiveSyncError;
use crate::key_store::ArchiveKeyStore;
use crate::policy::{policy_from_denial_reason, ArchivePolicy};
use crate::spool::{ArchiveSpool, PendingArchiveRequest, PendingLoad};

#[derive(Debug, Clone)]
pub struct ArchiveSnapshot {
    pub source: ArchiveSource,
    pub source_session_id: String,
    pub source_transcript_part_id: String,
    pub transcript_part_identity: Option<String>,
    pub bytes: Vec<u8>,
    pub observed_at: i64,
}

#[derive(Debug, Default, Clone)]
pub struct ArchiveCycleReport {
    pub uploaded: u32,
    pub failed: u32,
    pub captured: u32,
    pub purged: bool,
    pub frozen: bool,
    pub halted: bool,
    pub first_error: Option<String>,
}

pub async fn run_archive_cycle<U: ArchiveUploader>(
    uploader: &U,
    spool: &mut ArchiveSpool,
    key_store: &dyn ArchiveKeyStore,
    snapshots: &[ArchiveSnapshot],
    policy: ArchivePolicy,
    cancel: Option<&CancellationToken>,
) -> ArchiveCycleReport {
    let mut report = ArchiveCycleReport::default();
    if policy.purges() || spool.cleanup_required() {
        match spool.finish_cleanup(key_store) {
            Ok(()) => report.purged = true,
            Err(err) => {
                report.failed += 1;
                record_error(&mut report, err.class());
            }
        }
        return report;
    }
    if !policy.uploads() && !policy.captures() {
        return report;
    }

    if policy.uploads() {
        replay_pending(uploader, spool, key_store, &mut report, cancel).await;
        if report.purged || report.frozen || report.halted {
            return report;
        }
    }
    if !policy.captures() {
        return report;
    }

    for snapshot in snapshots {
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            break;
        }
        if spool.cleanup_required() {
            match spool.finish_cleanup(key_store) {
                Ok(()) => {
                    report.purged = true;
                    break;
                }
                Err(err) => {
                    report.failed += 1;
                    record_error(&mut report, err.class());
                    report.halted = true;
                    break;
                }
            }
        }
        if let Err(class) =
            capture_snapshot(uploader, spool, key_store, snapshot, &mut report, cancel).await
        {
            if class == "purged" {
                report.purged = true;
                break;
            }
            if class == "halt" {
                break;
            }
        }
        if report.purged || report.frozen || report.halted {
            break;
        }
    }
    report
}

async fn replay_pending<U: ArchiveUploader>(
    uploader: &U,
    spool: &mut ArchiveSpool,
    key_store: &dyn ArchiveKeyStore,
    report: &mut ArchiveCycleReport,
    cancel: Option<&CancellationToken>,
) {
    let pending = match spool.all_pending() {
        Ok(pending) => pending,
        Err(err) => {
            report.failed += 1;
            record_error(report, err.class());
            return;
        }
    };
    let mut blocked_parts = HashSet::new();
    for record in pending {
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            break;
        }
        match record {
            PendingLoad::Corrupt {
                source,
                source_session_id,
                source_transcript_part_id,
                class,
            } => {
                blocked_parts.insert((source, source_session_id, source_transcript_part_id));
                report.failed += 1;
                record_error(report, class);
            }
            PendingLoad::Ready(record) => {
                let part_key = (
                    record.source,
                    record.source_session_id.clone(),
                    record.source_transcript_part_id.clone(),
                );
                if blocked_parts.contains(&part_key) {
                    continue;
                }
                match upload_pending(uploader, spool, key_store, &record, cancel).await {
                    Ok(UploadOutcome::Advanced) => report.uploaded += 1,
                    Ok(UploadOutcome::Frozen) => {
                        report.frozen = true;
                        break;
                    }
                    Ok(UploadOutcome::Purged) => {
                        report.purged = true;
                        break;
                    }
                    Ok(UploadOutcome::Halt(class)) => {
                        report.failed += 1;
                        record_error(report, class);
                        report.halted = true;
                        break;
                    }
                    Err(class) => {
                        blocked_parts.insert(part_key);
                        report.failed += 1;
                        record_error(report, class);
                    }
                }
            }
        }
    }
}

async fn capture_snapshot<U: ArchiveUploader>(
    uploader: &U,
    spool: &mut ArchiveSpool,
    key_store: &dyn ArchiveKeyStore,
    snapshot: &ArchiveSnapshot,
    report: &mut ArchiveCycleReport,
    cancel: Option<&CancellationToken>,
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
    match persist_observed_slices(spool, snapshot, report, cancel) {
        Ok(persisted) => report.captured += persisted,
        Err(class) => {
            if class == "purged" || class == "halt" {
                return Err(class);
            }
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
        match upload_pending(uploader, spool, key_store, &pending, cancel).await {
            Ok(UploadOutcome::Advanced) => {
                report.uploaded += 1;
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
    report: &mut ArchiveCycleReport,
    cancel: Option<&CancellationToken>,
) -> Result<u32, &'static str> {
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
            &snapshot.bytes,
            snapshot.observed_at,
            prior.as_ref(),
        ) {
            Ok(Some(pending)) => pending,
            Ok(None) => break,
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

enum UploadOutcome {
    Advanced,
    Frozen,
    Purged,
    Halt(&'static str),
}

async fn upload_pending<U: ArchiveUploader>(
    uploader: &U,
    spool: &mut ArchiveSpool,
    key_store: &dyn ArchiveKeyStore,
    pending: &PendingArchiveRequest,
    cancel: Option<&CancellationToken>,
) -> Result<UploadOutcome, &'static str> {
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
            Some(ArchivePolicy::Frozen) | Some(ArchivePolicy::Grace) => Ok(UploadOutcome::Frozen),
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

fn record_error(report: &mut ArchiveCycleReport, class: &str) {
    if report.first_error.is_none() {
        report.first_error = Some(class.to_string());
    }
}
