use std::fs::File;
use std::io::{Cursor, Read, Seek, SeekFrom};

use collector_archive::{
    rewrite_byte_part_id_from_digest, sha256_reader, JsonlError, SourceByteReader,
};
use tokio_util::sync::CancellationToken;

use crate::bound::pending_from_byte_scan;
use crate::cycle::{record_error, ArchiveCycleReport, ArchiveForkEvent, ArchiveSnapshot};
use crate::error::{ArchiveSyncError, ArchiveSyncResult};
use crate::spool::{ArchiveSpool, PendingCaptureAuthorization};
use crate::ARCHIVE_CAPTURE_WINDOW_BYTES;

#[allow(clippy::too_many_arguments)]
pub(crate) fn persist_snapshot(
    spool: &ArchiveSpool,
    snapshot: &ArchiveSnapshot,
    report: &mut ArchiveCycleReport,
    now_ms: i64,
    cancel: Option<&CancellationToken>,
    prefetched_source_bytes: Option<&[u8]>,
    authorization: PendingCaptureAuthorization,
) -> Result<(), &'static str> {
    let result = match (&snapshot.deferred_file, prefetched_source_bytes) {
        (_, Some(bytes)) => capture(
            spool,
            snapshot,
            Cursor::new(bytes),
            bytes.len() as u64,
            authorization,
            report,
            now_ms,
            cancel,
        ),
        (Some(deferred), None) => File::open(&deferred.path)
            .map_err(ArchiveSyncError::from)
            .and_then(|mut file| {
                let metadata = file.metadata()?;
                if deferred
                    .expected_file_identity
                    .as_ref()
                    .is_some_and(|expected| {
                        crate::source_file_identity(&metadata).as_ref() != Some(expected)
                    })
                {
                    return Err(ArchiveSyncError::InvalidSession);
                }
                if let Some((length, digest)) = deferred.expected_identity_prefix {
                    if length > metadata.len() || sha256_reader((&mut file).take(length))? != digest
                    {
                        return Err(ArchiveSyncError::InvalidSession);
                    }
                    file.seek(SeekFrom::Start(0))?;
                }
                let size = metadata.len();
                capture(
                    spool,
                    snapshot,
                    file,
                    size,
                    authorization,
                    report,
                    now_ms,
                    cancel,
                )
            }),
        (None, None) => capture(
            spool,
            snapshot,
            Cursor::new(&snapshot.bytes),
            snapshot.bytes.len() as u64,
            authorization,
            report,
            now_ms,
            cancel,
        ),
    };
    result.map_err(|error| {
        report.failed += 1;
        record_error(report, error.class());
        error.class()
    })
}

#[allow(clippy::too_many_arguments)]
fn capture<R: Read + Seek>(
    spool: &ArchiveSpool,
    snapshot: &ArchiveSnapshot,
    mut source: R,
    size: u64,
    authorization: PendingCaptureAuthorization,
    report: &mut ArchiveCycleReport,
    now_ms: i64,
    cancel: Option<&CancellationToken>,
) -> ArchiveSyncResult<()> {
    let mut part = spool.byte_capture_part(
        snapshot.source,
        &snapshot.source_session_id,
        &snapshot.base_transcript_part_id,
        now_ms,
    )?;
    let mut prior =
        spool.latest_captured_checkpoint(snapshot.source, &snapshot.source_session_id, &part)?;
    loop {
        let predecessor = spool.predecessor_part(
            snapshot.source,
            &snapshot.source_session_id,
            &snapshot.base_transcript_part_id,
            &part,
        )?;
        let reader = if prior
            .as_ref()
            .is_some_and(|checkpoint| checkpoint.observed_file_size > size)
        {
            Err(JsonlError::HistoricalPrefixShortened)
        } else {
            SourceByteReader::new(
                (&mut source).take(size),
                snapshot.source,
                &snapshot.source_session_id,
                &part,
                snapshot.observed_at,
                prior.as_ref(),
            )
        };
        match reader {
            Ok(reader) => {
                if size == 0 && prior.is_none() {
                    let scan = collector_archive::scan_source_bytes(
                        snapshot.source,
                        &snapshot.source_session_id,
                        &part,
                        &[],
                        snapshot.observed_at,
                        None,
                    )?;
                    let pending = pending_from_byte_scan(scan)?
                        .with_relative_path(snapshot.relative_path.as_deref())?
                        .with_capture_metadata(authorization, predecessor);
                    spool.persist_slice(&pending)?;
                    report.captured += 1;
                    return Ok(());
                }
                let mut reader = reader
                    .with_observed_file_size(size)
                    .with_predecessor(predecessor.as_deref())?;
                // Fair local passes preserve active conversations during a large backfill.
                let mut captured = 0;
                while !cancel.is_some_and(CancellationToken::is_cancelled) {
                    let Some(scan) = reader.next_segment()? else {
                        break;
                    };
                    let bytes = scan.checkpoint.last_complete_byte_offset
                        - scan
                            .prior_checkpoint
                            .as_ref()
                            .map_or(0, |p| p.last_complete_byte_offset);
                    let pending = pending_from_byte_scan(scan)?
                        .with_relative_path(snapshot.relative_path.as_deref())?
                        .with_capture_metadata(authorization, predecessor.clone());
                    spool.persist_slice(&pending)?;
                    report.captured += 1;
                    captured += bytes;
                    if snapshot.deferred_file.is_some() && captured >= ARCHIVE_CAPTURE_WINDOW_BYTES
                    {
                        break;
                    }
                }
                return Ok(());
            }
            Err(
                error @ (JsonlError::HistoricalPrefixChanged
                | JsonlError::HistoricalPrefixShortened),
            ) => {
                let reason = match error {
                    JsonlError::HistoricalPrefixShortened => "prefix_shortened",
                    _ => "prefix_changed",
                };
                source.seek(SeekFrom::Start(0))?;
                let digest = sha256_reader((&mut source).take(size))?;
                let new_part = rewrite_byte_part_id_from_digest(snapshot.source, &part, digest)?;
                spool.fork_part(
                    snapshot.source,
                    &snapshot.source_session_id,
                    &snapshot.base_transcript_part_id,
                    &part,
                    &new_part,
                    reason,
                    now_ms,
                )?;
                report.fork_events.push(ArchiveForkEvent {
                    source: snapshot.source,
                    source_session_id: snapshot.source_session_id.clone(),
                    previous_part_id: part,
                    new_part_id: new_part.clone(),
                    reason: reason.to_string(),
                    previous_offset: prior.as_ref().map_or(0, |p| p.last_complete_byte_offset),
                    new_size: size,
                });
                report.forked += 1;
                part = new_part;
                prior = None;
                source.seek(SeekFrom::Start(0))?;
            }
            Err(error) => return Err(error.into()),
        }
    }
}
