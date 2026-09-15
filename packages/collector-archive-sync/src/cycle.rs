use std::path::PathBuf;

use collector_archive::ArchiveSource;
use tokio_util::sync::CancellationToken;

use crate::capture::{persist_snapshot, snapshot_bytes, upload_pending, UploadOutcome};
use crate::client::ArchiveUploader;
use crate::history::{history_reports, ordered_part_work, ArchiveHistoryPlan, ArchiveWorkClass};
use crate::key_store::ArchiveKeyStore;
use crate::policy::ArchivePolicy;
use crate::spool::ArchiveSpool;

#[derive(Debug, Clone)]
pub struct ArchiveSnapshot {
    pub source: ArchiveSource,
    pub source_session_id: String,
    pub base_transcript_part_id: String,
    pub source_transcript_part_id: String,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveForkEvent {
    pub source: ArchiveSource,
    pub source_session_id: String,
    pub previous_part_id: String,
    pub new_part_id: String,
    pub reason: String,
    pub previous_offset: u64,
    pub new_size: u64,
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
    pub forked: u32,
    pub fork_events: Vec<ArchiveForkEvent>,
    pub first_error: Option<String>,
    pub history: Vec<ArchiveSourceHistoryReport>,
}

#[allow(clippy::too_many_arguments)]
pub async fn run_archive_cycle<U: ArchiveUploader>(
    uploader: &U,
    spool: &mut ArchiveSpool,
    key_store: &dyn ArchiveKeyStore,
    snapshots: &[ArchiveSnapshot],
    policy: ArchivePolicy,
    plan: &ArchiveHistoryPlan,
    now_ms: i64,
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
        let source_bytes = if part.snapshot.is_some()
            && (policy.captures() || policy.uploads() && !part.pending.is_empty())
        {
            part.snapshot
                .and_then(|snapshot| match snapshot_bytes(snapshot) {
                    Ok(bytes) => Some(bytes),
                    Err(_) => {
                        snapshot_read_failed = true;
                        if policy.captures() {
                            report.failed += 1;
                            record_error(&mut report, "archive_io");
                        }
                        None
                    }
                })
        } else {
            None
        };
        if policy.captures() {
            if let (Some(snapshot), Some(source_bytes)) = (part.snapshot, source_bytes.as_deref()) {
                let blocked_before = report.blocked;
                let _ = persist_snapshot(
                    spool,
                    snapshot,
                    &mut report,
                    now_ms,
                    cancel,
                    Some(source_bytes),
                );
                if report.blocked > blocked_before {
                    continue;
                }
            }
        }
        if report.purged || report.frozen || report.halted {
            break;
        }
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            break;
        }
        if policy.uploads() {
            let upload_part = match part.snapshot {
                Some(snapshot) => match spool.current_part(
                    snapshot.source,
                    &snapshot.source_session_id,
                    &snapshot.base_transcript_part_id,
                ) {
                    Ok(current_part) => current_part,
                    Err(err) => {
                        report.failed += 1;
                        record_error(&mut report, err.class());
                        continue;
                    }
                },
                None => part.part.clone(),
            };
            let slices = match spool.slices_for_part(part.source, &part.session, &upload_part) {
                Ok(slices) => slices,
                Err(err) => {
                    report.failed += 1;
                    record_error(&mut report, err.class());
                    continue;
                }
            };
            let mut part_blocked = false;
            for pending in &slices {
                if cancel.is_some_and(CancellationToken::is_cancelled) {
                    break;
                }
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
                        if class == "archive_record_too_large" {
                            report.blocked += 1;
                        }
                        record_error(&mut report, class);
                        break;
                    }
                }
                if report.purged || report.frozen || report.halted {
                    break;
                }
            }
            if part_blocked {
                report.blocked += 1;
                if snapshot_read_failed && !policy.captures() {
                    report.failed += 1;
                    record_error(&mut report, "archive_io");
                }
                continue;
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
