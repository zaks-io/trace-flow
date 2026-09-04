use std::collections::HashMap;

use serde_json::Value;

use crate::types::{
    sha256, ArchiveError, ArchiveObservation, ArchiveSource, CompletedScanCheckpoint,
    ARCHIVE_FORMAT_VERSION, CHAIN_HASH_VERSION,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonlScan {
    pub observations: Vec<ArchiveObservation>,
    pub checkpoint: CompletedScanCheckpoint,
    /// The scanner verified this historical checkpoint against the source bytes before returning.
    /// It is local proof for the chain builder and is not serialized or uploaded as source data.
    pub prior_checkpoint: Option<CompletedScanCheckpoint>,
}

#[derive(Debug, Clone)]
struct CompleteLine<'a> {
    bytes: &'a [u8],
    value: Value,
}

pub fn scan_claude_jsonl(
    source_session_id: impl Into<String>,
    bytes: &[u8],
    observed_at: i64,
    prior_checkpoint: Option<&CompletedScanCheckpoint>,
) -> Result<JsonlScan, JsonlError> {
    scan_jsonl(
        ArchiveSource::Claude,
        source_session_id,
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
    scan_jsonl(
        ArchiveSource::Codex,
        source_session_id,
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
    let source_session_id = source_session_id.into();
    if let Some(previous) = prior_checkpoint {
        validate_historical_prefix(source, &source_session_id, bytes, previous)?;
    }
    let complete_offset = complete_prefix_offset(bytes)?;
    let lines = complete_lines(&bytes[..complete_offset])?;
    let mut seen_ids = HashMap::new();
    let observations = lines
        .iter()
        .enumerate()
        .map(|(record_index, line)| {
            let record_identity = identity(&line.value, record_index, &mut seen_ids);
            ArchiveObservation::new(
                source,
                source_session_id.clone(),
                record_identity,
                observed_at,
                line.bytes,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let checkpoint = CompletedScanCheckpoint {
        archive_format_version: ARCHIVE_FORMAT_VERSION,
        chain_hash_version: CHAIN_HASH_VERSION,
        source,
        source_session_id,
        record_count: observations.len() as u64,
        last_source_record_identity: observations
            .last()
            .map(|observation| observation.source_record_identity.clone()),
        last_complete_byte_offset: complete_offset as u64,
        observed_file_size: bytes.len() as u64,
        complete_prefix_sha256: sha256(&bytes[..complete_offset]),
        first_observed_at: prior_checkpoint
            .map(|checkpoint| checkpoint.first_observed_at)
            .unwrap_or(observed_at),
    };
    checkpoint.validate()?;
    Ok(JsonlScan {
        observations,
        checkpoint,
        prior_checkpoint: prior_checkpoint.cloned(),
    })
}

fn complete_prefix_offset(bytes: &[u8]) -> Result<usize, JsonlError> {
    let Some(last_newline) = bytes.iter().rposition(|byte| *byte == b'\n') else {
        return if bytes.is_empty() || serde_json::from_slice::<Value>(bytes).is_ok() {
            Ok(bytes.len())
        } else {
            Ok(0)
        };
    };
    let newline_end = last_newline + 1;
    if bytes[newline_end..].is_empty() {
        return Ok(newline_end);
    }
    if bytes[newline_end..].iter().all(u8::is_ascii_whitespace) {
        return Ok(bytes.len());
    }
    if serde_json::from_slice::<Value>(&bytes[newline_end..]).is_ok() {
        Ok(bytes.len())
    } else {
        Ok(newline_end)
    }
}

fn complete_lines(bytes: &[u8]) -> Result<Vec<CompleteLine<'_>>, JsonlError> {
    let mut lines = Vec::new();
    let mut line_start = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        let line_end = index - usize::from(index > line_start && bytes[index - 1] == b'\r');
        let line = &bytes[line_start..line_end];
        add_line(&mut lines, line_start, line)?;
        line_start = index + 1;
    }
    if line_start < bytes.len() {
        add_line(&mut lines, line_start, &bytes[line_start..])?;
    }
    Ok(lines)
}

fn add_line<'a>(
    lines: &mut Vec<CompleteLine<'a>>,
    offset: usize,
    bytes: &'a [u8],
) -> Result<(), JsonlError> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(());
    }
    let value = serde_json::from_slice(bytes).map_err(|_| {
        JsonlError::Archive(ArchiveError::InvalidJsonlRecord {
            offset: offset as u64,
        })
    })?;
    lines.push(CompleteLine { bytes, value });
    Ok(())
}

fn validate_historical_prefix(
    source: ArchiveSource,
    source_session_id: &str,
    bytes: &[u8],
    previous: &CompletedScanCheckpoint,
) -> Result<(), JsonlError> {
    previous.validate()?;
    if previous.source != source || previous.source_session_id != source_session_id {
        return Err(JsonlError::CheckpointSourceMismatch);
    }
    let offset = previous.last_complete_byte_offset as usize;
    if bytes.len() < offset {
        return Err(JsonlError::HistoricalPrefixShortened);
    }
    if sha256(&bytes[..offset]) != previous.complete_prefix_sha256 {
        return Err(JsonlError::HistoricalPrefixChanged);
    }
    Ok(())
}

fn claude_identity(
    value: &Value,
    record_index: usize,
    seen_ids: &mut HashMap<String, usize>,
) -> String {
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
            let identity = format!("claude:{id}:{occurrence}");
            *occurrence += 1;
            identity
        }
        None => format!("claude:line:{record_index}"),
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
}
