use std::path::PathBuf;

use collector_archive::ArchiveSource;
use collector_archive_sync::{ArchiveSourceIdentity, ArchiveSpool};

use super::identity::{identify, Candidate};

pub(super) fn identify_remembered(
    spool: &ArchiveSpool,
    source: ArchiveSource,
    path: &str,
    mtime_ms: i64,
    size: u64,
    provenance: String,
    verify_contents: bool,
) -> Result<Candidate, &'static str> {
    let metadata = std::fs::metadata(path).map_err(|_| "archive_io")?;
    let file_identity = collector_archive_sync::source_file_identity(&metadata);
    let metadata_hint = metadata
        .modified()
        .ok()
        .and_then(epoch_nanos)
        .map(|modified| format!("{}:{modified}", metadata.len()));
    let remembered = spool
        .source_identity(source, &provenance)
        .map_err(|e| e.class())?;
    if !verify_contents {
        if let Some(identity) = remembered.as_ref().filter(|identity| {
            file_identity.is_some()
                && identity.file_identity == file_identity
                && metadata_hint.is_some()
                && identity.metadata_hint == metadata_hint
        }) {
            return Ok(candidate_from_identity(
                identity.clone(),
                source,
                path,
                mtime_ms,
                size,
                provenance,
            ));
        }
    }
    match identify(source, path, mtime_ms, size, provenance.clone()) {
        Ok(mut candidate) => {
            candidate.file_identity = file_identity.clone();
            let identity = ArchiveSourceIdentity {
                session: candidate.session.clone(),
                part: candidate.part.clone(),
                started_at: candidate.started_at,
                file_identity,
                identity_prefix: candidate.identity_prefix,
                metadata_hint,
            };
            if remembered.as_ref() != Some(&identity) {
                spool
                    .commit_source_identity(source, &provenance, &identity)
                    .map_err(|e| e.class())?;
            }
            Ok(candidate)
        }
        Err("invalid_archive_session") => {
            // An in-place rewrite can erase the header. A replacement file must establish
            // its own identity before new-only consent can authorize its contents.
            let identity = remembered
                .filter(|previous| {
                    file_identity.is_some() && previous.file_identity == file_identity
                })
                .ok_or("invalid_archive_session")?;
            let identity = ArchiveSourceIdentity {
                identity_prefix: None,
                ..identity
            };
            Ok(candidate_from_identity(
                identity, source, path, mtime_ms, size, provenance,
            ))
        }
        Err(error) => Err(error),
    }
}

fn candidate_from_identity(
    identity: ArchiveSourceIdentity,
    source: ArchiveSource,
    path: &str,
    mtime_ms: i64,
    size: u64,
    provenance: String,
) -> Candidate {
    Candidate {
        path: PathBuf::from(path),
        source,
        session: identity.session,
        part: identity.part,
        started_at: identity.started_at,
        activity_rank_ms: mtime_ms,
        size,
        complete_extent: size,
        provenance,
        copies: Vec::new(),
        file_identity: identity.file_identity,
        identity_prefix: identity.identity_prefix,
    }
}

fn epoch_nanos(time: std::time::SystemTime) -> Option<u128> {
    time.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_nanos())
}
