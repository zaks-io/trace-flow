use collector_archive::ArchiveSource;

use super::ArchiveHistoryState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveWorkClass {
    Live,
    Baseline,
}

#[cfg(test)]
mod tests {
    use crate::history::ArchiveHistoryGeneration;
    use crate::policy::ArchiveHistoryChoice;

    use super::*;

    #[test]
    fn new_only_pending_requires_current_positive_session_proof() {
        let state = ArchiveHistoryState::new(
            ArchiveHistoryGeneration {
                source: ArchiveSource::Codex,
                history_choice: ArchiveHistoryChoice::NewOnly,
                authorized_at: 10,
            },
            10,
            Vec::new(),
        );
        let pending_only = ArchiveHistoryPlan::new(vec![state.clone()]);
        assert!(!pending_only.permits(ArchiveSource::Codex, "new-session"));

        let proven = ArchiveHistoryPlan::new(vec![state]).with_live_sessions(vec![(
            ArchiveSource::Codex,
            "new-session".to_string(),
            20,
        )]);
        assert!(proven.permits(ArchiveSource::Codex, "new-session"));
    }
}

#[derive(Debug, Clone, Default)]
pub struct ArchiveHistoryPlan {
    states: Vec<ArchiveHistoryState>,
    live_sessions: Vec<(ArchiveSource, String, i64)>,
    present_parts: Vec<(ArchiveSource, String, String)>,
    failed_sources: Vec<ArchiveSource>,
    ambiguous_excluded: Vec<(ArchiveSource, u32)>,
}

impl ArchiveHistoryPlan {
    pub fn new(states: Vec<ArchiveHistoryState>) -> Self {
        Self {
            states,
            live_sessions: Vec::new(),
            present_parts: Vec::new(),
            failed_sources: Vec::new(),
            ambiguous_excluded: Vec::new(),
        }
    }

    pub fn with_failed_sources(mut self, failed_sources: Vec<ArchiveSource>) -> Self {
        self.failed_sources = failed_sources;
        self
    }

    pub fn failed_sources(&self) -> &[ArchiveSource] {
        &self.failed_sources
    }

    pub fn with_ambiguous_excluded(
        mut self,
        ambiguous_excluded: Vec<(ArchiveSource, u32)>,
    ) -> Self {
        self.ambiguous_excluded = ambiguous_excluded;
        self
    }

    pub fn ambiguous_excluded(&self, source: ArchiveSource) -> u32 {
        self.ambiguous_excluded
            .iter()
            .find(|(candidate_source, _)| *candidate_source == source)
            .map_or(0, |(_, count)| *count)
    }

    pub fn with_present_parts(
        mut self,
        present_parts: Vec<(ArchiveSource, String, String)>,
    ) -> Self {
        self.present_parts = present_parts;
        self
    }

    pub fn part_is_present(
        &self,
        source: ArchiveSource,
        source_session_id: &str,
        source_transcript_part_id: &str,
    ) -> bool {
        self.present_parts
            .iter()
            .any(|(candidate_source, session, part)| {
                *candidate_source == source
                    && session == source_session_id
                    && part == source_transcript_part_id
            })
    }

    pub fn with_live_sessions(mut self, live_sessions: Vec<(ArchiveSource, String, i64)>) -> Self {
        self.live_sessions = live_sessions;
        self
    }

    pub fn state(&self, source: ArchiveSource) -> Option<&ArchiveHistoryState> {
        self.states
            .iter()
            .find(|state| state.generation.source == source)
    }

    pub fn states(&self) -> impl Iterator<Item = &ArchiveHistoryState> {
        self.states.iter()
    }

    pub fn authorizes(&self, source: ArchiveSource) -> bool {
        self.state(source).is_some()
    }

    pub fn permits(&self, source: ArchiveSource, source_session_id: &str) -> bool {
        self.state(source).is_some_and(|state| {
            !state.excludes_session(source_session_id)
                && (state.generation.history_choice
                    == crate::policy::ArchiveHistoryChoice::AllHistory
                    || self.live_sessions.iter().any(|(live_source, session, _)| {
                        *live_source == source && session == source_session_id
                    }))
        })
    }

    pub fn class_for(&self, source: ArchiveSource, source_session_id: &str) -> ArchiveWorkClass {
        if self
            .live_sessions
            .iter()
            .any(|(candidate_source, candidate_session, _)| {
                *candidate_source == source && candidate_session == source_session_id
            })
        {
            return ArchiveWorkClass::Live;
        }
        if self
            .state(source)
            .is_some_and(|state| state.contains_session(source_session_id))
        {
            ArchiveWorkClass::Baseline
        } else {
            ArchiveWorkClass::Live
        }
    }

    pub fn rank_of(&self, source: ArchiveSource, source_session_id: &str) -> Option<i64> {
        self.live_sessions
            .iter()
            .find(|(live_source, session, _)| {
                *live_source == source && session == source_session_id
            })
            .map(|(_, _, rank)| *rank)
            .or_else(|| {
                self.state(source)
                    .and_then(|state| state.rank_of_session(source_session_id))
            })
    }
}
