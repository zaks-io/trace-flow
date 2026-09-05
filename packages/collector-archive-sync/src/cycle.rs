use collector_archive::ArchiveSource;
use tokio_util::sync::CancellationToken;

use crate::ack::acknowledgement_matches;
use crate::client::ArchiveUploader;
use crate::error::ArchiveSyncError;
use crate::key_store::ArchiveKeyStore;
use crate::policy::{policy_from_denial_reason, ArchivePolicy};
use crate::scan::scan_snapshot;
use crate::spool::{ArchiveSpool, PendingArchiveRequest};

#[derive(Debug, Clone)]
pub struct ArchiveSnapshot {
    pub source: ArchiveSource,
    pub source_session_id: String,
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
    if policy.purges() {
        if spool.purge(key_store).is_err() {
            record_error(&mut report, "archive_purge");
        } else {
            report.purged = true;
        }
        return report;
    }
    if !policy.uploads() && !policy.captures() {
        return report;
    }

    if policy.uploads() {
        if replay_pending(uploader, spool, key_store, &mut report, cancel)
            .await
            .is_err()
        {
            return report;
        }
        if report.purged || report.frozen {
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
        if let Err(class) =
            capture_snapshot(uploader, spool, key_store, snapshot, &mut report, cancel).await
        {
            if class == "purged" {
                report.purged = true;
                break;
            }
        }
        if report.purged || report.frozen {
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
) -> Result<(), ()> {
    let pending = match spool.all_pending() {
        Ok(pending) => pending,
        Err(err) => {
            report.failed += 1;
            record_error(report, err.class());
            return Err(());
        }
    };
    for record in pending {
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            break;
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
            Err(class) => {
                report.failed += 1;
                record_error(report, class);
            }
        }
    }
    Ok(())
}

async fn capture_snapshot<U: ArchiveUploader>(
    uploader: &U,
    spool: &mut ArchiveSpool,
    key_store: &dyn ArchiveKeyStore,
    snapshot: &ArchiveSnapshot,
    report: &mut ArchiveCycleReport,
    cancel: Option<&CancellationToken>,
) -> Result<(), &'static str> {
    if spool
        .pending(snapshot.source, &snapshot.source_session_id)
        .map_err(|err| {
            record_error(report, err.class());
            err.class()
        })?
        .is_some()
    {
        return Ok(());
    }
    let prior = spool
        .progress(snapshot.source, &snapshot.source_session_id)
        .map_err(|err| {
            record_error(report, err.class());
            err.class()
        })?;
    let scan = scan_snapshot(
        snapshot.source,
        &snapshot.source_session_id,
        &snapshot.bytes,
        snapshot.observed_at,
        prior.as_ref(),
    )
    .map_err(|err| {
        report.failed += 1;
        record_error(report, err.class());
        err.class()
    })?;
    if scan.observations.is_empty() {
        return Ok(());
    }
    let request = scan.into_upload_request(&snapshot.bytes).map_err(|err| {
        report.failed += 1;
        record_error(report, ArchiveSyncError::from(err).class());
        "archive_scan"
    })?;
    let body = serde_json::to_vec(&request).map_err(|_| {
        report.failed += 1;
        record_error(report, "archive_state");
        "archive_state"
    })?;
    let pending = PendingArchiveRequest {
        source: snapshot.source,
        source_session_id: snapshot.source_session_id.clone(),
        expected_record_count: request.checkpoint.record_count,
        body,
    };
    spool.persist_pending(&pending).map_err(|err| {
        report.failed += 1;
        record_error(report, err.class());
        err.class()
    })?;
    report.captured += 1;
    match upload_pending(uploader, spool, key_store, &pending, cancel).await {
        Ok(UploadOutcome::Advanced) => {
            report.uploaded += 1;
            Ok(())
        }
        Ok(UploadOutcome::Frozen) => {
            report.frozen = true;
            Ok(())
        }
        Ok(UploadOutcome::Purged) => Err("purged"),
        Err(class) => {
            report.failed += 1;
            record_error(report, class);
            Err(class)
        }
    }
}

enum UploadOutcome {
    Advanced,
    Frozen,
    Purged,
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
                .persist_progress(pending.source, &pending.source_session_id, &checkpoint)
                .map_err(|err| err.class())?;
            spool
                .clear_pending(pending.source, &pending.source_session_id)
                .map_err(|err| err.class())?;
            Ok(UploadOutcome::Advanced)
        }
        Err(err) => match err.denial_reason().and_then(policy_from_denial_reason) {
            Some(ArchivePolicy::Revoked) => {
                let _ = spool.purge(key_store);
                Ok(UploadOutcome::Purged)
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
