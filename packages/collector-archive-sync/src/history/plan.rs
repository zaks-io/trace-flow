use collector_archive::ArchiveSource;

use super::ArchiveHistoryState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveWorkClass {
    Live,
    Baseline,
}

#[derive(Debug, Clone, Default)]
pub struct ArchiveHistoryPlan {
    states: Vec<ArchiveHistoryState>,
    live_sessions: Vec<(ArchiveSource, String)>,
    present_parts: Vec<(ArchiveSource, String, String)>,
    failed_sources: Vec<ArchiveSource>,
}

impl ArchiveHistoryPlan {
    pub fn new(states: Vec<ArchiveHistoryState>) -> Self {
        Self {
            states,
            live_sessions: Vec::new(),
            present_parts: Vec::new(),
            failed_sources: Vec::new(),
        }
    }

    pub fn with_failed_sources(mut self, failed_sources: Vec<ArchiveSource>) -> Self {
        self.failed_sources = failed_sources;
        self
    }

    pub fn failed_sources(&self) -> &[ArchiveSource] {
        &self.failed_sources
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

    pub fn with_live_sessions(mut self, live_sessions: Vec<(ArchiveSource, String)>) -> Self {
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
        self.state(source)
            .is_some_and(|state| !state.excludes_session(source_session_id))
    }

    pub fn class_for(&self, source: ArchiveSource, source_session_id: &str) -> ArchiveWorkClass {
        if self
            .live_sessions
            .iter()
            .any(|(candidate_source, candidate_session)| {
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
        self.state(source)
            .and_then(|state| state.rank_of_session(source_session_id))
    }
}
