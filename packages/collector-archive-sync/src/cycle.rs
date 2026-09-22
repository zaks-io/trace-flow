use std::path::PathBuf;

use collector_archive::ArchiveSource;
use tokio_util::sync::CancellationToken;

use crate::capture::persist_snapshot;
use crate::history::{history_reports, ordered_part_work, ArchiveHistoryPlan, ArchiveWorkClass};
use crate::key_store::ArchiveKeyStore;
use crate::policy::ArchivePolicy;
use crate::spool::ArchiveSpool;

#[derive(Debug, Clone)]
pub struct ArchiveSnapshot {
    pub relative_path: Option<String>,
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
    pub expected_file_identity: Option<String>,
    pub expected_identity_prefix: Option<(u64, collector_archive::Sha256Digest)>,
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
fn capture_archive_snapshots_inner(
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
    if !policy.captures() {
        return report;
    }

    let work = ordered_part_work(Vec::new(), snapshots, plan, &mut report);
    for part in work {
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            break;
        }
        let Some(snapshot) = part.snapshot else {
            continue;
        };
        let Some(capture_authorization) = plan.capture_authorization(part.source, &part.session)
        else {
            continue;
        };
        let _ = persist_snapshot(
            spool,
            snapshot,
            &mut report,
            now_ms,
            cancel,
            None,
            capture_authorization,
        );
    }
    report
}

#[allow(clippy::too_many_arguments)]
pub fn capture_archive_snapshots(
    spool: &mut ArchiveSpool,
    key_store: &dyn ArchiveKeyStore,
    snapshots: &[ArchiveSnapshot],
    policy: ArchivePolicy,
    plan: &ArchiveHistoryPlan,
    now_ms: i64,
    cancel: Option<&CancellationToken>,
) -> ArchiveCycleReport {
    let mut report =
        capture_archive_snapshots_inner(spool, key_store, snapshots, policy, plan, now_ms, cancel);
    populate_history_report(spool, snapshots, plan, &mut report);
    report
}

fn populate_history_report(
    spool: &ArchiveSpool,
    snapshots: &[ArchiveSnapshot],
    plan: &ArchiveHistoryPlan,
    report: &mut ArchiveCycleReport,
) {
    let inventory =
        match spool.pending_inventory(|source, session| plan.pending_selection(source, session)) {
            Ok(inventory) => inventory,
            Err(error) => {
                report.failed += 1;
                record_error(report, error.class());
                return;
            }
        };
    for class in inventory.metadata_errors {
        if report.first_error.as_deref() != Some(class) {
            report.failed += 1;
            record_error(report, class);
        }
    }
    report.history = history_reports(spool, snapshots, plan, &inventory.retained_excluded, report);
}

pub(crate) fn record_error(report: &mut ArchiveCycleReport, class: &str) {
    if report.first_error.is_none() {
        report.first_error = Some(class.to_string());
    }
}
