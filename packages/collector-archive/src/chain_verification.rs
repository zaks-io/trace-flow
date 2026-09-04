use crate::elements::ChainElement;
use crate::framing::{checkpoint_chain_hash, record_chain_hash};
use crate::types::{validate_versions, ArchiveObservation, GENESIS_CHAIN_HASH};

use super::{ArchiveChain, ChainError};

impl ArchiveChain {
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
}
