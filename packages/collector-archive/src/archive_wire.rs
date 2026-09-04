use base64::Engine;
use serde::Serialize;

use crate::jsonl::JsonlError;
use crate::types::{ArchiveAppendProof, ArchiveObservation, CompletedScanCheckpoint};

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
}
