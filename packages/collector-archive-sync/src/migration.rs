use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{ArchiveKeyStore, ArchiveSpoolKey, ArchiveSyncError, ArchiveSyncResult};

const MARKER: &str = "archive-format.json";

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Migration {
    version: u16,
    key_reference: String,
}

/// The caller must stop the legacy writer before copying. Its encrypted root is
/// retained for rollback; older binaries cannot open the versioned active root.
pub fn prepare_archive_spool(
    legacy: &Path,
    active: &Path,
    org_id: &str,
    keys: &dyn ArchiveKeyStore,
) -> ArchiveSyncResult<()> {
    if legacy == active {
        return Err(ArchiveSyncError::Corrupt);
    }
    let expected = Migration {
        version: 2,
        key_reference: format!("{org_id}:archive-v2"),
    };
    if active.exists() {
        let actual: Migration = serde_json::from_slice(&fs::read(active.join(MARKER))?)?;
        return if actual == expected {
            Ok(())
        } else {
            Err(ArchiveSyncError::Corrupt)
        };
    }
    let legacy_key = keys.load(org_id)?;
    let has_legacy = legacy.exists() && fs::read_dir(legacy)?.next().is_some();
    if has_legacy && legacy_key.is_none() {
        return Err(ArchiveSyncError::KeyUnavailable);
    }
    match keys.load(&expected.key_reference)? {
        Some(current) => {
            if legacy_key
                .as_ref()
                .is_some_and(|old| old.as_bytes() != current.as_bytes())
            {
                return Err(ArchiveSyncError::KeyUnavailable);
            }
        }
        None => {
            let key = match legacy_key {
                Some(key) => key,
                None => ArchiveSpoolKey::generate()?,
            };
            keys.store(&expected.key_reference, &key)?;
            if keys
                .load(&expected.key_reference)?
                .as_ref()
                .map(|k| k.as_bytes())
                != Some(key.as_bytes())
            {
                return Err(ArchiveSyncError::KeyUnavailable);
            }
        }
    }
    let parent = active.parent().ok_or(ArchiveSyncError::Corrupt)?;
    crate::spool::create_dir_all_strict(parent)?;
    let name = active
        .file_name()
        .ok_or(ArchiveSyncError::Corrupt)?
        .to_string_lossy();
    let staging = parent.join(format!(".{name}.migration"));
    match fs::create_dir(&staging) {
        Ok(()) => {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(staging.join(MARKER))?;
            file.write_all(&serde_json::to_vec(&expected)?)?;
            file.sync_all()?;
            crate::spool::sync_directory(&staging)?;
            crate::spool::sync_directory(parent)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let actual: Migration = serde_json::from_slice(&fs::read(staging.join(MARKER))?)?;
            if actual != expected {
                return Err(ArchiveSyncError::Corrupt);
            }
        }
        Err(error) => return Err(error.into()),
    }
    if legacy.exists() {
        copy_directory(legacy, &staging)?;
    }
    crate::spool::sync_directory(&staging)?;
    fs::rename(&staging, active)?;
    crate::spool::sync_directory(parent)?;
    Ok(())
}

pub(crate) fn spool_key_reference(root: &Path, org_id: &str) -> ArchiveSyncResult<String> {
    match fs::read(root.join(MARKER)) {
        Ok(bytes) => {
            let marker: Migration = serde_json::from_slice(&bytes)?;
            if marker.version != 2 || marker.key_reference != format!("{org_id}:archive-v2") {
                return Err(ArchiveSyncError::Corrupt);
            }
            Ok(marker.key_reference)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(org_id.to_string()),
        Err(error) => Err(error.into()),
    }
}

fn copy_directory(source: &Path, destination: &Path) -> ArchiveSyncResult<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if entry.file_name() == MARKER || entry.file_name().to_string_lossy().ends_with(".copying")
        {
            return Err(ArchiveSyncError::Corrupt);
        }
        if kind.is_symlink() {
            return Err(ArchiveSyncError::Corrupt);
        }
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            crate::spool::create_dir_all_strict(&target)?;
            copy_directory(&entry.path(), &target)?;
            crate::spool::sync_directory(&target)?;
        } else if kind.is_file() {
            if target.exists() {
                if !same_bytes(&entry.path(), &target)? {
                    return Err(ArchiveSyncError::Corrupt);
                }
                continue;
            }
            // The staging directory is owned by the marker above. A partial
            // scratch copy is recoverable from the untouched legacy file.
            let scratch = target.with_extension(format!(
                "{}.copying",
                target.extension().unwrap_or_default().to_string_lossy()
            ));
            let mut input = File::open(entry.path())?;
            let mut output = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&scratch)?;
            std::io::copy(&mut input, &mut output)?;
            output.sync_all()?;
            fs::rename(scratch, target)?;
            crate::spool::sync_directory(destination)?;
        } else {
            return Err(ArchiveSyncError::Corrupt);
        }
    }
    Ok(())
}

fn same_bytes(left: &Path, right: &Path) -> std::io::Result<bool> {
    let mut left = File::open(left)?;
    let mut right = File::open(right)?;
    if left.metadata()?.len() != right.metadata()?.len() {
        return Ok(false);
    }
    let mut a = [0; 64 * 1024];
    let mut b = [0; 64 * 1024];
    loop {
        let count = left.read(&mut a)?;
        if count == 0 {
            return Ok(true);
        }
        right.read_exact(&mut b[..count])?;
        if a[..count] != b[..count] {
            return Ok(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MemoryKeyStore;

    #[test]
    fn old_binary_cleanup_cannot_destroy_the_active_spool_key() {
        let temp = tempfile::TempDir::new().unwrap();
        let old = temp.path().join("legacy");
        let active = temp.path().join("v2");
        let keys = MemoryKeyStore::new();
        crate::ArchiveSpool::open(&old, "org", &keys).unwrap();
        prepare_archive_spool(&old, &active, "org", &keys).unwrap();
        assert!(keys.load("org:archive-v2").unwrap().is_some());
        crate::ArchiveSpool::purge_at(&old, "org", &keys).unwrap();
        assert!(keys.load("org").unwrap().is_none());
        assert!(crate::ArchiveSpool::open_existing(&active, "org", &keys)
            .unwrap()
            .is_some());
        crate::ArchiveSpool::purge_at(&active, "org", &keys).unwrap();
        assert!(keys.load("org:archive-v2").unwrap().is_none());
    }

    #[test]
    fn resumes_partial_copy_and_refuses_conflicting_completed_copy() {
        let temp = tempfile::TempDir::new().unwrap();
        let old = temp.path().join("legacy");
        let active = temp.path().join("v2");
        let staging = temp.path().join(".v2.migration");
        fs::create_dir(&old).unwrap();
        fs::create_dir(&staging).unwrap();
        fs::write(old.join("pending.bin"), b"encrypted original").unwrap();
        fs::write(
            staging.join(MARKER),
            serde_json::to_vec(&Migration {
                version: 2,
                key_reference: "org:archive-v2".into(),
            })
            .unwrap(),
        )
        .unwrap();
        fs::write(staging.join("pending.bin.copying"), b"partial").unwrap();
        let keys = MemoryKeyStore::new();
        keys.store("org", &ArchiveSpoolKey::generate().unwrap())
            .unwrap();
        prepare_archive_spool(&old, &active, "org", &keys).unwrap();
        assert_eq!(
            fs::read(active.join("pending.bin")).unwrap(),
            b"encrypted original"
        );
        assert!(!active.join("pending.bin.copying").exists());
        fs::rename(&active, &staging).unwrap();
        fs::write(staging.join("pending.bin"), b"conflicting completed copy").unwrap();
        assert!(matches!(
            prepare_archive_spool(&old, &active, "org", &keys),
            Err(ArchiveSyncError::Corrupt)
        ));
        assert_eq!(
            fs::read(old.join("pending.bin")).unwrap(),
            b"encrypted original"
        );
        assert_eq!(
            fs::read(staging.join("pending.bin")).unwrap(),
            b"conflicting completed copy"
        );
    }

    #[test]
    fn migration_retains_original_and_requires_its_key() {
        let temp = tempfile::TempDir::new().unwrap();
        let old = temp.path().join("legacy");
        let active = temp.path().join("v2");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("pending.bin"), b"encrypted original").unwrap();
        let keys = MemoryKeyStore::new();
        assert!(matches!(
            prepare_archive_spool(&old, &active, "org", &keys),
            Err(ArchiveSyncError::KeyUnavailable)
        ));
        keys.store("org", &ArchiveSpoolKey::generate().unwrap())
            .unwrap();
        prepare_archive_spool(&old, &active, "org", &keys).unwrap();
        assert_eq!(
            fs::read(old.join("pending.bin")).unwrap(),
            fs::read(active.join("pending.bin")).unwrap()
        );
        fs::write(active.join("new.bin"), b"new encrypted capture").unwrap();
        prepare_archive_spool(&old, &active, "org", &keys).unwrap();
        assert!(!old.join("new.bin").exists());
        assert!(active.join("new.bin").exists());
    }
}
