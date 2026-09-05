use serde_json::Value;

use crate::jsonl::{JsonlError, JsonlLine};
use crate::jsonl_whitespace::is_archive_blank_byte;
use crate::types::{sha256, ArchiveSource, CompletedScanCheckpoint};

pub(crate) fn complete_prefix_offset(bytes: &[u8]) -> Result<usize, JsonlError> {
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
    if bytes[newline_end..].iter().all(is_archive_blank_byte) {
        return Ok(newline_end);
    }
    if serde_json::from_slice::<Value>(&bytes[newline_end..]).is_ok() {
        Ok(bytes.len())
    } else {
        Ok(newline_end)
    }
}

/// End offsets of every complete JSONL record, using the same newline and blank-line
/// rules as [`complete_prefix_offset`] and [`complete_lines`].
pub fn complete_record_end_offsets(bytes: &[u8]) -> Result<Vec<usize>, JsonlError> {
    let prefix = complete_prefix_offset(bytes)?;
    let mut ends = Vec::new();
    let mut line_start = 0;
    for (index, byte) in bytes[..prefix].iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        let line = &bytes[line_start..index];
        if !line.iter().all(is_archive_blank_byte) {
            serde_json::from_slice::<Value>(line).map_err(|_| {
                JsonlError::Archive(crate::types::ArchiveError::InvalidJsonlRecord {
                    offset: line_start as u64,
                })
            })?;
            ends.push(index + 1);
        }
        line_start = index + 1;
    }
    if line_start < prefix {
        let line = &bytes[line_start..prefix];
        if !line.iter().all(is_archive_blank_byte) {
            serde_json::from_slice::<Value>(line).map_err(|_| {
                JsonlError::Archive(crate::types::ArchiveError::InvalidJsonlRecord {
                    offset: line_start as u64,
                })
            })?;
            ends.push(prefix);
        }
    }
    Ok(ends)
}

pub(crate) fn complete_lines(bytes: &[u8]) -> Result<Vec<JsonlLine<'_>>, JsonlError> {
    let mut lines = Vec::new();
    let mut line_start = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        let line = &bytes[line_start..index];
        add_line(&mut lines, line_start, line)?;
        line_start = index + 1;
    }
    if line_start < bytes.len() {
        add_line(&mut lines, line_start, &bytes[line_start..])?;
    }
    Ok(lines)
}

fn add_line<'a>(
    lines: &mut Vec<JsonlLine<'a>>,
    offset: usize,
    bytes: &'a [u8],
) -> Result<(), JsonlError> {
    if bytes.iter().all(is_archive_blank_byte) {
        return Ok(());
    }
    let value = serde_json::from_slice(bytes).map_err(|_| {
        JsonlError::Archive(crate::types::ArchiveError::InvalidJsonlRecord {
            offset: offset as u64,
        })
    })?;
    lines.push(JsonlLine { bytes, value });
    Ok(())
}

pub(crate) fn validate_historical_prefix(
    source: ArchiveSource,
    source_session_id: &str,
    source_transcript_part_id: &str,
    bytes: &[u8],
    previous: &CompletedScanCheckpoint,
) -> Result<(), JsonlError> {
    previous.validate()?;
    if previous.source != source
        || previous.source_session_id != source_session_id
        || previous.source_transcript_part_id != source_transcript_part_id
    {
        return Err(JsonlError::CheckpointSourceMismatch);
    }
    let offset = previous.last_complete_byte_offset as usize;
    if (bytes.len() as u64) < previous.observed_file_size {
        return Err(JsonlError::HistoricalPrefixShortened);
    }
    if bytes.len() < offset {
        return Err(JsonlError::HistoricalPrefixShortened);
    }
    if sha256(&bytes[..offset]) != previous.complete_prefix_sha256 {
        return Err(JsonlError::HistoricalPrefixChanged);
    }
    Ok(())
}
