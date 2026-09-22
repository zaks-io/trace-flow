use std::fs::File;
use std::path::Path;
use std::sync::Arc;

use collector_archive::ArchiveSource;
use collector_archive_sync::{ArchiveSourceIdentity, ArchiveSpool};

use super::identity::{identify, Candidate};
use super::DecodedSource;

pub(super) fn identify_compressed(
    spool: &ArchiveSpool,
    path: &Path,
    provenance: String,
) -> Result<Candidate, &'static str> {
    materialize(spool, path, provenance).map_err(|_| "archive_compressed_source")
}

fn materialize(spool: &ArchiveSpool, path: &Path, provenance: String) -> anyhow::Result<Candidate> {
    let input = File::open(path)?;
    let before = input.metadata()?;
    let lease = spool.acquire_scratch_lease()?;
    let scratch = spool.scratch_dir();
    let mut decoded = tempfile::Builder::new()
        .prefix("rollout-")
        .suffix(".decoded")
        .tempfile_in(scratch)?;
    let mut decoder = zstd::stream::read::Decoder::new(input)?;
    std::io::copy(&mut decoder, &mut decoded)?;
    let after = decoder.get_ref().get_ref().metadata()?;
    anyhow::ensure!(
        before.len() == after.len() && before.modified()? == after.modified()?,
        "compressed source changed"
    );
    let mtime = i64::try_from(
        before
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis(),
    )?;
    let size = decoded.as_file().metadata()?.len();
    let mut candidate = identify(
        ArchiveSource::Codex,
        decoded
            .path()
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("invalid scratch path"))?,
        mtime,
        size,
        provenance.clone(),
    )
    .map_err(anyhow::Error::msg)?;
    let identity = ArchiveSourceIdentity {
        session: candidate.session.clone(),
        part: candidate.part.clone(),
        started_at: candidate.started_at,
        file_identity: collector_archive_sync::source_file_identity(&before),
        identity_prefix: candidate.identity_prefix,
        metadata_hint: None,
    };
    spool.commit_source_identity(ArchiveSource::Codex, &provenance, &identity)?;
    candidate.file_identity =
        collector_archive_sync::source_file_identity(&decoded.as_file().metadata()?);
    candidate.source_path = path.to_path_buf();
    candidate.decoded = Some(Arc::new(DecodedSource {
        _path: decoded.into_temp_path(),
        _lease: lease,
    }));
    Ok(candidate)
}
