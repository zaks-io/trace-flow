//! Lossless first-release Conversation Archive contracts for Claude and Codex JSONL.
//!
//! The scanner parses complete lines only to derive stable source identities. It keeps each source
//! record's original bytes as the payload, encodes those bytes as UTF-8 or base64, and hashes the
//! bytes before any wrapper serialization. Cursor is intentionally not represented by
//! [`ArchiveSource`]; converting `AgentSource::Cursor` fails loudly.

mod chain;
mod elements;
mod encoding;
mod framing;
mod jsonl;
mod manifest;
mod types;

pub use chain::{ArchiveChain, ChainError, CommitReport};
pub use elements::{ArchiveRecord, ChainElement, CommittedScanCheckpoint};
pub use encoding::{EncodedPayload, PayloadEncoding};
pub use framing::hash_framed;
pub use jsonl::{scan_claude_jsonl, scan_codex_jsonl, scan_jsonl, JsonlError, JsonlScan};
pub use manifest::{ArchiveSessionManifest, ChunkByteRange, ManifestElement, ManifestError};
pub use types::{
    sha256, validate_versions, ArchiveError, ArchiveObservation, ArchiveSource,
    CompletedScanCheckpoint, Sha256Digest, ARCHIVE_FORMAT_VERSION, CHAIN_HASH_VERSION,
    GENESIS_CHAIN_HASH, MAX_CHUNK_BYTES,
};
