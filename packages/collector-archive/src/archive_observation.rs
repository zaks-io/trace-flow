use serde::{de, Deserialize, Deserializer, Serialize};

use crate::encoding::PayloadEncoding;
use crate::types::{
    default_transcript_part_id, sha256, validate_identifier, validate_transcript_part_id,
    validate_versions, ArchiveError, ArchiveSource, ARCHIVE_FORMAT_VERSION, CHAIN_HASH_VERSION,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArchiveObservation {
    pub(crate) archive_format_version: u16,
    pub(crate) chain_hash_version: u16,
    pub source: ArchiveSource,
    pub source_session_id: String,
    pub(crate) source_transcript_part_id: String,
    pub source_record_identity: String,
    pub observed_at: i64,
    pub payload_encoding: PayloadEncoding,
    pub payload: String,
    pub content_sha256: crate::types::Sha256Digest,
}

impl ArchiveObservation {
    pub fn source_transcript_part_id(&self) -> &str {
        &self.source_transcript_part_id
    }

    pub fn new(
        source: ArchiveSource,
        source_session_id: impl Into<String>,
        source_record_identity: impl Into<String>,
        observed_at: i64,
        payload_bytes: &[u8],
    ) -> Result<Self, ArchiveError> {
        Self::new_with_transcript_part(
            source,
            default_transcript_part_id(source),
            source_session_id,
            source_record_identity,
            observed_at,
            payload_bytes,
        )
    }

    pub(crate) fn new_with_transcript_part(
        source: ArchiveSource,
        source_transcript_part_id: impl Into<String>,
        source_session_id: impl Into<String>,
        source_record_identity: impl Into<String>,
        observed_at: i64,
        payload_bytes: &[u8],
    ) -> Result<Self, ArchiveError> {
        let source_transcript_part_id = source_transcript_part_id.into();
        let source_session_id = source_session_id.into();
        let source_record_identity = source_record_identity.into();
        validate_identifier(&source_session_id, "source_session_id")?;
        validate_identifier(&source_transcript_part_id, "source_transcript_part_id")?;
        validate_identifier(&source_record_identity, "source_record_identity")?;
        let encoded = crate::encoding::EncodedPayload::from_bytes(payload_bytes);
        Ok(Self {
            archive_format_version: ARCHIVE_FORMAT_VERSION,
            chain_hash_version: CHAIN_HASH_VERSION,
            source,
            source_session_id,
            source_transcript_part_id,
            source_record_identity,
            observed_at,
            payload_encoding: encoded.encoding,
            payload: encoded.value,
            content_sha256: sha256(payload_bytes),
        })
    }

    pub fn validate(&self) -> Result<(), ArchiveError> {
        validate_versions(self.archive_format_version, self.chain_hash_version)?;
        validate_identifier(&self.source_session_id, "source_session_id")?;
        validate_identifier(&self.source_transcript_part_id, "source_transcript_part_id")?;
        validate_transcript_part_id(self.source, &self.source_transcript_part_id)?;
        validate_identifier(&self.source_record_identity, "source_record_identity")?;
        let encoded = crate::encoding::EncodedPayload {
            encoding: self.payload_encoding,
            value: self.payload.clone(),
        };
        let bytes = encoded.decode()?;
        if sha256(&bytes) != self.content_sha256 {
            return Err(ArchiveError::ContentHashMismatch);
        }
        if crate::encoding::EncodedPayload::from_bytes(&bytes) != encoded {
            return Err(ArchiveError::NonCanonicalPayloadEncoding);
        }
        Ok(())
    }

    pub fn payload_bytes(&self) -> Result<Vec<u8>, ArchiveError> {
        let encoded = crate::encoding::EncodedPayload {
            encoding: self.payload_encoding,
            value: self.payload.clone(),
        };
        let bytes = encoded.decode()?;
        if sha256(&bytes) != self.content_sha256 {
            return Err(ArchiveError::ContentHashMismatch);
        }
        Ok(bytes)
    }
}

#[derive(Deserialize)]
struct ArchiveObservationWire {
    archive_format_version: u16,
    chain_hash_version: u16,
    source: ArchiveSource,
    source_session_id: String,
    source_transcript_part_id: String,
    source_record_identity: String,
    observed_at: i64,
    payload_encoding: PayloadEncoding,
    payload: String,
    content_sha256: crate::types::Sha256Digest,
}

impl<'de> Deserialize<'de> for ArchiveObservation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = ArchiveObservationWire::deserialize(deserializer)?;
        let observation = Self {
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
        };
        observation.validate().map_err(de::Error::custom)?;
        Ok(observation)
    }
}
