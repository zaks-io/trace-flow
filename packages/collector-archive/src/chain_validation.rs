use crate::archive_wire::JsonlScan;
use crate::types::ArchiveSource;

use super::{ArchiveChain, ChainError};

impl ArchiveChain {
    pub(super) fn validate_scan_scope(&self, scan: &JsonlScan) -> Result<(), ChainError> {
        scan.checkpoint.validate()?;
        if scan.checkpoint.source != self.source
            || scan.checkpoint.source_session_id != self.source_session_id
        {
            return Err(ChainError::ScopeMismatch);
        }
        for observation in &scan.observations {
            observation.validate()?;
            self.validate_observation_scope(
                observation.source,
                &observation.source_session_id,
                &observation.source_transcript_part_id,
            )?;
            if observation.source_transcript_part_id != scan.checkpoint.source_transcript_part_id {
                return Err(ChainError::ScopeMismatch);
            }
        }
        Ok(())
    }

    pub(super) fn validate_observation_scope(
        &self,
        source: ArchiveSource,
        source_session_id: &str,
        source_transcript_part_id: &str,
    ) -> Result<(), ChainError> {
        if source != self.source || source_session_id != self.source_session_id {
            return Err(ChainError::ScopeMismatch);
        }
        if source_transcript_part_id.is_empty() {
            return Err(ChainError::ScopeMismatch);
        }
        Ok(())
    }
}
