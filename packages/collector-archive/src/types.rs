use std::fmt;

use collector_contracts::AgentSource;
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};

pub const ARCHIVE_FORMAT_VERSION: u16 = 1;
pub const CHAIN_HASH_VERSION: u16 = 1;
pub const GENESIS_CHAIN_HASH: Sha256Digest = Sha256Digest([0; 32]);
pub const MAX_CHUNK_BYTES: u64 = 16 * 1024 * 1024;

/// A validated SHA-256 digest serialized as `sha256:` followed by lowercase hexadecimal.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Sha256Digest(pub(crate) [u8; 32]);

impl Sha256Digest {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for Sha256Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("Sha256Digest")
            .field(&self.to_string())
            .finish()
    }
}

impl fmt::Display for Sha256Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("sha256:")?;
        for byte in self.0 {
            write!(f, "{byte:02x}")?;
        }
        Ok(())
    }
}

impl Serialize for Sha256Digest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for Sha256Digest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        parse_digest(&value).map_err(de::Error::custom)
    }
}

fn parse_digest(value: &str) -> Result<Sha256Digest, ArchiveError> {
    let hex = value
        .strip_prefix("sha256:")
        .ok_or(ArchiveError::InvalidDigest)?;
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ArchiveError::InvalidDigest);
    }
    let mut bytes = [0; 32];
    for (index, pair) in hex.as_bytes().chunks_exact(2).enumerate() {
        bytes[index] = (hex_value(pair[0]) << 4) | hex_value(pair[1]);
    }
    Ok(Sha256Digest(bytes))
}

fn hex_value(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        b'A'..=b'F' => byte - b'A' + 10,
        _ => unreachable!("validated hexadecimal input"),
    }
}

pub fn sha256(bytes: &[u8]) -> Sha256Digest {
    Sha256Digest(Sha256::digest(bytes).into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveSource {
    Claude,
    Codex,
}

impl ArchiveSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

impl TryFrom<AgentSource> for ArchiveSource {
    type Error = ArchiveError;

    fn try_from(source: AgentSource) -> Result<Self, Self::Error> {
        match source {
            AgentSource::Claude => Ok(Self::Claude),
            AgentSource::Codex => Ok(Self::Codex),
            AgentSource::Cursor => Err(ArchiveError::UnsupportedSource("cursor")),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ArchiveError {
    #[error("unsupported archive source `{0}`")]
    UnsupportedSource(&'static str),
    #[error("unsupported archive format version {0}")]
    UnsupportedArchiveFormatVersion(u16),
    #[error("unsupported chain hash version {0}")]
    UnsupportedChainHashVersion(u16),
    #[error("invalid archive identifier in {field}")]
    InvalidIdentifier { field: &'static str },
    #[error("invalid SHA-256 digest")]
    InvalidDigest,
    #[error("invalid base64 payload")]
    InvalidBase64,
    #[error("payload content hash does not match its exact bytes")]
    ContentHashMismatch,
    #[error("JSONL record at byte offset {offset} is not valid JSON")]
    InvalidJsonlRecord { offset: u64 },
    #[error("archive JSON serialization failed")]
    Serialization(#[from] serde_json::Error),
}

pub fn validate_versions(
    archive_format_version: u16,
    chain_hash_version: u16,
) -> Result<(), ArchiveError> {
    if archive_format_version != ARCHIVE_FORMAT_VERSION {
        return Err(ArchiveError::UnsupportedArchiveFormatVersion(
            archive_format_version,
        ));
    }
    if chain_hash_version != CHAIN_HASH_VERSION {
        return Err(ArchiveError::UnsupportedChainHashVersion(
            chain_hash_version,
        ));
    }
    Ok(())
}

pub(crate) fn validate_identifier(value: &str, field: &'static str) -> Result<(), ArchiveError> {
    let is_windows_path = value.len() >= 2
        && value.as_bytes()[0].is_ascii_alphabetic()
        && value.as_bytes()[1] == b':';
    if value.is_empty()
        || value.contains('\0')
        || value.starts_with(['/', '\\'])
        || value.contains(['/', '\\'])
        || is_windows_path
        || value == "."
        || value == ".."
    {
        return Err(ArchiveError::InvalidIdentifier { field });
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveObservation {
    pub archive_format_version: u16,
    pub chain_hash_version: u16,
    pub source: ArchiveSource,
    pub source_session_id: String,
    pub source_record_identity: String,
    pub observed_at: i64,
    pub payload_encoding: crate::encoding::PayloadEncoding,
    pub payload: String,
    pub content_sha256: Sha256Digest,
}

impl ArchiveObservation {
    pub fn new(
        source: ArchiveSource,
        source_session_id: impl Into<String>,
        source_record_identity: impl Into<String>,
        observed_at: i64,
        payload_bytes: &[u8],
    ) -> Result<Self, ArchiveError> {
        let source_session_id = source_session_id.into();
        let source_record_identity = source_record_identity.into();
        validate_identifier(&source_session_id, "source_session_id")?;
        validate_identifier(&source_record_identity, "source_record_identity")?;
        let encoded = crate::encoding::EncodedPayload::from_bytes(payload_bytes);
        Ok(Self {
            archive_format_version: ARCHIVE_FORMAT_VERSION,
            chain_hash_version: CHAIN_HASH_VERSION,
            source,
            source_session_id,
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
        validate_identifier(&self.source_record_identity, "source_record_identity")?;
        let encoded = crate::encoding::EncodedPayload {
            encoding: self.payload_encoding,
            value: self.payload.clone(),
        };
        if encoded.content_sha256()? != self.content_sha256 {
            return Err(ArchiveError::ContentHashMismatch);
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompletedScanCheckpoint {
    pub archive_format_version: u16,
    pub chain_hash_version: u16,
    pub source: ArchiveSource,
    pub source_session_id: String,
    pub record_count: u64,
    pub last_source_record_identity: Option<String>,
    pub last_complete_byte_offset: u64,
    pub observed_file_size: u64,
    pub complete_prefix_sha256: Sha256Digest,
    pub first_observed_at: i64,
}

impl CompletedScanCheckpoint {
    pub fn validate(&self) -> Result<(), ArchiveError> {
        validate_versions(self.archive_format_version, self.chain_hash_version)?;
        validate_identifier(&self.source_session_id, "source_session_id")?;
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
}
