use std::path::PathBuf;

use collector_archive::ArchiveSource;
use tokio_util::sync::CancellationToken;

use crate::capture::{
    capture_snapshot, persist_snapshot, snapshot_bytes, upload_pending, UploadOutcome,
};
use crate::client::ArchiveUploader;
use crate::history::{history_reports, ordered_part_work, ArchiveHistoryPlan, ArchiveWorkClass};
use crate::key_store::ArchiveKeyStore;
use crate::policy::ArchivePolicy;
use crate::spool::ArchiveSpool;

#[derive(Debug, Clone)]
pub struct ArchiveSnapshot {
    pub source: ArchiveSource,
    pub source_session_id: String,
    pub source_transcript_part_id: String,
    pub transcript_part_identity: Option<String>,
    pub bytes: Vec<u8>,
    pub deferred_file: Option<DeferredArchiveSnapshot>,
    pub observed_at: i64,
    pub class: ArchiveWorkClass,
    pub activity_rank_ms: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct DeferredArchiveSnapshot {
    pub path: PathBuf,
    pub prior_offset: u64,
    pub minimum_observed_size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveInitialImport {
    NotApplicable,
    InProgress,
    Complete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveSourceHistoryReport {
    pub source: ArchiveSource,
    pub initial_import: ArchiveInitialImport,
    pub registered_targets: u32,
    pub completed_targets: u32,
    pub retained_excluded_pending: u32,
    pub ambiguous_excluded_sessions: u32,
}

#[derive(Debug, Default, Clone)]
pub struct ArchiveCycleReport {
    pub uploaded: u32,
    pub failed: u32,
    pub captured: u32,
    pub purged: bool,
    pub frozen: bool,
    pub halted: bool,
    pub blocked: u32,
    pub first_error: Option<String>,
    pub history: Vec<ArchiveSourceHistoryReport>,
}

pub async fn run_archive_cycle<U: ArchiveUploader>(
    uploader: &U,
    spool: &mut ArchiveSpool,
    key_store: &dyn ArchiveKeyStore,
    snapshots: &[ArchiveSnapshot],
    policy: ArchivePolicy,
    plan: &ArchiveHistoryPlan,
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

    let pending = match spool.all_pending_permitted(|source, session| plan.permits(source, session))
    {
        Ok(pending) => pending,
        Err(err) => {
            report.failed += 1;
            record_error(&mut report, err.class());
            crate::spool::PendingLoads {
                loads: Vec::new(),
                retained_excluded: Vec::new(),
                metadata_errors: Vec::new(),
            }
        }
    };
    for class in &pending.metadata_errors {
        report.failed += 1;
        record_error(&mut report, class);
    }
    let work = ordered_part_work(pending.loads, snapshots, plan, &mut report);
    for part in work {
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
        let mut snapshot_read_failed = false;
        let source_bytes = if policy.uploads() && !part.pending.is_empty() {
            part.snapshot
                .and_then(|snapshot| match snapshot_bytes(snapshot) {
                    Ok(bytes) => Some(bytes),
                    Err(_) => {
                        snapshot_read_failed = true;
                        None
                    }
                })
        } else {
            None
        };
        if policy.uploads() {
            let mut pending_failed = false;
            let mut part_blocked = false;
            for pending in &part.pending {
                match upload_pending(
                    uploader,
                    spool,
                    key_store,
                    pending,
                    source_bytes.as_deref(),
                    cancel,
                )
                .await
                {
                    Ok(UploadOutcome::Advanced) => report.uploaded += 1,
                    Ok(UploadOutcome::Blocked) => {
                        part_blocked = true;
                        break;
                    }
                    Ok(UploadOutcome::Frozen) => report.frozen = true,
                    Ok(UploadOutcome::Purged) => report.purged = true,
                    Ok(UploadOutcome::Halt(class)) => {
                        report.failed += 1;
                        record_error(&mut report, class);
                        report.halted = true;
                    }
                    Err(class) => {
                        report.failed += 1;
                        record_error(&mut report, class);
                        pending_failed = true;
                        break;
                    }
                }
                if report.purged || report.frozen || report.halted {
                    break;
                }
            }
            if part_blocked {
                report.blocked += 1;
                if snapshot_read_failed {
                    report.failed += 1;
                    record_error(&mut report, "archive_io");
                }
                continue;
            }
            if pending_failed {
                if policy.captures() {
                    if let Some(snapshot) = part.snapshot {
                        let _ = persist_snapshot(
                            spool,
                            snapshot,
                            &mut report,
                            cancel,
                            source_bytes.as_deref(),
                        );
                    }
                }
                continue;
            }
        }
        if report.purged || report.frozen || report.halted {
            break;
        }
        let Some(snapshot) = part.snapshot else {
            continue;
        };
        if !policy.captures() {
            continue;
        }
        if let Err(class) = capture_snapshot(
            uploader,
            spool,
            key_store,
            snapshot,
            &mut report,
            cancel,
            source_bytes.as_deref(),
        )
        .await
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
    report.history = history_reports(
        spool,
        snapshots,
        plan,
        &pending.retained_excluded,
        &mut report,
    );
    report
}

pub(crate) fn record_error(report: &mut ArchiveCycleReport, class: &str) {
    if report.first_error.is_none() {
        report.first_error = Some(class.to_string());
    }
}
