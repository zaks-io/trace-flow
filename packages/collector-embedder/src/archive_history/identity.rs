use std::path::PathBuf;

use collector_archive::ArchiveSource;
use collector_archive_sync::{
    archive_source_session_id_from_records, parse_jsonl_records, transcript_part_for_records,
    ArchiveBaselineTarget,
};
use collector_sync::{claude_session_fields, codex_session_fields};
use serde_json::Value;

use super::window::read_identity_window;

#[derive(Debug, Clone)]
pub(super) struct Candidate {
    pub path: PathBuf,
    pub source_path: PathBuf,
    pub decoded: Option<std::sync::Arc<tempfile::TempPath>>,
    pub relative_path: Option<String>,
    pub source: ArchiveSource,
    pub session: String,
    pub part: String,
    pub started_at: Option<i64>,
    pub activity_rank_ms: i64,
    pub size: u64,
    pub complete_extent: u64,
    pub provenance: String,
    pub copies: Vec<PathBuf>,
    pub file_identity: Option<String>,
    pub identity_prefix: Option<(u64, collector_archive::Sha256Digest)>,
}

pub(super) fn identify(
    source: ArchiveSource,
    path: &str,
    mtime_ms: i64,
    size: u64,
    provenance: String,
) -> Result<Candidate, &'static str> {
    let path_buf = PathBuf::from(path);
    let parent = (source == ArchiveSource::Claude)
        .then(|| collector_sync::tool_result_parent(&path_buf))
        .flatten();
    let bytes =
        read_identity_window(parent.as_deref().unwrap_or(&path_buf)).map_err(|_| "archive_io")?;
    let relative_path = parent
        .as_ref()
        .map(|_| {
            path_buf
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| format!("tool-results/{name}"))
                .ok_or("invalid_archive_session")
        })
        .transpose()?;
    let records = parse_jsonl_records(&bytes);
    let session = archive_source_session_id_from_records(source, &records);
    let part = session
        .as_ref()
        .ok()
        .and_then(|_| transcript_part_for_records(source, Some(path), &records).ok());
    let started_at = source_started_at(source, &records);
    let session = session.map_err(|_| "invalid_archive_session")?;
    let part = if let Some(relative) = &relative_path {
        collector_archive::claude_transcript_part_id(relative)
            .map_err(|_| "invalid_archive_session")?
    } else {
        part.ok_or("invalid_archive_session")?
    };
    Ok(Candidate {
        source_path: path_buf.clone(),
        path: path_buf,
        decoded: None,
        relative_path: relative_path.clone(),
        source,
        session,
        part,
        started_at,
        activity_rank_ms: mtime_ms,
        size,
        complete_extent: size,
        provenance,
        copies: Vec::new(),
        file_identity: None,
        identity_prefix: relative_path
            .is_none()
            .then(|| (bytes.len() as u64, collector_archive::sha256(&bytes))),
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
