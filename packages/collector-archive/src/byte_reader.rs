use std::io::Read;

use base64::Engine;
use sha2::{Digest, Sha256};

use crate::framing::source_prefix_chain_hash;
use crate::{
    ArchiveAppendProof, ArchiveObservation, ArchiveSource, CompletedScanCheckpoint, JsonlError,
    JsonlScan, Sha256Digest, BYTE_ARCHIVE_FORMAT_VERSION, CHAIN_HASH_VERSION,
    MAX_BYTE_SEGMENT_BYTES,
};

/// Owns a source handle and hashes each byte once during a capture pass.
pub struct SourceByteReader<R> {
    reader: R,
    hash: Sha256,
    prior: Option<CompletedScanCheckpoint>,
    source: ArchiveSource,
    session: String,
    part: String,
    observed_at: i64,
    predecessor: Option<String>,
    observed_file_size: Option<u64>,
}

impl<R: Read> SourceByteReader<R> {
    pub fn new(
        mut reader: R,
        source: ArchiveSource,
        session: &str,
        part: &str,
        observed_at: i64,
        prior: Option<&CompletedScanCheckpoint>,
    ) -> Result<Self, JsonlError> {
        let mut hash = Sha256::new();
        if let Some(previous) = prior {
            previous.validate()?;
            if previous.source != source
                || previous.source_session_id != session
                || previous.source_transcript_part_id() != part
            {
                return Err(JsonlError::CheckpointSourceMismatch);
            }
            if previous.archive_format_version() != BYTE_ARCHIVE_FORMAT_VERSION {
                return Err(JsonlError::HistoricalPrefixChanged);
            }
            let mut remaining = previous.last_complete_byte_offset;
            let mut buffer = [0; 64 * 1024];
            while remaining > 0 {
                let wanted = remaining.min(buffer.len() as u64) as usize;
                let count = reader
                    .read(&mut buffer[..wanted])
                    .map_err(JsonlError::SourceIo)?;
                if count == 0 {
                    return Err(JsonlError::HistoricalPrefixShortened);
                }
                hash.update(&buffer[..count]);
                remaining -= count as u64;
            }
            if Sha256Digest(hash.clone().finalize().into()) != previous.complete_prefix_sha256 {
                return Err(JsonlError::HistoricalPrefixChanged);
            }
        }
        Ok(Self {
            reader,
            hash,
            prior: prior.cloned(),
            source,
            session: session.to_string(),
            part: part.to_string(),
            observed_at,
            predecessor: None,
            observed_file_size: None,
        })
    }

    pub fn with_observed_file_size(mut self, size: u64) -> Self {
        self.observed_file_size = Some(size);
        self
    }

    pub fn with_predecessor(mut self, predecessor: Option<&str>) -> Result<Self, JsonlError> {
        if let Some(part) = predecessor {
            crate::types::validate_transcript_part_id(self.source, part)?;
            if part == self.part {
                return Err(JsonlError::CheckpointSourceMismatch);
            }
        }
        if let Some(prior) = &self.prior {
            let previous = prior
                .last_source_record_identity
                .as_deref()
                .and_then(|id| id.split_once(":from:"))
                .map(|(_, part)| part);
            if prior.record_count > 0 && previous != predecessor {
                return Err(JsonlError::CheckpointSourceMismatch);
            }
        }
        self.predecessor = predecessor.map(str::to_string);
        Ok(self)
    }

    pub fn next_segment(&mut self) -> Result<Option<JsonlScan>, JsonlError> {
        let mut bytes = Vec::with_capacity(MAX_BYTE_SEGMENT_BYTES);
        self.reader
            .by_ref()
            .take(MAX_BYTE_SEGMENT_BYTES as u64)
            .read_to_end(&mut bytes)
            .map_err(JsonlError::SourceIo)?;
        if bytes.is_empty() {
            return Ok(None);
        }
        let start = self
            .prior
            .as_ref()
            .map_or(0, |p| p.last_complete_byte_offset);
        let end = start
            .checked_add(bytes.len() as u64)
            .ok_or(JsonlError::WirePrefixUnavailable)?;
        let lineage = self
            .predecessor
            .as_deref()
            .or_else(|| {
                self.prior
                    .as_ref()
                    .and_then(|p| p.last_source_record_identity.as_ref())
                    .and_then(|id| id.split_once(":from:"))
                    .map(|(_, part)| part)
            })
            .map(|part| format!(":from:{part}"))
            .unwrap_or_default();
        let mut observation = ArchiveObservation::new_with_transcript_part(
            self.source,
            &self.part,
            &self.session,
            format!("bytes:{start}:{end}{lineage}"),
            self.observed_at,
            &bytes,
        )?;
        observation.archive_format_version = BYTE_ARCHIVE_FORMAT_VERSION;
        observation.validate()?;
        self.hash.update(&bytes);
        let checkpoint = CompletedScanCheckpoint {
            archive_format_version: BYTE_ARCHIVE_FORMAT_VERSION,
            chain_hash_version: CHAIN_HASH_VERSION,
            source: self.source,
            source_session_id: self.session.clone(),
            source_transcript_part_id: self.part.clone(),
            record_count: self.prior.as_ref().map_or(0, |p| p.record_count) + 1,
            last_source_record_identity: Some(observation.source_record_identity.clone()),
            last_complete_byte_offset: end,
            observed_file_size: self.observed_file_size.unwrap_or(end),
            complete_prefix_sha256: Sha256Digest(self.hash.clone().finalize().into()),
            prefix_chain_sha256: source_prefix_chain_hash(
                self.prior.as_ref().map(|p| p.prefix_chain_sha256),
                &bytes,
            ),
            first_observed_at: self
                .prior
                .as_ref()
                .map_or(self.observed_at, |p| p.first_observed_at),
        };
        checkpoint.validate()?;
        let scan = JsonlScan {
            observations: vec![observation],
            checkpoint: checkpoint.clone(),
            prior_checkpoint: self.prior.clone(),
            append_proof: self.prior.as_ref().map(|p| ArchiveAppendProof {
                prior_prefix_chain_sha256: p.prefix_chain_sha256,
                appended_prefix_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
            }),
        };
        self.prior = Some(checkpoint);
        Ok(Some(scan))
    }
}
