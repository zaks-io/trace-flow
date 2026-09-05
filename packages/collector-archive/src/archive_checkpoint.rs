use serde::{de, Deserialize, Deserializer, Serialize};

use crate::types::{
    validate_identifier, validate_transcript_part_id, validate_versions, ArchiveError,
    ArchiveSource, Sha256Digest,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CompletedScanCheckpoint {
    pub(crate) archive_format_version: u16,
    pub(crate) chain_hash_version: u16,
    pub source: ArchiveSource,
    pub source_session_id: String,
    pub(crate) source_transcript_part_id: String,
    pub record_count: u64,
    pub last_source_record_identity: Option<String>,
    pub last_complete_byte_offset: u64,
    pub observed_file_size: u64,
    pub complete_prefix_sha256: Sha256Digest,
    pub prefix_chain_sha256: Sha256Digest,
    pub first_observed_at: i64,
}

impl CompletedScanCheckpoint {
    pub fn source_transcript_part_id(&self) -> &str {
        &self.source_transcript_part_id
    }

    pub fn validate(&self) -> Result<(), ArchiveError> {
        validate_versions(self.archive_format_version, self.chain_hash_version)?;
        validate_identifier(&self.source_session_id, "source_session_id")?;
        validate_identifier(&self.source_transcript_part_id, "source_transcript_part_id")?;
        validate_transcript_part_id(self.source, &self.source_transcript_part_id)?;
        if let Some(identity) = &self.last_source_record_identity {
            validate_identifier(identity, "last_source_record_identity")?;
        }
        if self.last_complete_byte_offset > self.observed_file_size {
            return Err(ArchiveError::InvalidIdentifier {
                field: "last_complete_byte_offset",
            });
        }
        if (self.record_count == 0) != self.last_source_record_identity.is_none() {
            return Err(ArchiveError::InvalidIdentifier {
                field: "last_source_record_identity",
            });
        }
        Ok(())
    }

    pub(crate) fn same_logical_position(&self, other: &Self) -> bool {
        self.archive_format_version == other.archive_format_version
            && self.chain_hash_version == other.chain_hash_version
            && self.source == other.source
            && self.source_session_id == other.source_session_id
            && self.source_transcript_part_id == other.source_transcript_part_id
            && self.record_count == other.record_count
            && self.last_source_record_identity == other.last_source_record_identity
            && self.last_complete_byte_offset == other.last_complete_byte_offset
            && self.complete_prefix_sha256 == other.complete_prefix_sha256
            && self.prefix_chain_sha256 == other.prefix_chain_sha256
    }
}

pub(crate) fn default_transcript_part_id(source: ArchiveSource) -> String {
    match source {
        ArchiveSource::Claude => "claude:part:parent".to_string(),
        ArchiveSource::Codex => "codex:part:primary".to_string(),
    }
}

#[derive(Deserialize)]
struct CompletedScanCheckpointWire {
    archive_format_version: u16,
    chain_hash_version: u16,
    source: ArchiveSource,
    source_session_id: String,
    source_transcript_part_id: String,
    record_count: u64,
    last_source_record_identity: Option<String>,
    last_complete_byte_offset: u64,
    observed_file_size: u64,
    complete_prefix_sha256: Sha256Digest,
    prefix_chain_sha256: Sha256Digest,
    first_observed_at: i64,
}

impl<'de> Deserialize<'de> for CompletedScanCheckpoint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = CompletedScanCheckpointWire::deserialize(deserializer)?;
        let checkpoint = Self {
            archive_format_version: wire.archive_format_version,
            chain_hash_version: wire.chain_hash_version,
            source: wire.source,
            source_session_id: wire.source_session_id,
            source_transcript_part_id: wire.source_transcript_part_id,
            record_count: wire.record_count,
            last_source_record_identity: wire.last_source_record_identity,
            last_complete_byte_offset: wire.last_complete_byte_offset,
            observed_file_size: wire.observed_file_size,
            complete_prefix_sha256: wire.complete_prefix_sha256,
            prefix_chain_sha256: wire.prefix_chain_sha256,
            first_observed_at: wire.first_observed_at,
        };
        checkpoint.validate().map_err(de::Error::custom)?;
        Ok(checkpoint)
    }
}
