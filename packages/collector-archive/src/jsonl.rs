use std::collections::HashMap;

use base64::Engine;
use serde_json::Value;

use crate::archive_wire::JsonlScan;
use crate::framing::{hash_framed, source_prefix_chain_hash};
use crate::jsonl_prefix::{complete_lines, complete_prefix_offset, validate_historical_prefix};
use crate::types::{
    default_transcript_part_id, sha256, ArchiveError, ArchiveObservation, ArchiveSource,
    CompletedScanCheckpoint, ARCHIVE_FORMAT_VERSION, CHAIN_HASH_VERSION,
};

const CLAUDE_TRANSCRIPT_PART_DOMAIN: &[u8] = b"trace-flow/archive/claude-transcript-part/v1";
#[derive(Debug, Clone)]
pub(crate) struct JsonlLine<'a> {
    pub(crate) bytes: &'a [u8],
    pub(crate) value: Value,
}

pub fn scan_claude_jsonl(
    source_session_id: impl Into<String>,
    bytes: &[u8],
    observed_at: i64,
    prior_checkpoint: Option<&CompletedScanCheckpoint>,
) -> Result<JsonlScan, JsonlError> {
    scan_jsonl_with_part(
        ArchiveSource::Claude,
        source_session_id,
        default_transcript_part_id(ArchiveSource::Claude),
        bytes,
        observed_at,
        prior_checkpoint,
        claude_identity,
    )
}

pub fn scan_claude_jsonl_part(
    source_session_id: impl Into<String>,
    transcript_part_identity: impl AsRef<str>,
    bytes: &[u8],
    observed_at: i64,
    prior_checkpoint: Option<&CompletedScanCheckpoint>,
) -> Result<JsonlScan, JsonlError> {
    let source_transcript_part_id = claude_transcript_part_id(transcript_part_identity.as_ref())?;
    scan_jsonl_with_part(
        ArchiveSource::Claude,
        source_session_id,
        source_transcript_part_id,
        bytes,
        observed_at,
        prior_checkpoint,
        claude_identity,
    )
}

pub fn scan_codex_jsonl(
    source_session_id: impl Into<String>,
    bytes: &[u8],
    observed_at: i64,
    prior_checkpoint: Option<&CompletedScanCheckpoint>,
) -> Result<JsonlScan, JsonlError> {
    scan_jsonl_with_part(
        ArchiveSource::Codex,
        source_session_id,
        default_transcript_part_id(ArchiveSource::Codex),
        bytes,
        observed_at,
        prior_checkpoint,
        codex_identity,
    )
}

pub fn scan_jsonl(
    source: ArchiveSource,
    source_session_id: impl Into<String>,
    bytes: &[u8],
    observed_at: i64,
    prior_checkpoint: Option<&CompletedScanCheckpoint>,
    identity: fn(&Value, usize, &mut HashMap<String, usize>) -> String,
) -> Result<JsonlScan, JsonlError> {
    scan_jsonl_with_part(
        source,
        source_session_id,
        default_transcript_part_id(source),
        bytes,
        observed_at,
        prior_checkpoint,
        identity,
    )
}

fn scan_jsonl_with_part(
    source: ArchiveSource,
    source_session_id: impl Into<String>,
    source_transcript_part_id: String,
    bytes: &[u8],
    observed_at: i64,
    prior_checkpoint: Option<&CompletedScanCheckpoint>,
    identity: fn(&Value, usize, &mut HashMap<String, usize>) -> String,
) -> Result<JsonlScan, JsonlError> {
    let source_session_id = source_session_id.into();
    if let Some(previous) = prior_checkpoint {
        validate_historical_prefix(
            source,
            &source_session_id,
            &source_transcript_part_id,
            bytes,
            previous,
        )?;
    }
    let complete_offset = complete_prefix_offset(bytes)?;
    let lines = complete_lines(&bytes[..complete_offset])?;
    let mut seen_ids = HashMap::new();
    let all_observations = lines
        .iter()
        .enumerate()
        .map(|(record_index, line)| {
            let record_identity = format!(
                "{source_transcript_part_id}:{}",
                identity(&line.value, record_index, &mut seen_ids)
            );
            ArchiveObservation::new_with_transcript_part(
                source,
                source_transcript_part_id.clone(),
                source_session_id.clone(),
                record_identity,
                observed_at,
                line.bytes,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let record_count = all_observations.len() as u64;
    if let Some(previous) = prior_checkpoint {
        if record_count < previous.record_count {
            return Err(JsonlError::HistoricalRecordCountRegressed);
        }
    }
    let prior_offset = prior_checkpoint
        .map(|checkpoint| checkpoint.last_complete_byte_offset as usize)
        .unwrap_or(0);
    if complete_offset < prior_offset {
        return Err(JsonlError::HistoricalPrefixShortened);
    }
    let appended_bytes = &bytes[prior_offset..complete_offset];
    let prefix_chain_sha256 = match prior_checkpoint {
        Some(previous) if appended_bytes.is_empty() => previous.prefix_chain_sha256,
        _ => source_prefix_chain_hash(
            prior_checkpoint.map(|checkpoint| checkpoint.prefix_chain_sha256),
            appended_bytes,
        ),
    };
    let checkpoint = CompletedScanCheckpoint {
        archive_format_version: ARCHIVE_FORMAT_VERSION,
        chain_hash_version: CHAIN_HASH_VERSION,
        source,
        source_session_id,
        source_transcript_part_id,
        record_count,
        last_source_record_identity: all_observations
            .last()
            .map(|observation| observation.source_record_identity.clone()),
        last_complete_byte_offset: complete_offset as u64,
        observed_file_size: bytes.len() as u64,
        complete_prefix_sha256: sha256(&bytes[..complete_offset]),
        prefix_chain_sha256,
        first_observed_at: prior_checkpoint
            .map(|checkpoint| checkpoint.first_observed_at)
            .unwrap_or(observed_at),
    };
    checkpoint.validate()?;
    let observations = all_observations
        .into_iter()
        .skip(
            prior_checkpoint
                .map(|previous| previous.record_count as usize)
                .unwrap_or(0),
        )
        .collect();
    Ok(JsonlScan {
        observations,
        checkpoint,
        prior_checkpoint: prior_checkpoint.cloned(),
        append_proof: prior_checkpoint.map(|previous| crate::types::ArchiveAppendProof {
            prior_prefix_chain_sha256: previous.prefix_chain_sha256,
            appended_prefix_base64: base64::engine::general_purpose::STANDARD
                .encode(appended_bytes),
        }),
    })
}

pub fn claude_transcript_part_id(raw_identity: &str) -> Result<String, JsonlError> {
    if raw_identity.is_empty() {
        return Err(JsonlError::Archive(ArchiveError::InvalidIdentifier {
            field: "transcript_part_identity",
        }));
    }
    let digest = hash_framed(CLAUDE_TRANSCRIPT_PART_DOMAIN, &[raw_identity.as_bytes()]);
    Ok(format!("claude:part:{digest}"))
}

fn claude_identity(
    value: &Value,
    record_index: usize,
    seen_ids: &mut HashMap<String, usize>,
) -> String {
    // These v1 namespaces are finalized before archive persistence exists; a
    // future derivation change requires a CHAIN_HASH_VERSION bump.
    let stable_id = value
        .get("uuid")
        .or_else(|| value.get("id"))
        .or_else(|| value.get("message").and_then(|message| message.get("id")))
        .or_else(|| value.get("requestId"))
        .or_else(|| value.get("request_id"))
        .or_else(|| value.get("record_id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty());
    match stable_id {
        Some(id) => {
            let occurrence = seen_ids.entry(id.to_string()).or_insert(0);
            let identity = format!("claude:id:{id}:{occurrence}");
            *occurrence += 1;
            identity
        }
        None => format!("claude:index:{record_index}"),
    }
}

fn codex_identity(
    _value: &Value,
    record_index: usize,
    _seen_ids: &mut HashMap<String, usize>,
) -> String {
    format!("codex:line:{record_index}")
}

#[derive(Debug, thiserror::Error)]
pub enum JsonlError {
    #[error(transparent)]
    Archive(#[from] ArchiveError),
    #[error("the JSONL checkpoint belongs to another source session")]
    CheckpointSourceMismatch,
    #[error("the JSONL source was shortened before its completed checkpoint")]
    HistoricalPrefixShortened,
    #[error("the JSONL source changed before its completed checkpoint")]
    HistoricalPrefixChanged,
    #[error("the JSONL source record count moved backwards")]
    HistoricalRecordCountRegressed,
    #[error("the source bytes do not contain the complete checkpoint prefix")]
    WirePrefixUnavailable,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_line_offsets_include_newline_and_exclude_partial_tail() {
        let scan = scan_codex_jsonl("session-1", b"{\"a\":1}\n{\"b\":", 7, None).unwrap();
        assert_eq!(scan.checkpoint.last_complete_byte_offset, 8);
        assert_eq!(scan.checkpoint.observed_file_size, 13);
        assert_eq!(scan.observations.len(), 1);
    }

    #[test]
    fn a_valid_final_record_without_newline_is_complete() {
        let scan = scan_codex_jsonl("session-1", br#"{"a":1}"#, 7, None).unwrap();
        assert_eq!(scan.checkpoint.last_complete_byte_offset, 7);
        assert_eq!(scan.observations.len(), 1);
    }

    #[test]
    fn complete_record_end_offsets_match_scanned_records() {
        let bytes = b"{\"a\":1}\n\n{\"b\":2}\n{\"partial\"";
        let ends = crate::complete_record_end_offsets(bytes).unwrap();
        assert_eq!(ends, vec![8, 17]);
        assert_eq!(
            crate::complete_record_end_offsets(br#"{"a":1}"#).unwrap(),
            vec![7]
        );
    }
}
