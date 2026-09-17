use std::fs;
use std::io;
use std::path::PathBuf;

use collector_archive::ArchiveSource;

use crate::crypto::encrypt;
use crate::error::{ArchiveSyncError, ArchiveSyncResult};
use crate::spool::{
    atomic_write_strict, part_file_name, part_id_from_file_stem, session_dir_name, ArchiveSpool,
};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ArchiveGenerationHistoryEntry {
    pub part_id: String,
    pub superseded_at: i64,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ArchiveGenerationRecord {
    pub current_part_id: String,
    pub history: Vec<ArchiveGenerationHistoryEntry>,
}

impl ArchiveSpool {
    pub fn current_part(
        &self,
        source: ArchiveSource,
        source_session_id: &str,
        base_part: &str,
    ) -> ArchiveSyncResult<String> {
        Ok(self
            .generation_record(source, source_session_id, base_part)?
            .map(|record| record.current_part_id)
            .unwrap_or_else(|| base_part.to_string()))
    }

    pub fn generation_record(
        &self,
        source: ArchiveSource,
        source_session_id: &str,
        base_part: &str,
    ) -> ArchiveSyncResult<Option<ArchiveGenerationRecord>> {
        let path = self.generation_path(source, source_session_id, base_part)?;
        let record = self.read_encrypted(
            &path,
            &self.aad("generation", source, source_session_id, base_part),
            |plain| serde_json::from_slice(plain).map_err(|_| ArchiveSyncError::Corrupt),
        )?;
        if let Some(record) = &record {
            validate_generation_record(source, record)?;
        }
        Ok(record)
    }

    pub(crate) fn part_is_superseded(
        &self,
        source: ArchiveSource,
        source_session_id: &str,
        part_id: &str,
    ) -> ArchiveSyncResult<bool> {
        let directory = self
            .root
            .join("generations")
            .join(source.as_str())
            .join(session_dir_name(source_session_id)?);
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("bin") {
                continue;
            }
            let base_part = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .and_then(part_id_from_file_stem)
                .ok_or(ArchiveSyncError::Corrupt)?;
            let Some(record) = self.generation_record(source, source_session_id, &base_part)?
            else {
                continue;
            };
            if record.history.iter().any(|entry| entry.part_id == part_id) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn fork_part(
        &self,
        source: ArchiveSource,
        source_session_id: &str,
        base_part: &str,
        previous_part: &str,
        new_part: &str,
        reason: &str,
        now_ms: i64,
    ) -> ArchiveSyncResult<()> {
        part_file_name(base_part)?;
        part_file_name(previous_part)?;
        part_file_name(new_part)?;
        if !part_belongs_to_source(source, base_part)
            || !part_belongs_to_source(source, previous_part)
            || !part_belongs_to_source(source, new_part)
            || !matches!(reason, "prefix_changed" | "prefix_shortened")
        {
            return Err(ArchiveSyncError::Corrupt);
        }
        let mut generation = self
            .generation_record(source, source_session_id, base_part)?
            .unwrap_or_else(|| ArchiveGenerationRecord {
                current_part_id: base_part.to_string(),
                history: Vec::new(),
            });
        if generation.current_part_id != previous_part && generation.current_part_id != new_part {
            return Err(ArchiveSyncError::Corrupt);
        }

        // The new generation must be durable before the superseded part's queued data goes,
        // or a failed write leaves the old part current with its spool already emptied.
        if generation.current_part_id != new_part {
            generation.history.push(ArchiveGenerationHistoryEntry {
                part_id: previous_part.to_string(),
                superseded_at: now_ms,
                reason: reason.to_string(),
            });
            generation.current_part_id = new_part.to_string();
            let plaintext = serde_json::to_vec(&generation)?;
            let aad = self.aad("generation", source, source_session_id, base_part);
            let blob = encrypt(&self.key, &aad, &plaintext)?;
            self.write_capped_reserving(
                &self.generation_path(source, source_session_id, base_part)?,
                &blob,
                0,
                atomic_write_strict,
            )?;
        }
        self.clear_slices_for_part(source, source_session_id, previous_part)?;
        self.clear_blocked_part(source, source_session_id, previous_part)
    }

    fn generation_path(
        &self,
        source: ArchiveSource,
        source_session_id: &str,
        base_part: &str,
    ) -> ArchiveSyncResult<PathBuf> {
        Ok(self
            .root
            .join("generations")
            .join(source.as_str())
            .join(session_dir_name(source_session_id)?)
            .join(part_file_name(base_part)?))
    }
}

fn validate_generation_record(
    source: ArchiveSource,
    record: &ArchiveGenerationRecord,
) -> ArchiveSyncResult<()> {
    part_file_name(&record.current_part_id)?;
    if !part_belongs_to_source(source, &record.current_part_id)
        || record.history.iter().any(|entry| {
            entry.part_id == record.current_part_id
                || !part_belongs_to_source(source, &entry.part_id)
                || part_file_name(&entry.part_id).is_err()
                || !matches!(entry.reason.as_str(), "prefix_changed" | "prefix_shortened")
        })
    {
        return Err(ArchiveSyncError::Corrupt);
    }
    Ok(())
}

fn part_belongs_to_source(source: ArchiveSource, part_id: &str) -> bool {
    part_id.starts_with(&format!("{}:part:", source.as_str()))
}
