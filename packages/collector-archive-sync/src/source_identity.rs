use collector_archive::ArchiveSource;
use serde::{Deserialize, Serialize};

use crate::crypto::encrypt;
use crate::spool::{atomic_write_strict, ArchiveSpool};
use crate::{ArchiveSyncError, ArchiveSyncResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveSourceIdentity {
    pub session: String,
    pub part: String,
    pub started_at: Option<i64>,
    pub file_identity: Option<String>,
    pub identity_prefix: Option<(u64, collector_archive::Sha256Digest)>,
    #[serde(default)]
    pub metadata_hint: Option<String>,
}

impl ArchiveSpool {
    pub fn source_identity(
        &self,
        source: ArchiveSource,
        provenance: &str,
    ) -> ArchiveSyncResult<Option<ArchiveSourceIdentity>> {
        let name = collector_archive::sha256(provenance.as_bytes()).to_string()[7..].to_owned();
        let path = self
            .root
            .join("source-identities")
            .join(source.as_str())
            .join(&name);
        let identity = self.read_encrypted(
            &path,
            &self.aad("source-identity", source, "path", &name),
            |plain| serde_json::from_slice(plain).map_err(|_| ArchiveSyncError::Corrupt),
        )?;
        if let Some(identity) = &identity {
            validate(source, identity)?;
        }
        Ok(identity)
    }

    pub fn commit_source_identity(
        &self,
        source: ArchiveSource,
        provenance: &str,
        identity: &ArchiveSourceIdentity,
    ) -> ArchiveSyncResult<()> {
        validate(source, identity)?;
        let name = collector_archive::sha256(provenance.as_bytes()).to_string()[7..].to_owned();
        let path = self
            .root
            .join("source-identities")
            .join(source.as_str())
            .join(&name);
        let plain = serde_json::to_vec(identity)?;
        let encrypted = encrypt(
            &self.key,
            &self.aad("source-identity", source, "path", &name),
            &plain,
        )?;
        self.write_capped_reserving(&path, &encrypted, 0, atomic_write_strict)
    }
}

fn validate(source: ArchiveSource, identity: &ArchiveSourceIdentity) -> ArchiveSyncResult<()> {
    crate::spool::validate_spool_session_id(&identity.session)?;
    if !identity
        .part
        .starts_with(&format!("{}:part:", source.as_str()))
        || identity
            .file_identity
            .as_ref()
            .is_some_and(|identity| identity.is_empty() || identity.len() > 128)
    {
        return Err(ArchiveSyncError::Corrupt);
    }
    crate::spool::part_file_name(&identity.part)?;
    Ok(())
}

pub fn source_file_identity(metadata: &std::fs::Metadata) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let created = metadata
            .created()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_nanos();
        Some(format!("{}:{}:{created}", metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        None
    }
}
