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
                    ambiguous_excluded_sessions: plan.ambiguous_excluded(state.generation.source),
                };
            }
            let mut completed = 0u32;
            for target in state.targets() {
                if target.registered_complete_byte_offset == 0 && target.registered_size_bytes == 0
                {
                    completed += 1;
                    continue;
                }
                let generation = match spool.generation_record(
                    state.generation.source,
                    &target.source_session_id,
                    &target.source_transcript_part_id,
                ) {
                    Ok(generation) => generation,
                    Err(err) => {
                        report.failed += 1;
                        record_error(report, err.class());
                        continue;
                    }
                };
                let (part, required_offset) = match &generation {
                    Some(generation) => {
                        let rewritten = generation
                            .history
                            .iter()
                            .any(|entry| entry.reason != "byte_capture");
                        let required = if rewritten {
                            plan.complete_extent(
                                state.generation.source,
                                &target.source_session_id,
                                &target.source_transcript_part_id,
                            )
                        } else {
                            Some(target.registered_size_bytes)
                        };
                        (generation.current_part_id.clone(), required)
                    }
                    None => (
                        target.source_transcript_part_id.clone(),
                        Some(target.registered_complete_byte_offset),
                    ),
                };
                let captured = match spool.latest_captured_checkpoint(
                    state.generation.source,
                    &target.source_session_id,
                    &part,
                ) {
                    Ok(captured) => captured,
                    Err(error) => {
                        report.failed += 1;
                        record_error(report, error.class());
                        continue;
                    }
                };
                let required_offset =
                    required_offset.or_else(|| captured.as_ref().map(|p| p.observed_file_size));
                let predecessors_complete = match predecessors_acknowledged(
                    spool,
                    state.generation.source,
                    &target.source_session_id,
                    generation.as_ref(),
                ) {
                    Ok(complete) => complete,
                    Err(error) => {
                        report.failed += 1;
                        record_error(report, error.class());
                        continue;
                    }
                };
                let progress = match spool.progress_part(
                    state.generation.source,
                    &target.source_session_id,
                    &part,
                ) {
                    Ok(progress) => progress,
                    Err(err) => {
                        report.failed += 1;
                        record_error(report, err.class());
                        continue;
                    }
                };
                if predecessors_complete
                    && required_offset.is_some_and(|required_offset| {
                        progress.is_some_and(|progress| {
                            progress.last_complete_byte_offset >= required_offset
                        })
                    })
                {
                    completed += 1;
                    continue;
                }
                if !snapshots.iter().any(|snapshot| {
                    snapshot.source == state.generation.source
                        && snapshot.source_session_id == target.source_session_id
                        && snapshot.base_transcript_part_id == target.source_transcript_part_id
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
                initial_import: if completed == state.targets().len() as u32
                    && plan.discovery_errors(state.generation.source) == 0
                {
                    ArchiveInitialImport::Complete
                } else {
                    ArchiveInitialImport::InProgress
                },
                registered_targets: state.targets().len() as u32,
                completed_targets: completed,
                retained_excluded_pending,
                ambiguous_excluded_sessions: plan.ambiguous_excluded(state.generation.source),
            }
        })
        .collect();
    reports.extend(plan.failed_sources().iter().copied().map(|source| {
        let retained_excluded_pending = retained_excluded
            .iter()
            .filter(|retained_source| **retained_source == source)
            .count() as u32;
        ArchiveSourceHistoryReport {
            source,
            initial_import: ArchiveInitialImport::InProgress,
            registered_targets: 0,
            completed_targets: 0,
            retained_excluded_pending,
            ambiguous_excluded_sessions: plan.ambiguous_excluded(source),
        }
    }));
    reports
}

fn predecessors_acknowledged(
    spool: &ArchiveSpool,
    source: collector_archive::ArchiveSource,
    session: &str,
    generation: Option<&crate::ArchiveGenerationRecord>,
) -> crate::ArchiveSyncResult<bool> {
    let Some(generation) = generation else {
        return Ok(true);
    };
    for entry in &generation.history {
        let captured = spool.latest_captured_checkpoint(source, session, &entry.part_id)?;
        let progress = spool.progress_part(source, session, &entry.part_id)?;
        match (captured, progress) {
            (Some(captured), Some(progress)) => {
                let required = if captured.archive_format_version() == 2 {
                    captured.observed_file_size
                } else {
                    captured.last_complete_byte_offset
                };
                if progress.last_complete_byte_offset < required {
                    return Ok(false);
                }
            }
            (None, None) => {}
            _ => return Ok(false),
        }
    }
    Ok(true)
}
