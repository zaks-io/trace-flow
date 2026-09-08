use crate::cycle::{
    record_error, ArchiveCycleReport, ArchiveInitialImport, ArchiveSnapshot,
    ArchiveSourceHistoryReport,
};
use crate::spool::ArchiveSpool;

use super::ArchiveHistoryPlan;

pub(crate) fn history_reports(
    spool: &ArchiveSpool,
    snapshots: &[ArchiveSnapshot],
    plan: &ArchiveHistoryPlan,
    retained_excluded: &[collector_archive::ArchiveSource],
    report: &mut ArchiveCycleReport,
) -> Vec<ArchiveSourceHistoryReport> {
    let mut reports: Vec<_> = plan
        .states()
        .map(|state| {
            let retained_excluded_pending = retained_excluded
                .iter()
                .filter(|source| **source == state.generation.source)
                .count() as u32;
            if state.generation.history_choice == crate::policy::ArchiveHistoryChoice::NewOnly {
                return ArchiveSourceHistoryReport {
                    source: state.generation.source,
                    initial_import: ArchiveInitialImport::NotApplicable,
                    registered_targets: 0,
                    completed_targets: 0,
                    retained_excluded_pending,
                };
            }
            let mut completed = 0u32;
            for target in state.targets() {
                if target.registered_complete_byte_offset == 0 {
                    completed += 1;
                    continue;
                }
                if let Ok(Some(progress)) = spool.progress_part(
                    state.generation.source,
                    &target.source_session_id,
                    &target.source_transcript_part_id,
                ) {
                    if progress.last_complete_byte_offset >= target.registered_complete_byte_offset
                    {
                        completed += 1;
                        continue;
                    }
                }
                if !snapshots.iter().any(|snapshot| {
                    snapshot.source == state.generation.source
                        && snapshot.source_session_id == target.source_session_id
                        && snapshot.source_transcript_part_id == target.source_transcript_part_id
                }) && !plan.part_is_present(
                    state.generation.source,
                    &target.source_session_id,
                    &target.source_transcript_part_id,
                ) {
                    report.failed += 1;
                    record_error(report, "archive_history_missing_baseline");
                }
            }
            ArchiveSourceHistoryReport {
                source: state.generation.source,
                initial_import: if completed == state.targets().len() as u32 {
                    ArchiveInitialImport::Complete
                } else {
                    ArchiveInitialImport::InProgress
                },
                registered_targets: state.targets().len() as u32,
                completed_targets: completed,
                retained_excluded_pending,
            }
        })
        .collect();
    reports.extend(plan.failed_sources().iter().copied().map(|source| {
        ArchiveSourceHistoryReport {
            source,
            initial_import: ArchiveInitialImport::InProgress,
            registered_targets: 0,
            completed_targets: 0,
            retained_excluded_pending: 0,
        }
    }));
    reports
}
