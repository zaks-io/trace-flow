use crate::framing::source_prefix_chain_hash;
use crate::{
    sha256, ArchiveSource, CompletedScanCheckpoint, JsonlError, JsonlScan, CHAIN_HASH_VERSION,
};

pub const BYTE_ARCHIVE_FORMAT_VERSION: u16 = 2;
pub const MAX_BYTE_SEGMENT_BYTES: usize = 512 * 1024;

pub fn byte_segment_range(identity: &str) -> Option<(u64, u64)> {
    let mut fields = identity.splitn(4, ':');
    if fields.next()? != "bytes" {
        return None;
    }
    let start_text = fields.next()?;
    let end_text = fields.next()?;
    let start = start_text.parse::<u64>().ok()?;
    let end = end_text.parse::<u64>().ok()?;
    let lineage_valid = match fields.next() {
        None => true,
        Some(suffix) => suffix.strip_prefix("from:").is_some_and(|part| {
            [ArchiveSource::Claude, ArchiveSource::Codex]
                .iter()
                .any(|source| crate::types::validate_transcript_part_id(*source, part).is_ok())
        }),
    };
    (lineage_valid
        && start.to_string() == start_text
        && end.to_string() == end_text
        && end > start
        && end - start <= MAX_BYTE_SEGMENT_BYTES as u64
        && end <= 9_007_199_254_740_991)
        .then_some((start, end))
}

pub fn rewrite_byte_part_id(
    source: ArchiveSource,
    previous_part: &str,
    bytes: &[u8],
) -> Result<String, JsonlError> {
    rewrite_byte_part_id_from_digest(source, previous_part, sha256(bytes))
}

pub fn rewrite_byte_part_id_from_digest(
    source: ArchiveSource,
    previous_part: &str,
    bytes_sha256: crate::Sha256Digest,
) -> Result<String, JsonlError> {
    crate::types::validate_transcript_part_id(source, previous_part)?;
    let digest = crate::hash_framed(
        b"trace-flow/archive/byte-generation/v2",
        &[previous_part.as_bytes(), bytes_sha256.as_bytes()],
    );
    Ok(format!("{}:part:{digest}", source.as_str()))
}

/// Capture one bounded append without interpreting its contents.
pub fn scan_source_bytes(
    source: ArchiveSource,
    session: &str,
    part: &str,
    bytes: &[u8],
    observed_at: i64,
    prior: Option<&CompletedScanCheckpoint>,
) -> Result<JsonlScan, JsonlError> {
    if prior.is_some_and(|checkpoint| checkpoint.observed_file_size > bytes.len() as u64) {
        return Err(JsonlError::HistoricalPrefixShortened);
    }
    let mut reader = crate::SourceByteReader::new(
        std::io::Cursor::new(bytes),
        source,
        session,
        part,
        observed_at,
        prior,
    )?
    .with_observed_file_size(bytes.len() as u64);
    if let Some(scan) = reader.next_segment()? {
        return Ok(scan);
    }
    let checkpoint = prior.cloned().unwrap_or_else(|| CompletedScanCheckpoint {
        archive_format_version: BYTE_ARCHIVE_FORMAT_VERSION,
        chain_hash_version: CHAIN_HASH_VERSION,
        source,
        source_session_id: session.to_string(),
        source_transcript_part_id: part.to_string(),
        record_count: 0,
        last_source_record_identity: None,
        last_complete_byte_offset: 0,
        observed_file_size: 0,
        complete_prefix_sha256: sha256(&[]),
        prefix_chain_sha256: source_prefix_chain_hash(None, &[]),
        first_observed_at: observed_at,
    });
    checkpoint.validate()?;
    Ok(JsonlScan {
        observations: vec![],
        checkpoint,
        prior_checkpoint: prior.cloned(),
        append_proof: None,
    })
}

/// Hash a source without allocating its entire historical prefix.
pub fn sha256_reader(mut reader: impl std::io::Read) -> std::io::Result<crate::Sha256Digest> {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(crate::Sha256Digest(hash.finalize().into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_invalid_partial_and_oversized_bytes_across_appends() {
        let mut bytes = b"\n{invalid\n{\"partial\":\"\xf0\x9f".to_vec();
        bytes.extend(vec![0xff; MAX_BYTE_SEGMENT_BYTES * 2]);
        let mut prior = None;
        let mut restored = Vec::new();
        loop {
            let scan = scan_source_bytes(
                ArchiveSource::Codex,
                "session",
                "codex:part:primary",
                &bytes,
                10,
                prior.as_ref(),
            )
            .unwrap();
            if scan.observations.is_empty() {
                break;
            }
            for observation in &scan.observations {
                let (start, end) = byte_segment_range(&observation.source_record_identity).unwrap();
                assert_eq!(start, restored.len() as u64);
                restored.extend(observation.payload_bytes().unwrap());
                assert_eq!(end, restored.len() as u64);
            }
            prior = Some(scan.checkpoint);
        }
        assert_eq!(restored, bytes);
        assert_eq!(prior.unwrap().complete_prefix_sha256, sha256(&bytes));
    }
}
