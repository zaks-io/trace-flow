use sha2::{Digest, Sha256};

use crate::elements::CommittedScanCheckpoint;
use crate::types::{ArchiveObservation, Sha256Digest};

const RECORD_DOMAIN: &[u8] = b"trace-flow/archive/record-chain/v1";
const CHECKPOINT_DOMAIN: &[u8] = b"trace-flow/archive/checkpoint-chain/v1";

pub fn hash_framed(domain: &[u8], fields: &[&[u8]]) -> Sha256Digest {
    let mut frame = Vec::new();
    append_length_prefixed(&mut frame, domain);
    for field in fields {
        append_length_prefixed(&mut frame, field);
    }
    Sha256Digest(Sha256::digest(frame).into())
}

fn append_length_prefixed(frame: &mut Vec<u8>, value: &[u8]) {
    frame.extend_from_slice(&(value.len() as u64).to_be_bytes());
    frame.extend_from_slice(value);
}

fn u16_bytes(value: u16) -> [u8; 2] {
    value.to_be_bytes()
}

fn u64_bytes(value: u64) -> [u8; 8] {
    value.to_be_bytes()
}

fn i64_bytes(value: i64) -> [u8; 8] {
    value.to_be_bytes()
}

pub fn record_chain_hash(
    previous: Sha256Digest,
    sequence: u64,
    observation: &ArchiveObservation,
) -> Sha256Digest {
    let archive_version = u16_bytes(observation.archive_format_version);
    let chain_version = u16_bytes(observation.chain_hash_version);
    let sequence = u64_bytes(sequence);
    let observed_at = i64_bytes(observation.observed_at);
    let encoding = match observation.payload_encoding {
        crate::encoding::PayloadEncoding::Utf8 => b"utf8".as_slice(),
        crate::encoding::PayloadEncoding::Base64 => b"base64".as_slice(),
    };
    hash_framed(
        RECORD_DOMAIN,
        &[
            previous.as_bytes(),
            &archive_version,
            &chain_version,
            observation.source.as_str().as_bytes(),
            observation.source_session_id.as_bytes(),
            observation.source_transcript_part_id.as_bytes(),
            observation.source_record_identity.as_bytes(),
            &observed_at,
            encoding,
            observation.content_sha256.as_bytes(),
            &sequence,
        ],
    )
}

pub fn checkpoint_chain_hash(
    previous: Sha256Digest,
    sequence: u64,
    checkpoint: &CommittedScanCheckpoint,
) -> Sha256Digest {
    let inner = &checkpoint.checkpoint;
    let outer_archive_version = u16_bytes(checkpoint.archive_format_version);
    let outer_chain_version = u16_bytes(checkpoint.chain_hash_version);
    let archive_version = u16_bytes(inner.archive_format_version);
    let chain_version = u16_bytes(inner.chain_hash_version);
    let sequence = u64_bytes(sequence);
    let record_count = u64_bytes(inner.record_count);
    let offset = u64_bytes(inner.last_complete_byte_offset);
    let observed_size = u64_bytes(inner.observed_file_size);
    let first_observed_at = i64_bytes(inner.first_observed_at);
    let last_identity = inner.last_source_record_identity.as_deref().unwrap_or("");
    hash_framed(
        CHECKPOINT_DOMAIN,
        &[
            previous.as_bytes(),
            &outer_archive_version,
            &outer_chain_version,
            checkpoint.source.as_str().as_bytes(),
            checkpoint.source_session_id.as_bytes(),
            checkpoint.source_transcript_part_id.as_bytes(),
            &archive_version,
            &chain_version,
            inner.source.as_str().as_bytes(),
            inner.source_session_id.as_bytes(),
            inner.source_transcript_part_id.as_bytes(),
            &record_count,
            last_identity.as_bytes(),
            &offset,
            &observed_size,
            inner.complete_prefix_sha256.as_bytes(),
            &first_observed_at,
            &sequence,
        ],
    )
}
