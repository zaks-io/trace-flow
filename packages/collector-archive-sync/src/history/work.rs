use std::collections::HashMap;

use collector_archive::ArchiveSource;

use crate::cycle::{record_error, ArchiveCycleReport, ArchiveSnapshot};
use crate::spool::{PendingArchiveRequest, PendingLoad};

use super::{ArchiveHistoryPlan, ArchiveWorkClass};

pub(crate) struct PartWork<'a> {
    pub source: ArchiveSource,
    pub session: String,
    pub part: String,
    pub pending: Vec<PendingArchiveRequest>,
    pub snapshot: Option<&'a ArchiveSnapshot>,
    class: ArchiveWorkClass,
    rank: Option<i64>,
    discovery_order: usize,
}

pub(crate) fn ordered_part_work<'a>(
    pending: Vec<PendingLoad>,
    snapshots: &'a [ArchiveSnapshot],
    plan: &ArchiveHistoryPlan,
    report: &mut ArchiveCycleReport,
) -> Vec<PartWork<'a>> {
    let pending_count = pending.len();
    let mut parts: HashMap<(ArchiveSource, String, String), PartWork<'a>> = HashMap::new();
    for (pending_order, record) in pending.into_iter().enumerate() {
        match record {
            PendingLoad::Corrupt {
                source,
                source_session_id,
                source_transcript_part_id: _,
                class,
            } => {
                if !plan.authorizes(source) || !plan.permits(source, &source_session_id) {
                    continue;
                }
                report.failed += 1;
                record_error(report, class);
            }
            PendingLoad::Ready(record) => {
                if !plan.permits(record.source, &record.source_session_id) {
                    continue;
                }
                let key = (
                    record.source,
                    record.source_session_id.clone(),
                    record.source_transcript_part_id.clone(),
                );
                let class = plan.class_for(record.source, &record.source_session_id);
                let rank = plan.rank_of(record.source, &record.source_session_id);
                parts
                    .entry(key)
                    .or_insert_with(|| PartWork {
                        source: record.source,
                        session: record.source_session_id.clone(),
                        part: record.source_transcript_part_id.clone(),
                        pending: Vec::new(),
                        snapshot: None,
                        class,
                        rank,
                        discovery_order: pending_order,
                    })
                    .pending
                    .push(record);
            }
        }
    }
    for (snapshot_order, snapshot) in snapshots.iter().enumerate() {
        if !plan.permits(snapshot.source, &snapshot.source_session_id) {
            continue;
        }
        let key = (
            snapshot.source,
            snapshot.source_session_id.clone(),
            snapshot.source_transcript_part_id.clone(),
        );
        let part = parts.entry(key).or_insert_with(|| PartWork {
            source: snapshot.source,
            session: snapshot.source_session_id.clone(),
            part: snapshot.source_transcript_part_id.clone(),
            pending: Vec::new(),
            snapshot: None,
            class: snapshot.class,
            rank: snapshot.activity_rank_ms,
            discovery_order: pending_count + snapshot_order,
        });
        part.snapshot = Some(snapshot);
        if part.pending.is_empty() {
            part.discovery_order = pending_count + snapshot_order;
        }
    }
    let mut work: Vec<_> = parts.into_values().collect();
    for part in &mut work {
        part.pending
            .sort_by_key(|pending| pending.expected_record_count);
    }
    work.sort_by(|left, right| {
        work_class_key(left.class)
            .cmp(&work_class_key(right.class))
            .then_with(|| {
                right
                    .rank
                    .unwrap_or(i64::MIN)
                    .cmp(&left.rank.unwrap_or(i64::MIN))
            })
            .then_with(|| left.discovery_order.cmp(&right.discovery_order))
            .then_with(|| left.source.as_str().cmp(right.source.as_str()))
            .then_with(|| left.session.cmp(&right.session))
            .then_with(|| left.part.cmp(&right.part))
    });
    work
}

fn work_class_key(class: ArchiveWorkClass) -> u8 {
    match class {
        ArchiveWorkClass::Live => 0,
        ArchiveWorkClass::Baseline => 1,
    }
}
