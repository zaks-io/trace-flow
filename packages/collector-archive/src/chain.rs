use crate::elements::{ArchiveRecord, ChainElement, CommittedScanCheckpoint};
use crate::framing::{checkpoint_chain_hash, record_chain_hash};
use crate::jsonl::JsonlScan;
use crate::types::{
    validate_versions, ArchiveError, ArchiveObservation, ArchiveSource, CompletedScanCheckpoint,
    Sha256Digest, GENESIS_CHAIN_HASH,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitReport {
    pub appended_records: usize,
    pub appended_checkpoint: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveChain {
    pub source: ArchiveSource,
    pub source_session_id: String,
    pub elements: Vec<ChainElement>,
}

impl ArchiveChain {
    pub fn new(
        source: ArchiveSource,
        source_session_id: impl Into<String>,
    ) -> Result<Self, ArchiveError> {
        let source_session_id = source_session_id.into();
        crate::types::validate_identifier(&source_session_id, "source_session_id")?;
        Ok(Self {
            source,
            source_session_id,
            elements: Vec::new(),
        })
    }

    pub fn chain_head(&self) -> Sha256Digest {
        self.elements
            .last()
            .map(ChainElement::chain_hash)
            .unwrap_or(GENESIS_CHAIN_HASH)
    }

    /// Serialize the canonical chain as newline-delimited JSON without changing any payload bytes.
    pub fn to_jsonl(&self) -> Result<Vec<u8>, ArchiveError> {
        let mut output = Vec::new();
        for element in &self.elements {
            output.extend_from_slice(&serde_json::to_vec(element)?);
            output.push(b'\n');
        }
        Ok(output)
    }

    pub fn from_jsonl(
        source: ArchiveSource,
        source_session_id: impl Into<String>,
        bytes: &[u8],
    ) -> Result<Self, ChainError> {
        let mut chain = Self::new(source, source_session_id)?;
        for line in bytes.split(|byte| *byte == b'\n') {
            if line.is_empty() {
                continue;
            }
            chain
                .elements
                .push(serde_json::from_slice(line).map_err(ArchiveError::Serialization)?);
        }
        chain.verify()?;
        Ok(chain)
    }

    pub fn latest_checkpoint(&self) -> Option<&CompletedScanCheckpoint> {
        self.elements
            .iter()
            .rev()
            .find_map(|element| match element {
                ChainElement::Checkpoint(checkpoint) => Some(&checkpoint.checkpoint),
                ChainElement::Record(_) => None,
            })
    }

    pub fn commit_observation(
        &mut self,
        observation: &ArchiveObservation,
    ) -> Result<bool, ChainError> {
        observation.validate()?;
        self.validate_observation_scope(
            observation.source,
            &observation.source_session_id,
            &observation.source_transcript_part_id,
        )?;
        let key_exists = self.elements.iter().any(|element| {
            matches!(element, ChainElement::Record(record)
                if record.source_transcript_part_id == observation.source_transcript_part_id
                    && record.source_record_identity == observation.source_record_identity
                    && record.content_sha256 == observation.content_sha256)
        });
        if key_exists {
            return Ok(false);
        }
        let sequence = self.elements.len() as u64;
        let previous_chain_hash = self.chain_head();
        let chain_hash = record_chain_hash(previous_chain_hash, sequence, observation);
        self.elements.push(ChainElement::Record(ArchiveRecord {
            archive_format_version: observation.archive_format_version,
            chain_hash_version: observation.chain_hash_version,
            source: observation.source,
            source_session_id: observation.source_session_id.clone(),
            source_transcript_part_id: observation.source_transcript_part_id.clone(),
            source_record_identity: observation.source_record_identity.clone(),
            observed_at: observation.observed_at,
            payload_encoding: observation.payload_encoding,
            payload: observation.payload.clone(),
            content_sha256: observation.content_sha256,
            chain_sequence: sequence,
            previous_chain_hash,
            chain_hash,
        }));
        Ok(true)
    }

    pub fn commit_scan(&mut self, scan: &JsonlScan) -> Result<CommitReport, ChainError> {
        let mut candidate = self.clone();
        let report = candidate.commit_scan_in_place(scan)?;
        *self = candidate;
        Ok(report)
    }

    fn commit_scan_in_place(&mut self, scan: &JsonlScan) -> Result<CommitReport, ChainError> {
        self.validate_scan_scope(scan)?;
        if scan.checkpoint.record_count != scan.observations.len() as u64
            || scan.checkpoint.last_source_record_identity
                != scan
                    .observations
                    .last()
                    .map(|observation| observation.source_record_identity.clone())
        {
            return Err(ChainError::CheckpointDoesNotDescribeScan);
        }
        if let Some(previous) = self
            .latest_checkpoint_for_part(&scan.checkpoint.source_transcript_part_id)
            .cloned()
        {
            if scan.checkpoint.same_logical_position(&previous) && scan.prior_checkpoint.is_none() {
                if scan
                    .observations
                    .iter()
                    .all(|observation| self.has_record_version(observation))
                {
                    return Ok(CommitReport {
                        appended_records: 0,
                        appended_checkpoint: false,
                    });
                }
                return Err(ChainError::MissingHistoricalPrefixProof);
            }
            if scan.prior_checkpoint.as_ref() != Some(&previous) {
                return Err(ChainError::MissingHistoricalPrefixProof);
            }
            if scan.checkpoint.last_complete_byte_offset < previous.last_complete_byte_offset {
                return Err(ChainError::CheckpointRegressed);
            }
            if scan.checkpoint.record_count < previous.record_count {
                return Err(ChainError::CheckpointRecordCountRegressed);
            }
        }
        let mut appended_records = 0;
        for observation in &scan.observations {
            if self.commit_observation(observation)? {
                appended_records += 1;
            }
        }
        let appended_checkpoint = self.should_append_checkpoint(&scan.checkpoint);
        if appended_checkpoint {
            self.append_checkpoint(scan.checkpoint.clone())?;
        }
        Ok(CommitReport {
            appended_records,
            appended_checkpoint,
        })
    }

    pub fn verify(&self) -> Result<(), ChainError> {
        let mut previous_chain_hash = GENESIS_CHAIN_HASH;
        for (expected_sequence, element) in self.elements.iter().enumerate() {
            if element.chain_sequence() != expected_sequence as u64 {
                return Err(ChainError::SequenceMismatch {
                    expected: expected_sequence as u64,
                    actual: element.chain_sequence(),
                });
            }
            match element {
                ChainElement::Record(record) => {
                    validate_versions(record.archive_format_version, record.chain_hash_version)?;
                    if record.source != self.source
                        || record.source_session_id != self.source_session_id
                    {
                        return Err(ChainError::ScopeMismatch);
                    }
                    let observation = ArchiveObservation {
                        archive_format_version: record.archive_format_version,
                        chain_hash_version: record.chain_hash_version,
                        source: record.source,
                        source_session_id: record.source_session_id.clone(),
                        source_transcript_part_id: record.source_transcript_part_id.clone(),
                        source_record_identity: record.source_record_identity.clone(),
                        observed_at: record.observed_at,
                        payload_encoding: record.payload_encoding,
                        payload: record.payload.clone(),
                        content_sha256: record.content_sha256,
                    };
                    observation.validate()?;
                    let expected =
                        record_chain_hash(previous_chain_hash, record.chain_sequence, &observation);
                    if record.previous_chain_hash != previous_chain_hash
                        || record.chain_hash != expected
                    {
                        return Err(ChainError::HashMismatch {
                            sequence: record.chain_sequence,
                        });
                    }
                }
                ChainElement::Checkpoint(checkpoint) => {
                    validate_versions(
                        checkpoint.archive_format_version,
                        checkpoint.chain_hash_version,
                    )?;
                    checkpoint.checkpoint.validate()?;
                    if checkpoint.source != self.source
                        || checkpoint.source_session_id != self.source_session_id
                        || checkpoint.source_transcript_part_id
                            != checkpoint.checkpoint.source_transcript_part_id
                        || checkpoint.checkpoint.source != self.source
                        || checkpoint.checkpoint.source_session_id != self.source_session_id
                        || checkpoint.archive_format_version
                            != checkpoint.checkpoint.archive_format_version
                        || checkpoint.chain_hash_version != checkpoint.checkpoint.chain_hash_version
                    {
                        return Err(ChainError::WrapperMismatch);
                    }
                    let expected = checkpoint_chain_hash(
                        previous_chain_hash,
                        checkpoint.chain_sequence,
                        checkpoint,
                    );
                    if checkpoint.previous_chain_hash != previous_chain_hash
                        || checkpoint.chain_hash != expected
                    {
                        return Err(ChainError::HashMismatch {
                            sequence: checkpoint.chain_sequence,
                        });
                    }
                }
            }
            previous_chain_hash = element.chain_hash();
        }
        Ok(())
    }

    fn validate_scan_scope(&self, scan: &JsonlScan) -> Result<(), ChainError> {
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

    fn validate_observation_scope(
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

    fn should_append_checkpoint(&self, checkpoint: &CompletedScanCheckpoint) -> bool {
        let Some(previous) = self.latest_checkpoint_for_part(&checkpoint.source_transcript_part_id)
        else {
            return true;
        };
        !checkpoint.same_logical_position(previous)
    }

    fn append_checkpoint(&mut self, checkpoint: CompletedScanCheckpoint) -> Result<(), ChainError> {
        let sequence = self.elements.len() as u64;
        let previous_chain_hash = self.chain_head();
        let mut committed = CommittedScanCheckpoint {
            archive_format_version: checkpoint.archive_format_version,
            chain_hash_version: checkpoint.chain_hash_version,
            source: checkpoint.source,
            source_session_id: checkpoint.source_session_id.clone(),
            source_transcript_part_id: checkpoint.source_transcript_part_id.clone(),
            checkpoint,
            chain_sequence: sequence,
            previous_chain_hash,
            chain_hash: GENESIS_CHAIN_HASH,
        };
        committed.chain_hash = checkpoint_chain_hash(previous_chain_hash, sequence, &committed);
        self.elements.push(ChainElement::Checkpoint(committed));
        Ok(())
    }

    pub fn latest_checkpoint_for_part(
        &self,
        source_transcript_part_id: &str,
    ) -> Option<&CompletedScanCheckpoint> {
        self.elements
            .iter()
            .rev()
            .find_map(|element| match element {
                ChainElement::Checkpoint(checkpoint)
                    if checkpoint.source_transcript_part_id == source_transcript_part_id =>
                {
                    Some(&checkpoint.checkpoint)
                }
                _ => None,
            })
    }

    fn has_record_version(&self, observation: &ArchiveObservation) -> bool {
        self.elements.iter().any(|element| {
            matches!(element, ChainElement::Record(record)
                if record.source_transcript_part_id == observation.source_transcript_part_id
                    && record.source_record_identity == observation.source_record_identity
                    && record.content_sha256 == observation.content_sha256)
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ChainError {
    #[error(transparent)]
    Archive(#[from] ArchiveError),
    #[error("archive chain element belongs to another source session")]
    ScopeMismatch,
    #[error("archive chain wrapper does not match its nested checkpoint")]
    WrapperMismatch,
    #[error("scan did not prove the canonical historical prefix")]
    MissingHistoricalPrefixProof,
    #[error("completed scan checkpoint moved backwards")]
    CheckpointRegressed,
    #[error("completed scan record count moved backwards")]
    CheckpointRecordCountRegressed,
    #[error("completed scan checkpoint does not describe the observed records")]
    CheckpointDoesNotDescribeScan,
    #[error("archive chain sequence expected {expected}, found {actual}")]
    SequenceMismatch { expected: u64, actual: u64 },
    #[error("archive chain hash mismatch at sequence {sequence}")]
    HashMismatch { sequence: u64 },
}
