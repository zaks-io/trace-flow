use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::chain::{ArchiveChain, ChainError};
use crate::elements::ChainElement;
use crate::types::{
    ArchiveError, ArchiveSource, CompletedScanCheckpoint, Sha256Digest, ARCHIVE_FORMAT_VERSION,
    CHAIN_HASH_VERSION, MAX_CHUNK_BYTES,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkByteRange {
    pub chunk_id: String,
    /// Inclusive start and exclusive end in the canonical uncompressed chunk bytes.
    pub start: u64,
    pub end: u64,
}

impl ChunkByteRange {
    pub fn validate(&self) -> Result<(), ManifestError> {
        if self.chunk_id.is_empty()
            || self.chunk_id.contains(['/', '\\'])
            || self.end > MAX_CHUNK_BYTES
            || self.end <= self.start
            || self.end - self.start > MAX_CHUNK_BYTES
        {
            return Err(ManifestError::InvalidByteRange);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "element_type", rename_all = "snake_case")]
pub enum ManifestElement {
    Record {
        chain_sequence: u64,
        source_record_identity: String,
        content_sha256: Sha256Digest,
        chain_hash: Sha256Digest,
        byte_range: ChunkByteRange,
    },
    Checkpoint {
        chain_sequence: u64,
        checkpoint: CompletedScanCheckpoint,
        chain_hash: Sha256Digest,
        byte_range: ChunkByteRange,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveSessionManifest {
    pub archive_format_version: u16,
    pub chain_hash_version: u16,
    pub source: ArchiveSource,
    pub source_session_id: String,
    pub generation: u64,
    pub element_count: u64,
    pub chain_head: Sha256Digest,
    pub elements: Vec<ManifestElement>,
}

impl ArchiveSessionManifest {
    pub fn from_chain(
        generation: u64,
        chain: &ArchiveChain,
        byte_ranges: &BTreeMap<u64, ChunkByteRange>,
    ) -> Result<Self, ManifestError> {
        chain.verify()?;
        if byte_ranges.len() != chain.elements.len() {
            return Err(ManifestError::UnexpectedByteRange);
        }
        let elements = chain
            .elements
            .iter()
            .map(|element| {
                let sequence = element.chain_sequence();
                let byte_range = byte_ranges
                    .get(&sequence)
                    .cloned()
                    .ok_or(ManifestError::MissingByteRange(sequence))?;
                byte_range.validate()?;
                Ok(match element {
                    ChainElement::Record(record) => ManifestElement::Record {
                        chain_sequence: sequence,
                        source_record_identity: record.source_record_identity.clone(),
                        content_sha256: record.content_sha256,
                        chain_hash: record.chain_hash,
                        byte_range,
                    },
                    ChainElement::Checkpoint(checkpoint) => ManifestElement::Checkpoint {
                        chain_sequence: sequence,
                        checkpoint: checkpoint.checkpoint.clone(),
                        chain_hash: checkpoint.chain_hash,
                        byte_range,
                    },
                })
            })
            .collect::<Result<Vec<_>, ManifestError>>()?;
        let manifest = Self {
            archive_format_version: ARCHIVE_FORMAT_VERSION,
            chain_hash_version: CHAIN_HASH_VERSION,
            source: chain.source,
            source_session_id: chain.source_session_id.clone(),
            generation,
            element_count: chain.elements.len() as u64,
            chain_head: chain.chain_head(),
            elements,
        };
        manifest.verify_against_chain(chain)?;
        Ok(manifest)
    }

    pub fn verify_against_chain(&self, chain: &ArchiveChain) -> Result<(), ManifestError> {
        chain.verify()?;
        if self.archive_format_version != ARCHIVE_FORMAT_VERSION
            || self.chain_hash_version != CHAIN_HASH_VERSION
            || self.source != chain.source
            || self.source_session_id != chain.source_session_id
            || self.element_count != chain.elements.len() as u64
            || self.chain_head != chain.chain_head()
            || self.elements.len() != chain.elements.len()
        {
            return Err(ManifestError::Mismatch);
        }
        validate_ordered_ranges(&self.elements)?;
        for (expected_sequence, (manifest, chain_element)) in
            self.elements.iter().zip(&chain.elements).enumerate()
        {
            match (manifest, chain_element) {
                (
                    ManifestElement::Record {
                        chain_sequence,
                        source_record_identity,
                        content_sha256,
                        chain_hash,
                        byte_range,
                    },
                    ChainElement::Record(record),
                ) if *chain_sequence == expected_sequence as u64
                    && *chain_sequence == record.chain_sequence
                    && source_record_identity == &record.source_record_identity
                    && *content_sha256 == record.content_sha256
                    && *chain_hash == record.chain_hash =>
                {
                    byte_range.validate()?;
                }
                (
                    ManifestElement::Checkpoint {
                        chain_sequence,
                        checkpoint,
                        chain_hash,
                        byte_range,
                    },
                    ChainElement::Checkpoint(committed),
                ) if *chain_sequence == expected_sequence as u64
                    && *chain_sequence == committed.chain_sequence
                    && checkpoint == &committed.checkpoint
                    && *chain_hash == committed.chain_hash =>
                {
                    byte_range.validate()?;
                }
                _ => return Err(ManifestError::Mismatch),
            }
        }
        Ok(())
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, ArchiveError> {
        Ok(serde_json::to_vec(self)?)
    }

    pub fn content_sha256(&self) -> Result<Sha256Digest, ArchiveError> {
        Ok(crate::types::sha256(&self.to_bytes()?))
    }

    pub fn checkpoints(&self) -> impl Iterator<Item = &CompletedScanCheckpoint> {
        self.elements.iter().filter_map(|element| match element {
            ManifestElement::Checkpoint { checkpoint, .. } => Some(checkpoint),
            ManifestElement::Record { .. } => None,
        })
    }
}

fn validate_ordered_ranges(elements: &[ManifestElement]) -> Result<(), ManifestError> {
    let mut seen_chunks = HashSet::new();
    let mut active_chunk: Option<&str> = None;
    let mut previous_end = 0;
    for element in elements {
        let range = match element {
            ManifestElement::Record { byte_range, .. }
            | ManifestElement::Checkpoint { byte_range, .. } => byte_range,
        };
        if active_chunk != Some(range.chunk_id.as_str()) {
            if !seen_chunks.insert(range.chunk_id.as_str()) {
                return Err(ManifestError::InvalidByteRange);
            }
            active_chunk = Some(range.chunk_id.as_str());
            previous_end = 0;
        }
        if range.start < previous_end {
            return Err(ManifestError::InvalidByteRange);
        }
        previous_end = range.end;
    }
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error(transparent)]
    Chain(#[from] ChainError),
    #[error(transparent)]
    Archive(#[from] ArchiveError),
    #[error("manifest has no byte range for chain sequence {0}")]
    MissingByteRange(u64),
    #[error("manifest byte range is invalid")]
    InvalidByteRange,
    #[error("manifest has an unexpected number of byte ranges")]
    UnexpectedByteRange,
    #[error("manifest does not match the canonical archive chain")]
    Mismatch,
}
