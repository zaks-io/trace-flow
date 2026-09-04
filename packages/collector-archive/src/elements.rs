use serde::{de, Deserialize, Deserializer, Serialize};

use crate::types::{
    validate_identifier, validate_transcript_part_id, validate_versions, ArchiveError,
    ArchiveObservation, ArchiveSource, CompletedScanCheckpoint, Sha256Digest,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArchiveRecord {
    pub(crate) archive_format_version: u16,
    pub(crate) chain_hash_version: u16,
    pub source: ArchiveSource,
    pub source_session_id: String,
    pub(crate) source_transcript_part_id: String,
    pub source_record_identity: String,
    pub observed_at: i64,
    pub payload_encoding: crate::encoding::PayloadEncoding,
    pub payload: String,
    pub content_sha256: Sha256Digest,
    pub chain_sequence: u64,
    pub previous_chain_hash: Sha256Digest,
    pub chain_hash: Sha256Digest,
}

impl ArchiveRecord {
    pub fn source_transcript_part_id(&self) -> &str {
        &self.source_transcript_part_id
    }

    pub(crate) fn validate(&self) -> Result<(), ArchiveError> {
        validate_versions(self.archive_format_version, self.chain_hash_version)?;
        validate_identifier(&self.source_session_id, "source_session_id")?;
        validate_identifier(&self.source_transcript_part_id, "source_transcript_part_id")?;
        validate_transcript_part_id(self.source, &self.source_transcript_part_id)?;
        validate_identifier(&self.source_record_identity, "source_record_identity")?;
        let observation = ArchiveObservation {
            archive_format_version: self.archive_format_version,
            chain_hash_version: self.chain_hash_version,
            source: self.source,
            source_session_id: self.source_session_id.clone(),
            source_transcript_part_id: self.source_transcript_part_id.clone(),
            source_record_identity: self.source_record_identity.clone(),
            observed_at: self.observed_at,
            payload_encoding: self.payload_encoding,
            payload: self.payload.clone(),
            content_sha256: self.content_sha256,
        };
        observation.validate()
    }
}

#[derive(Deserialize)]
struct ArchiveRecordWire {
    archive_format_version: u16,
    chain_hash_version: u16,
    source: ArchiveSource,
    source_session_id: String,
    source_transcript_part_id: String,
    source_record_identity: String,
    observed_at: i64,
    payload_encoding: crate::encoding::PayloadEncoding,
    payload: String,
    content_sha256: Sha256Digest,
    chain_sequence: u64,
    previous_chain_hash: Sha256Digest,
    chain_hash: Sha256Digest,
}

impl<'de> Deserialize<'de> for ArchiveRecord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = ArchiveRecordWire::deserialize(deserializer)?;
        let record = Self {
            archive_format_version: wire.archive_format_version,
            chain_hash_version: wire.chain_hash_version,
            source: wire.source,
            source_session_id: wire.source_session_id,
            source_transcript_part_id: wire.source_transcript_part_id,
            source_record_identity: wire.source_record_identity,
            observed_at: wire.observed_at,
            payload_encoding: wire.payload_encoding,
            payload: wire.payload,
            content_sha256: wire.content_sha256,
            chain_sequence: wire.chain_sequence,
            previous_chain_hash: wire.previous_chain_hash,
            chain_hash: wire.chain_hash,
        };
        record.validate().map_err(de::Error::custom)?;
        Ok(record)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommittedScanCheckpoint {
    pub(crate) archive_format_version: u16,
    pub(crate) chain_hash_version: u16,
    pub source: ArchiveSource,
    pub source_session_id: String,
    pub(crate) source_transcript_part_id: String,
    pub checkpoint: CompletedScanCheckpoint,
    pub chain_sequence: u64,
    pub previous_chain_hash: Sha256Digest,
    pub chain_hash: Sha256Digest,
}

impl CommittedScanCheckpoint {
    pub fn source_transcript_part_id(&self) -> &str {
        &self.source_transcript_part_id
    }

    pub(crate) fn validate(&self) -> Result<(), ArchiveError> {
        validate_versions(self.archive_format_version, self.chain_hash_version)?;
        validate_identifier(&self.source_session_id, "source_session_id")?;
        validate_identifier(&self.source_transcript_part_id, "source_transcript_part_id")?;
        validate_transcript_part_id(self.source, &self.source_transcript_part_id)?;
        self.checkpoint.validate()?;
        if self.source != self.checkpoint.source
            || self.source_session_id != self.checkpoint.source_session_id
            || self.source_transcript_part_id != self.checkpoint.source_transcript_part_id
            || self.archive_format_version != self.checkpoint.archive_format_version
            || self.chain_hash_version != self.checkpoint.chain_hash_version
        {
            return Err(ArchiveError::CheckpointWrapperMismatch);
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct CommittedScanCheckpointWire {
    archive_format_version: u16,
    chain_hash_version: u16,
    source: ArchiveSource,
    source_session_id: String,
    source_transcript_part_id: String,
    checkpoint: CompletedScanCheckpoint,
    chain_sequence: u64,
    previous_chain_hash: Sha256Digest,
    chain_hash: Sha256Digest,
}

impl<'de> Deserialize<'de> for CommittedScanCheckpoint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = CommittedScanCheckpointWire::deserialize(deserializer)?;
        let checkpoint = Self {
            archive_format_version: wire.archive_format_version,
            chain_hash_version: wire.chain_hash_version,
            source: wire.source,
            source_session_id: wire.source_session_id,
            source_transcript_part_id: wire.source_transcript_part_id,
            checkpoint: wire.checkpoint,
            chain_sequence: wire.chain_sequence,
            previous_chain_hash: wire.previous_chain_hash,
            chain_hash: wire.chain_hash,
        };
        checkpoint.validate().map_err(de::Error::custom)?;
        Ok(checkpoint)
    }
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
