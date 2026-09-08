use std::path::PathBuf;

use collector_archive::ArchiveSource;
use collector_archive_sync::{
    archive_source_session_id_from_records, parse_jsonl_records, transcript_part_for_records,
    ArchiveBaselineTarget,
};
use collector_sync::{claude_session_fields, codex_session_fields};
use serde_json::Value;

use super::window::{complete_extent, read_identity_window};

#[derive(Debug, Clone)]
pub(super) struct Candidate {
    pub path: PathBuf,
    pub source: ArchiveSource,
    pub session: String,
    pub part: String,
    pub part_identity: Option<String>,
    pub started_at: Option<i64>,
    pub activity_rank_ms: i64,
    pub size: u64,
    pub complete_extent: u64,
    pub copies: Vec<PathBuf>,
}

pub(super) fn identify(
    source: ArchiveSource,
    path: &str,
    mtime_ms: i64,
    size: u64,
) -> Result<Candidate, &'static str> {
    let path_buf = PathBuf::from(path);
    let bytes = read_identity_window(&path_buf).map_err(|_| "archive_io")?;
    let records = parse_jsonl_records(&bytes);
    let session = archive_source_session_id_from_records(source, &records);
    let part = session
        .as_ref()
        .ok()
        .and_then(|_| transcript_part_for_records(source, Some(path), &records).ok());
    let started_at = source_started_at(source, &records);
    let session = session.map_err(|_| "invalid_archive_session")?;
    let (part, part_identity) = part.ok_or("invalid_archive_session")?;
    let complete_extent = complete_extent(&path_buf).map_err(|_| "archive_io")?;
    Ok(Candidate {
        path: path_buf,
        source,
        session,
        part,
        part_identity,
        started_at,
        activity_rank_ms: mtime_ms,
        size,
        complete_extent,
        copies: Vec::new(),
    })
}

fn source_started_at(source: ArchiveSource, records: &[Value]) -> Option<i64> {
    match source {
        ArchiveSource::Claude => claude_session_fields(records).vendor_started_at,
        ArchiveSource::Codex => codex_session_fields(records).fields.vendor_started_at,
    }
}

pub(super) fn target_from(candidate: &Candidate) -> ArchiveBaselineTarget {
    ArchiveBaselineTarget {
        source_session_id: candidate.session.clone(),
        source_transcript_part_id: candidate.part.clone(),
        activity_rank_ms: candidate.activity_rank_ms,
        registered_size_bytes: candidate.size,
        registered_complete_byte_offset: candidate.complete_extent,
    }
}
