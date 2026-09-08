use collector_archive::ArchiveSource;
use serde::{Deserialize, Serialize};

use crate::policy::ArchiveHistoryChoice;

pub const ARCHIVE_HISTORY_STATE_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveHistoryGeneration {
    pub source: ArchiveSource,
    pub history_choice: ArchiveHistoryChoice,
    pub authorized_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveBaselineTarget {
    pub source_session_id: String,
    pub source_transcript_part_id: String,
    pub activity_rank_ms: i64,
    pub registered_size_bytes: u64,
    pub registered_complete_byte_offset: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveHistoryState {
    pub version: u16,
    pub generation: ArchiveHistoryGeneration,
    pub committed_at: i64,
    pub entries: Vec<ArchiveBaselineTarget>,
}

impl ArchiveHistoryState {
    pub fn new(
        generation: ArchiveHistoryGeneration,
        committed_at: i64,
        mut entries: Vec<ArchiveBaselineTarget>,
    ) -> Self {
        sort_targets(&mut entries);
        Self {
            version: ARCHIVE_HISTORY_STATE_VERSION,
            generation,
            committed_at,
            entries,
        }
    }

    pub fn targets(&self) -> &[ArchiveBaselineTarget] {
        if self.generation.history_choice == ArchiveHistoryChoice::AllHistory {
            &self.entries
        } else {
            &[]
        }
    }

    pub fn excludes_session(&self, source_session_id: &str) -> bool {
        self.generation.history_choice == ArchiveHistoryChoice::NewOnly
            && self.contains_session(source_session_id)
    }

    pub fn contains_session(&self, source_session_id: &str) -> bool {
        self.entries
            .iter()
            .any(|target| target.source_session_id == source_session_id)
    }

    pub fn target(
        &self,
        source_session_id: &str,
        source_transcript_part_id: &str,
    ) -> Option<&ArchiveBaselineTarget> {
        self.entries.iter().find(|target| {
            target.source_session_id == source_session_id
                && target.source_transcript_part_id == source_transcript_part_id
        })
    }

    pub fn rank_of_session(&self, source_session_id: &str) -> Option<i64> {
        self.entries
            .iter()
            .filter(|target| target.source_session_id == source_session_id)
            .map(|target| target.activity_rank_ms)
            .max()
    }

    pub fn register(&mut self, target: ArchiveBaselineTarget) -> bool {
        if self
            .target(&target.source_session_id, &target.source_transcript_part_id)
            .is_some()
        {
            return false;
        }
        self.entries.push(target);
        sort_targets(&mut self.entries);
        true
    }
}

fn sort_targets(targets: &mut [ArchiveBaselineTarget]) {
    targets.sort_by(|left, right| {
        right
            .activity_rank_ms
            .cmp(&left.activity_rank_ms)
            .then_with(|| left.source_session_id.cmp(&right.source_session_id))
            .then_with(|| {
                left.source_transcript_part_id
                    .cmp(&right.source_transcript_part_id)
            })
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(session: &str, part: &str, rank: i64) -> ArchiveBaselineTarget {
        ArchiveBaselineTarget {
            source_session_id: session.to_string(),
            source_transcript_part_id: part.to_string(),
            activity_rank_ms: rank,
            registered_size_bytes: 10,
            registered_complete_byte_offset: 10,
        }
    }

    #[test]
    fn all_history_targets_are_stably_ranked() {
        let generation = ArchiveHistoryGeneration {
            source: ArchiveSource::Codex,
            history_choice: ArchiveHistoryChoice::AllHistory,
            authorized_at: 5,
        };
        let state = ArchiveHistoryState::new(
            generation,
            6,
            vec![target("old", "p", 1), target("new", "p", 9)],
        );
        assert_eq!(state.targets()[0].source_session_id, "new");
        assert!(!state.excludes_session("old"));
    }

    #[test]
    fn new_only_exclusion_is_session_grained() {
        let generation = ArchiveHistoryGeneration {
            source: ArchiveSource::Claude,
            history_choice: ArchiveHistoryChoice::NewOnly,
            authorized_at: 5,
        };
        let state = ArchiveHistoryState::new(generation, 6, vec![target("existing", "p", 1)]);
        assert!(state.targets().is_empty());
        assert!(state.excludes_session("existing"));
        assert!(!state.excludes_session("new"));
    }
}
