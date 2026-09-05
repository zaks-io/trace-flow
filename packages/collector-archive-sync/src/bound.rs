use collector_archive::{
    complete_record_end_offsets, ArchiveSource, CompletedScanCheckpoint, JsonlScan,
};

use crate::error::{ArchiveSyncError, ArchiveSyncResult};
use crate::scan::scan_snapshot;
use crate::spool::PendingArchiveRequest;

/// Archive API uncompressed JSON body limit (`apps/archive-api` `MAX_ARCHIVE_UPLOAD_BYTES`).
pub const MAX_ARCHIVE_UPLOAD_BYTES: usize = 8_388_608;
/// Archive API observation-count limit (`apps/archive-api` `MAX_UPLOAD_OBSERVATIONS`).
pub const MAX_UPLOAD_OBSERVATIONS: usize = 16_384;

pub fn build_bounded_pending(
    source: ArchiveSource,
    source_session_id: &str,
    transcript_part_identity: Option<&str>,
    bytes: &[u8],
    observed_at: i64,
    prior: Option<&CompletedScanCheckpoint>,
) -> ArchiveSyncResult<Option<PendingArchiveRequest>> {
    build_bounded_pending_with_limits(
        source,
        source_session_id,
        transcript_part_identity,
        bytes,
        observed_at,
        prior,
        MAX_ARCHIVE_UPLOAD_BYTES,
        MAX_UPLOAD_OBSERVATIONS,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn build_bounded_pending_with_limits(
    source: ArchiveSource,
    source_session_id: &str,
    transcript_part_identity: Option<&str>,
    bytes: &[u8],
    observed_at: i64,
    prior: Option<&CompletedScanCheckpoint>,
    max_bytes: usize,
    max_observations: usize,
) -> ArchiveSyncResult<Option<PendingArchiveRequest>> {
    let scan = scan_snapshot(
        source,
        source_session_id,
        transcript_part_identity,
        bytes,
        observed_at,
        prior,
    )?;
    if scan.observations.is_empty() {
        return Ok(None);
    }
    let ends = complete_record_end_offsets(bytes)?;
    let prior_count = prior
        .map(|checkpoint| checkpoint.record_count as usize)
        .unwrap_or(0);
    let new_count = scan.observations.len();
    if ends.len() < prior_count.saturating_add(new_count) {
        return Err(ArchiveSyncError::Scan(
            collector_archive::JsonlError::WirePrefixUnavailable,
        ));
    }
    let fitted = max_fitting_records(
        source,
        source_session_id,
        transcript_part_identity,
        bytes,
        observed_at,
        prior,
        &ends,
        prior_count,
        new_count,
        max_bytes,
        max_observations,
    )?;
    if fitted == 0 {
        return Err(ArchiveSyncError::UploadTooLarge);
    }
    let prefix_end = ends[prior_count + fitted - 1];
    let bounded = scan_snapshot(
        source,
        source_session_id,
        transcript_part_identity,
        &bytes[..prefix_end],
        observed_at,
        prior,
    )?;
    Ok(Some(pending_from_scan(
        source,
        bounded,
        &bytes[..prefix_end],
    )?))
}

#[allow(clippy::too_many_arguments)]
fn max_fitting_records(
    source: ArchiveSource,
    source_session_id: &str,
    transcript_part_identity: Option<&str>,
    bytes: &[u8],
    observed_at: i64,
    prior: Option<&CompletedScanCheckpoint>,
    ends: &[usize],
    prior_count: usize,
    new_count: usize,
    max_bytes: usize,
    max_observations: usize,
) -> ArchiveSyncResult<usize> {
    let high = new_count.min(max_observations);
    if high == 0 {
        return Ok(0);
    }
    if request_fits(
        source,
        source_session_id,
        transcript_part_identity,
        bytes,
        observed_at,
        prior,
        ends,
        prior_count,
        1,
        max_bytes,
        max_observations,
    )? {
        if high == 1
            || request_fits(
                source,
                source_session_id,
                transcript_part_identity,
                bytes,
                observed_at,
                prior,
                ends,
                prior_count,
                high,
                max_bytes,
                max_observations,
            )?
        {
            return Ok(if high == 1 { 1 } else { high });
        }
    } else {
        return Ok(0);
    }
    let mut lo = 1;
    let mut hi = high;
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        if request_fits(
            source,
            source_session_id,
            transcript_part_identity,
            bytes,
            observed_at,
            prior,
            ends,
            prior_count,
            mid,
            max_bytes,
            max_observations,
        )? {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    Ok(lo)
}

#[allow(clippy::too_many_arguments)]
fn request_fits(
    source: ArchiveSource,
    source_session_id: &str,
    transcript_part_identity: Option<&str>,
    bytes: &[u8],
    observed_at: i64,
    prior: Option<&CompletedScanCheckpoint>,
    ends: &[usize],
    prior_count: usize,
    count: usize,
    max_bytes: usize,
    max_observations: usize,
) -> ArchiveSyncResult<bool> {
    if count == 0 || count > max_observations {
        return Ok(false);
    }
    let prefix_end = ends[prior_count + count - 1];
    let scan = scan_snapshot(
        source,
        source_session_id,
        transcript_part_identity,
        &bytes[..prefix_end],
        observed_at,
        prior,
    )?;
    let request = scan.into_upload_request(&bytes[..prefix_end])?;
    let body = serde_json::to_vec(&request)?;
    Ok(body.len() <= max_bytes && request.observations.len() <= max_observations)
}

fn pending_from_scan(
    source: ArchiveSource,
    scan: JsonlScan,
    source_bytes: &[u8],
) -> ArchiveSyncResult<PendingArchiveRequest> {
    let request = scan.into_upload_request(source_bytes)?;
    let body = serde_json::to_vec(&request)?;
    if body.len() > MAX_ARCHIVE_UPLOAD_BYTES || request.observations.len() > MAX_UPLOAD_OBSERVATIONS
    {
        return Err(ArchiveSyncError::UploadTooLarge);
    }
    Ok(PendingArchiveRequest::from_upload(source, &request, body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use collector_archive::ArchiveSource;

    fn records(count: usize, pad: usize) -> Vec<u8> {
        let mut out = Vec::new();
        for index in 0..count {
            let line = format!(
                r#"{{"sessionId":"bound-session","uuid":"r{index}","pad":"{}"}}"#,
                "x".repeat(pad)
            );
            out.extend_from_slice(line.as_bytes());
            out.push(b'\n');
        }
        out
    }

    fn observation_len(body: &[u8]) -> usize {
        let value: serde_json::Value = serde_json::from_slice(body).unwrap();
        value["observations"].as_array().map(Vec::len).unwrap_or(0)
    }

    #[test]
    fn api_limits_match_archive_api() {
        assert_eq!(MAX_ARCHIVE_UPLOAD_BYTES, 8_388_608);
        assert_eq!(MAX_UPLOAD_OBSERVATIONS, 16_384);
    }

    #[test]
    fn observation_count_bound_keeps_complete_records() {
        let bytes = records(5, 8);
        let pending = build_bounded_pending_with_limits(
            ArchiveSource::Claude,
            "bound-session",
            None,
            &bytes,
            10,
            None,
            MAX_ARCHIVE_UPLOAD_BYTES,
            2,
        )
        .unwrap()
        .expect("bounded pending");
        assert_eq!(observation_len(&pending.body), 2);
        assert_eq!(pending.expected_record_count, 2);
        assert_eq!(pending.expected_appended_records, 2);
        assert!(pending.body.len() <= MAX_ARCHIVE_UPLOAD_BYTES);
        let prior: CompletedScanCheckpoint = serde_json::from_value(
            serde_json::from_slice::<serde_json::Value>(&pending.body).unwrap()["checkpoint"]
                .clone(),
        )
        .unwrap();
        let rest = build_bounded_pending_with_limits(
            ArchiveSource::Claude,
            "bound-session",
            None,
            &bytes,
            11,
            Some(&prior),
            MAX_ARCHIVE_UPLOAD_BYTES,
            2,
        )
        .unwrap()
        .expect("remaining pending");
        assert_eq!(rest.expected_record_count, 4);
        assert_eq!(rest.expected_appended_records, 2);
        let rest_value: serde_json::Value = serde_json::from_slice(&rest.body).unwrap();
        assert_eq!(
            rest_value["prior_checkpoint"]["record_count"],
            prior.record_count
        );
    }

    #[test]
    fn byte_bound_splits_before_the_api_limit() {
        let bytes = records(12, 400_000);
        let pending = build_bounded_pending(
            ArchiveSource::Claude,
            "bound-session",
            None,
            &bytes,
            10,
            None,
        )
        .unwrap()
        .expect("bounded pending");
        assert!(pending.body.len() <= MAX_ARCHIVE_UPLOAD_BYTES);
        assert!(observation_len(&pending.body) < 12);
        assert!(pending.expected_record_count >= 1);
        let full = scan_snapshot(
            ArchiveSource::Claude,
            "bound-session",
            None,
            &bytes,
            10,
            None,
        )
        .unwrap()
        .into_upload_request(&bytes)
        .unwrap();
        assert!(serde_json::to_vec(&full).unwrap().len() > MAX_ARCHIVE_UPLOAD_BYTES);
    }

    #[test]
    fn unsplittable_record_is_too_large() {
        let bytes = records(1, 9_000_000);
        let error = build_bounded_pending(
            ArchiveSource::Claude,
            "bound-session",
            None,
            &bytes,
            10,
            None,
        )
        .unwrap_err();
        assert_eq!(error.class(), "upload_too_large");
    }
}
