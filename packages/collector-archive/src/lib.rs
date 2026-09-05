//! Lossless first-release Conversation Archive contracts for Claude and Codex JSONL.
//!
//! The scanner parses complete lines only to derive stable source identities. It keeps each source
//! record's original bytes as the payload, encodes those bytes as UTF-8 or base64, and hashes the
//! bytes before any wrapper serialization. Cursor is intentionally not represented by
//! [`ArchiveSource`]; converting `AgentSource::Cursor` fails loudly.

mod archive_checkpoint;
mod archive_observation;
mod archive_wire;
mod chain;
mod chain_validation;
mod chain_verification;
mod elements;
mod encoding;
mod framing;
mod identifier;
mod jsonl;
mod jsonl_prefix;
mod jsonl_whitespace;
mod manifest;
mod types;

pub use archive_checkpoint::default_transcript_part_id;
pub use archive_wire::{ArchiveUploadRequest, JsonlScan};
pub use chain::{ArchiveChain, ChainError, CommitReport};
pub use elements::{ArchiveRecord, ChainElement, CommittedScanCheckpoint};
pub use encoding::{EncodedPayload, PayloadEncoding};
pub use framing::hash_framed;
pub use jsonl::{
    claude_transcript_part_id, scan_claude_jsonl, scan_claude_jsonl_part, scan_codex_jsonl,
    scan_jsonl, JsonlError,
};
pub use jsonl_prefix::complete_record_end_offsets;
pub use manifest::{ArchiveSessionManifest, ChunkByteRange, ManifestElement, ManifestError};
pub use types::{
    sha256, validate_versions, ArchiveAppendProof, ArchiveError, ArchiveObservation, ArchiveSource,
    CompletedScanCheckpoint, Sha256Digest, ARCHIVE_FORMAT_VERSION, CHAIN_HASH_VERSION,
    GENESIS_CHAIN_HASH, MAX_CHUNK_BYTES,
};
