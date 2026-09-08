mod copies;
mod identity;
#[cfg(test)]
mod tests;
mod window;

use std::collections::HashMap;
use std::path::Path;

use collector_archive::ArchiveSource;
use collector_archive_sync::{
    ArchiveAuthorizedSource, ArchiveHistoryChoice, ArchiveHistoryGeneration, ArchiveHistoryPlan,
    ArchiveHistoryState, ArchiveSnapshot, ArchiveSpool, ArchiveWorkClass, DeferredArchiveSnapshot,
    ARCHIVE_HISTORY_STATE_VERSION,
};
use collector_contracts::AgentSource;
use collector_sync::walk_transcripts;

use crate::sources::archive_source_roots;

use self::copies::prefix_compatible;
use self::identity::{identify, target_from, Candidate};
use self::window::{ARCHIVE_BASELINE_PARTS_PER_CYCLE, ARCHIVE_BASELINE_READ_BUDGET_BYTES};

#[derive(Debug, Default)]
pub struct PreparedArchiveHistory {
    pub plan: ArchiveHistoryPlan,
    pub snapshots: Vec<ArchiveSnapshot>,
    pub errors: Vec<String>,
}

pub fn prepare(
    home: &Path,
    spool: &ArchiveSpool,
    authorizations: &[ArchiveAuthorizedSource],
    now_ms: i64,
) -> PreparedArchiveHistory {
    let mut prepared = PreparedArchiveHistory::default();
    let mut states = Vec::new();
    let mut live_sessions = Vec::new();
    let mut present_parts = Vec::new();
    let mut failed_sources = Vec::new();
    for authorization in authorizations {
        let candidates = discover(home, authorization.source, &mut prepared.errors);
        let generation = ArchiveHistoryGeneration {
            source: authorization.source,
            history_choice: authorization.history_choice,
            authorized_at: authorization.authorized_at,
        };
        let loaded = match spool.history_state(authorization.source) {
            Ok(state) => state,
            Err(_) => {
                prepared.errors.push("archive_history_corrupt".to_string());
                failed_sources.push(authorization.source);
                continue;
            }
        };
        if loaded
            .as_ref()
            .is_some_and(|state| state.version != ARCHIVE_HISTORY_STATE_VERSION)
        {
            prepared
                .errors
                .push("archive_history_unsupported_version".to_string());
            failed_sources.push(authorization.source);
            continue;
        }
        let reset = loaded
            .as_ref()
            .is_none_or(|state| state.generation != generation);
        let mut state = if reset {
            ArchiveHistoryState::new(
                generation,
                now_ms,
                candidates.iter().map(target_from).collect(),
            )
        } else {
            loaded.expect("checked present generation")
        };
        let mut state_changed = reset;
        if !reset && authorization.history_choice == ArchiveHistoryChoice::AllHistory {
            for candidate in &candidates {
                state_changed |= state.register(target_from(candidate));
            }
        }
        if !reset && authorization.history_choice == ArchiveHistoryChoice::NewOnly {
            for candidate in &candidates {
                if candidate
                    .started_at
                    .is_some_and(|started| started <= authorization.authorized_at)
                {
                    state_changed |= state.register(target_from(candidate));
                }
            }
        }
        if state_changed && spool.commit_history_state(&state).is_err() {
            prepared
                .errors
                .push("archive_history_uncommitted".to_string());
            failed_sources.push(authorization.source);
            continue;
        }

        let mut scheduled = Vec::new();
        for candidate in candidates {
            present_parts.push((
                candidate.source,
                candidate.session.clone(),
                candidate.part.clone(),
            ));
            let is_live = candidate
                .started_at
                .is_some_and(|started| started > authorization.authorized_at);
            let permitted = match authorization.history_choice {
                ArchiveHistoryChoice::AllHistory => true,
                ArchiveHistoryChoice::NewOnly => {
                    !state.excludes_session(&candidate.session) && is_live
                }
            };
            if authorization.history_choice == ArchiveHistoryChoice::NewOnly
                && candidate.started_at.is_none()
            {
                prepared
                    .errors
                    .push("archive_history_ambiguous".to_string());
            }
            if !permitted {
                continue;
            }
            if is_live {
                live_sessions.push((
                    candidate.source,
                    candidate.session.clone(),
                    candidate.activity_rank_ms,
                ));
            }
            scheduled.push(candidate);
        }
        append_snapshots(spool, &state, scheduled, &mut prepared, &live_sessions);
        states.push(state);
    }
    prepared.plan = ArchiveHistoryPlan::new(states)
        .with_live_sessions(live_sessions)
        .with_present_parts(present_parts)
        .with_failed_sources(failed_sources);
    prepared
}

fn discover(home: &Path, source: ArchiveSource, errors: &mut Vec<String>) -> Vec<Candidate> {
    let agent_source = match source {
        ArchiveSource::Claude => AgentSource::Claude,
        ArchiveSource::Codex => AgentSource::Codex,
    };
    let mut groups: HashMap<(String, String), Vec<Candidate>> = HashMap::new();
    for root in archive_source_roots(home, agent_source) {
        for file in walk_transcripts(&root) {
            match identify(source, &file.path, file.mtime_ms as i64, file.size_bytes) {
                Ok(candidate) => groups
                    .entry((candidate.session.clone(), candidate.part.clone()))
                    .or_default()
                    .push(candidate),
                Err(class) => errors.push(class.to_string()),
            }
        }
    }
    let mut candidates = Vec::new();
    for mut copies in groups.into_values() {
        copies.sort_by(|left, right| {
            right
                .size
                .cmp(&left.size)
                .then_with(|| left.path.cmp(&right.path))
        });
        let mut representative = copies.remove(0);
        representative.copies = copies.into_iter().map(|copy| copy.path).collect();
        candidates.push(representative);
    }
    candidates
}

fn append_snapshots(
    spool: &ArchiveSpool,
    state: &ArchiveHistoryState,
    mut candidates: Vec<Candidate>,
    prepared: &mut PreparedArchiveHistory,
    live_sessions: &[(ArchiveSource, String, i64)],
) {
    candidates.sort_by(|left, right| {
        let left_live = live_sessions
            .iter()
            .any(|(source, session, _)| *source == left.source && session == &left.session);
        let right_live = live_sessions
            .iter()
            .any(|(source, session, _)| *source == right.source && session == &right.session);
        right_live
            .cmp(&left_live)
            .then_with(|| right.activity_rank_ms.cmp(&left.activity_rank_ms))
            .then_with(|| left.session.cmp(&right.session))
            .then_with(|| left.part.cmp(&right.part))
    });
    let mut baseline_parts = 0usize;
    let mut baseline_bytes = 0u64;
    for candidate in candidates {
        let class = if live_sessions.iter().any(|(source, session, _)| {
            *source == candidate.source && session == &candidate.session
        }) {
            ArchiveWorkClass::Live
        } else {
            ArchiveWorkClass::Baseline
        };
        let progress = spool
            .progress_part(candidate.source, &candidate.session, &candidate.part)
            .ok()
            .flatten();
        if progress.as_ref().is_some_and(|checkpoint| {
            checkpoint.last_complete_byte_offset >= candidate.complete_extent
        }) {
            continue;
        }
        if class == ArchiveWorkClass::Baseline {
            let exceeds_read_budget =
                baseline_bytes.saturating_add(candidate.size) > ARCHIVE_BASELINE_READ_BUDGET_BYTES;
            if baseline_parts >= ARCHIVE_BASELINE_PARTS_PER_CYCLE
                || (baseline_parts > 0 && exceeds_read_budget)
            {
                continue;
            }
        }
        let copies_match = candidate
            .copies
            .iter()
            .all(|copy| prefix_compatible(copy, &candidate.path).unwrap_or(false));
        if !copies_match {
            prepared
                .errors
                .push("archive_history_divergent_copy".to_string());
            continue;
        }
        let prior = progress
            .as_ref()
            .map(|checkpoint| checkpoint.last_complete_byte_offset)
            .unwrap_or(0);
        let minimum_observed_size = progress
            .as_ref()
            .map(|checkpoint| checkpoint.observed_file_size)
            .unwrap_or(0);
        if class == ArchiveWorkClass::Baseline {
            baseline_parts += 1;
            baseline_bytes = baseline_bytes.saturating_add(candidate.size);
        }
        let activity_rank_ms = if class == ArchiveWorkClass::Live {
            Some(candidate.activity_rank_ms)
        } else {
            state.rank_of_session(&candidate.session)
        };
        prepared.snapshots.push(ArchiveSnapshot {
            source: candidate.source,
            source_session_id: candidate.session,
            source_transcript_part_id: candidate.part,
            transcript_part_identity: candidate.part_identity,
            bytes: Vec::new(),
            deferred_file: Some(DeferredArchiveSnapshot {
                path: candidate.path,
                prior_offset: prior,
                minimum_observed_size,
            }),
            observed_at: candidate.activity_rank_ms,
            class,
            activity_rank_ms,
        });
    }
}
