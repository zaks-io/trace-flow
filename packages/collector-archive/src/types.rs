use std::fmt;

use collector_contracts::AgentSource;
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};

pub const ARCHIVE_FORMAT_VERSION: u16 = 1;
pub const CHAIN_HASH_VERSION: u16 = 1;
pub const GENESIS_CHAIN_HASH: Sha256Digest = Sha256Digest([0; 32]);
pub const MAX_CHUNK_BYTES: u64 = 3 * 1024 * 1024 / 2;

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
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(ArchiveError::InvalidDigest);
    }
    let mut bytes = [0; 32];
    let (pairs, remainder) = hex.as_bytes().as_chunks::<2>();
    debug_assert!(remainder.is_empty());
    for (index, pair) in pairs.iter().enumerate() {
        bytes[index] = (hex_value(pair[0]) << 4) | hex_value(pair[1]);
    }
    Ok(Sha256Digest(bytes))
}

fn hex_value(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
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
    #[error("payload encoding is not canonical for its exact bytes")]
    NonCanonicalPayloadEncoding,
    #[error("archive checkpoint wrapper does not match its nested checkpoint")]
    CheckpointWrapperMismatch,
    #[error("archive session manifest is invalid: {0}")]
    InvalidManifest(String),
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

pub(crate) use crate::archive_checkpoint::default_transcript_part_id;
pub(crate) use crate::identifier::validate_identifier;

pub(crate) fn validate_transcript_part_id(
    source: ArchiveSource,
    value: &str,
) -> Result<(), ArchiveError> {
    let valid = match source {
        ArchiveSource::Claude => {
            value == "claude:part:parent"
                || value
                    .strip_prefix("claude:part:sha256:")
                    .is_some_and(|hex| {
                        hex.len() == 64
                            && hex
                                .bytes()
                                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
                    })
        }
        ArchiveSource::Codex => value == "codex:part:primary",
    };
    if valid {
        Ok(())
    } else {
        Err(ArchiveError::InvalidIdentifier {
            field: "source_transcript_part_id",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveAppendProof {
    pub prior_prefix_chain_sha256: Sha256Digest,
    pub appended_prefix_base64: String,
}

pub use crate::archive_checkpoint::CompletedScanCheckpoint;
pub use crate::archive_observation::ArchiveObservation;
