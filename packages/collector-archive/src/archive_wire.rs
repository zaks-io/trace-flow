use base64::Engine;
use serde::Serialize;

use crate::jsonl::JsonlError;
use crate::types::{ArchiveAppendProof, ArchiveObservation, CompletedScanCheckpoint};

pub const ARCHIVE_UPLOAD_WIRE_VERSION: u16 = 2;

#[derive(Debug, Clone, Serialize)]
pub struct ArchiveUploadRequest {
    pub source_session_id: String,
    pub observations: Vec<ArchiveObservation>,
    pub checkpoint: CompletedScanCheckpoint,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prior_checkpoint: Option<CompletedScanCheckpoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete_prefix_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub append_proof: Option<ArchiveAppendProof>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonlScan {
    pub observations: Vec<ArchiveObservation>,
    pub checkpoint: CompletedScanCheckpoint,
    /// The scanner verified this historical checkpoint against the source bytes before returning.
    /// It is local proof for the chain builder and is not serialized or uploaded as source data.
    pub prior_checkpoint: Option<CompletedScanCheckpoint>,
    /// The bounded suffix proof to send with this scan when it follows a durable checkpoint.
    pub append_proof: Option<ArchiveAppendProof>,
}

impl JsonlScan {
    pub fn into_upload_request(
        self,
        source_bytes: &[u8],
    ) -> Result<ArchiveUploadRequest, JsonlError> {
        let complete_prefix_base64 = if self.prior_checkpoint.is_none() {
            let offset = self.checkpoint.last_complete_byte_offset as usize;
            let Some(prefix) = source_bytes.get(..offset) else {
                return Err(JsonlError::WirePrefixUnavailable);
            };
            Some(base64::engine::general_purpose::STANDARD.encode(prefix))
        } else {
            None
        };
        Ok(ArchiveUploadRequest {
            source_session_id: self.checkpoint.source_session_id.clone(),
            observations: self.observations,
            checkpoint: self.checkpoint,
            prior_checkpoint: self.prior_checkpoint,
            complete_prefix_base64,
            append_proof: self.append_proof,
        })
    }

    /// Serialize the v2 UTF-8 proof form without allocating a base64 copy of the
    /// source prefix. The proof is the sole copy of each observation payload on
    /// the wire; Archive API reconstructs payloads after validating the exact
    /// JSONL bytes.
    pub fn compact_upload_body(&self, source_bytes: &[u8]) -> Result<Vec<u8>, JsonlError> {
        if self
            .observations
            .iter()
            .any(|observation| observation.payload_encoding != crate::PayloadEncoding::Utf8)
        {
            return Err(JsonlError::CompactProofRequiresUtf8);
        }
        let checkpoint_offset = self.checkpoint.last_complete_byte_offset as usize;
        let Some(complete_prefix) = source_bytes.get(..checkpoint_offset) else {
            return Err(JsonlError::WirePrefixUnavailable);
        };
        let (complete_prefix_utf8, append_proof) = match &self.prior_checkpoint {
            Some(previous) => {
                let prior_offset = previous.last_complete_byte_offset as usize;
                let Some(appended) = complete_prefix.get(prior_offset..) else {
                    return Err(JsonlError::WirePrefixUnavailable);
                };
                (
                    None,
                    Some(CompactAppendProof {
                        prior_prefix_chain_sha256: previous.prefix_chain_sha256,
                        appended_prefix_utf8: std::str::from_utf8(appended)
                            .map_err(|_| JsonlError::CompactProofRequiresUtf8)?,
                    }),
                )
            }
            None => (
                Some(
                    std::str::from_utf8(complete_prefix)
                        .map_err(|_| JsonlError::CompactProofRequiresUtf8)?,
                ),
                None,
            ),
        };
        let observations = self
            .observations
            .iter()
            .map(CompactArchiveObservation::from)
            .collect();
        serde_json::to_vec(&CompactArchiveUploadRequest {
            archive_upload_wire_version: ARCHIVE_UPLOAD_WIRE_VERSION,
            source_session_id: &self.checkpoint.source_session_id,
            observations,
            checkpoint: &self.checkpoint,
            prior_checkpoint: self.prior_checkpoint.as_ref(),
            complete_prefix_utf8,
            append_proof,
        })
        .map_err(JsonlError::WireSerialization)
    }
}

#[derive(Serialize)]
struct CompactArchiveUploadRequest<'a> {
    archive_upload_wire_version: u16,
    source_session_id: &'a str,
    observations: Vec<CompactArchiveObservation<'a>>,
    checkpoint: &'a CompletedScanCheckpoint,
    #[serde(skip_serializing_if = "Option::is_none")]
    prior_checkpoint: Option<&'a CompletedScanCheckpoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    complete_prefix_utf8: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    append_proof: Option<CompactAppendProof<'a>>,
}

#[derive(Serialize)]
struct CompactArchiveObservation<'a> {
    archive_format_version: u16,
    chain_hash_version: u16,
    source: crate::ArchiveSource,
    source_session_id: &'a str,
    source_transcript_part_id: &'a str,
    source_record_identity: &'a str,
    observed_at: i64,
    payload_encoding: crate::PayloadEncoding,
    content_sha256: crate::Sha256Digest,
}

impl<'a> From<&'a ArchiveObservation> for CompactArchiveObservation<'a> {
    fn from(observation: &'a ArchiveObservation) -> Self {
        Self {
            archive_format_version: observation.archive_format_version,
            chain_hash_version: observation.chain_hash_version,
            source: observation.source,
            source_session_id: &observation.source_session_id,
            source_transcript_part_id: &observation.source_transcript_part_id,
            source_record_identity: &observation.source_record_identity,
            observed_at: observation.observed_at,
            payload_encoding: observation.payload_encoding,
            content_sha256: observation.content_sha256,
        }
    }
}

#[derive(Serialize)]
struct CompactAppendProof<'a> {
    prior_prefix_chain_sha256: crate::Sha256Digest,
    appended_prefix_utf8: &'a str,
}
