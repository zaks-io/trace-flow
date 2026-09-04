use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};

use crate::types::{sha256, ArchiveError, Sha256Digest};

/// The wire representation used for the exact source-native payload bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PayloadEncoding {
    Utf8,
    Base64,
}

/// An encoded payload and its representation. The bytes are never parsed and serialized again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedPayload {
    pub encoding: PayloadEncoding,
    pub value: String,
}

impl EncodedPayload {
    pub fn from_bytes(bytes: &[u8]) -> Self {
        match std::str::from_utf8(bytes) {
            Ok(value) => Self {
                encoding: PayloadEncoding::Utf8,
                value: value.to_string(),
            },
            Err(_) => Self {
                encoding: PayloadEncoding::Base64,
                value: STANDARD.encode(bytes),
            },
        }
    }

    pub fn decode(&self) -> Result<Vec<u8>, ArchiveError> {
        let bytes = match self.encoding {
            PayloadEncoding::Utf8 => self.value.as_bytes().to_vec(),
            PayloadEncoding::Base64 => STANDARD
                .decode(&self.value)
                .map_err(|_| ArchiveError::InvalidBase64)?,
        };
        Ok(bytes)
    }

    pub fn content_sha256(&self) -> Result<Sha256Digest, ArchiveError> {
        Ok(sha256(&self.decode()?))
    }
}
