use serde::{Deserialize, Serialize};

use crate::types::{ArchiveSource, CompletedScanCheckpoint, Sha256Digest};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveRecord {
    pub archive_format_version: u16,
    pub chain_hash_version: u16,
    pub source: ArchiveSource,
    pub source_session_id: String,
    pub source_record_identity: String,
    pub observed_at: i64,
    pub payload_encoding: crate::encoding::PayloadEncoding,
    pub payload: String,
    pub content_sha256: Sha256Digest,
    pub chain_sequence: u64,
    pub previous_chain_hash: Sha256Digest,
    pub chain_hash: Sha256Digest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommittedScanCheckpoint {
    pub archive_format_version: u16,
    pub chain_hash_version: u16,
    pub source: ArchiveSource,
    pub source_session_id: String,
    pub checkpoint: CompletedScanCheckpoint,
    pub chain_sequence: u64,
    pub previous_chain_hash: Sha256Digest,
    pub chain_hash: Sha256Digest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChainElement {
    Record(ArchiveRecord),
    Checkpoint(CommittedScanCheckpoint),
}

impl ChainElement {
    pub fn chain_sequence(&self) -> u64 {
        match self {
            Self::Record(record) => record.chain_sequence,
            Self::Checkpoint(checkpoint) => checkpoint.chain_sequence,
        }
    }

    pub fn chain_hash(&self) -> Sha256Digest {
        match self {
            Self::Record(record) => record.chain_hash,
            Self::Checkpoint(checkpoint) => checkpoint.chain_hash,
        }
    }
}
