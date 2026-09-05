use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use collector_archive::{ArchiveSource, CompletedScanCheckpoint};

use crate::crypto::{decrypt, encrypt};
use crate::error::{ArchiveSyncError, ArchiveSyncResult};
use crate::key_store::{ArchiveKeyStore, ArchiveSpoolKey};

/// Exact on-disk cap for the encrypted Archive Spool. Never round or evict to stay under this.
pub const ARCHIVE_SPOOL_CAP_BYTES: u64 = 2_147_483_648;
pub use crate::key_store::ARCHIVE_SPOOL_KEYRING_SERVICE;

const PENDING_KIND: u8 = 1;
const CLAUDE: u8 = 1;
const CODEX: u8 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingArchiveRequest {
    pub source: ArchiveSource,
    pub source_session_id: String,
    pub expected_record_count: u64,
    pub body: Vec<u8>,
}

pub struct ArchiveSpool {
    root: PathBuf,
    org_id: String,
    key: ArchiveSpoolKey,
    cap_bytes: u64,
}

impl ArchiveSpool {
    pub fn open(
        root: impl Into<PathBuf>,
        org_id: impl Into<String>,
        key_store: &dyn ArchiveKeyStore,
    ) -> ArchiveSyncResult<Self> {
        Self::open_with_cap(root, org_id, key_store, ARCHIVE_SPOOL_CAP_BYTES)
    }

    pub fn open_with_cap(
        root: impl Into<PathBuf>,
        org_id: impl Into<String>,
        key_store: &dyn ArchiveKeyStore,
        cap_bytes: u64,
    ) -> ArchiveSyncResult<Self> {
        let root = root.into();
        let org_id = org_id.into();
        fs::create_dir_all(&root)?;
        cleanup_tmp_files(&root)?;
        let key = match key_store.load(&org_id)? {
            Some(key) => key,
            None => {
                let key = ArchiveSpoolKey::generate()?;
                key_store.store(&org_id, &key)?;
                key
            }
        };
        Ok(Self {
            root,
            org_id,
            key,
            cap_bytes,
        })
    }

    pub fn on_disk_bytes(&self) -> ArchiveSyncResult<u64> {
        sum_dir(&self.root)
    }

    pub fn persist_pending(&self, pending: &PendingArchiveRequest) -> ArchiveSyncResult<()> {
        let path = self.pending_path(pending.source, &pending.source_session_id)?;
        let plaintext = encode_pending(pending);
        let aad = self.aad("pending", pending.source, &pending.source_session_id);
        let blob = encrypt(&self.key, &aad, &plaintext)?;
        self.write_capped(&path, &blob)
    }

    pub fn pending(
        &self,
        source: ArchiveSource,
        source_session_id: &str,
    ) -> ArchiveSyncResult<Option<PendingArchiveRequest>> {
        let path = self.pending_path(source, source_session_id)?;
        self.read_encrypted(
            &path,
            &self.aad("pending", source, source_session_id),
            decode_pending,
        )
    }

    pub fn all_pending(&self) -> ArchiveSyncResult<Vec<PendingArchiveRequest>> {
        let mut pending = Vec::new();
        for source in [ArchiveSource::Claude, ArchiveSource::Codex] {
            let dir = self.root.join("pending").join(source.as_str());
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries {
                let entry = entry?;
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("bin") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                    return Err(ArchiveSyncError::Corrupt);
                };
                if validate_spool_session_id(stem).is_err() {
                    return Err(ArchiveSyncError::Corrupt);
                }
                let stem = stem.to_string();
                match self.pending(source, &stem) {
                    Ok(Some(record)) => pending.push(record),
                    Ok(None) => {}
                    Err(err) => return Err(err),
                }
            }
        }
        pending.sort_by(|left, right| {
            left.source
                .as_str()
                .cmp(right.source.as_str())
                .then_with(|| left.source_session_id.cmp(&right.source_session_id))
        });
        Ok(pending)
    }

    pub fn persist_progress(
        &self,
        source: ArchiveSource,
        source_session_id: &str,
        checkpoint: &CompletedScanCheckpoint,
    ) -> ArchiveSyncResult<()> {
        let path = self.progress_path(source, source_session_id)?;
        let plaintext = serde_json::to_vec(checkpoint)?;
        let aad = self.aad("progress", source, source_session_id);
        let blob = encrypt(&self.key, &aad, &plaintext)?;
        self.write_capped(&path, &blob)
    }

    pub fn progress(
        &self,
        source: ArchiveSource,
        source_session_id: &str,
    ) -> ArchiveSyncResult<Option<CompletedScanCheckpoint>> {
        let path = self.progress_path(source, source_session_id)?;
        self.read_encrypted(
            &path,
            &self.aad("progress", source, source_session_id),
            |plain| serde_json::from_slice(plain).map_err(|_| ArchiveSyncError::Corrupt),
        )
    }

    pub fn clear_pending(
        &self,
        source: ArchiveSource,
        source_session_id: &str,
    ) -> ArchiveSyncResult<()> {
        remove_if_present(&self.pending_path(source, source_session_id)?)
    }

    pub fn purge(&self, key_store: &dyn ArchiveKeyStore) -> ArchiveSyncResult<()> {
        Self::purge_at(&self.root, &self.org_id, key_store)
    }

    /// Delete the org spool and key without creating a replacement key.
    pub fn purge_at(
        root: &Path,
        org_id: &str,
        key_store: &dyn ArchiveKeyStore,
    ) -> ArchiveSyncResult<()> {
        if root.exists() {
            fs::remove_dir_all(root)?;
        }
        key_store.delete(org_id)
    }

    /// Open a spool that already has a key. Frozen/grace retention must not mint a new key.
    pub fn open_existing(
        root: impl Into<PathBuf>,
        org_id: impl Into<String>,
        key_store: &dyn ArchiveKeyStore,
    ) -> ArchiveSyncResult<Option<Self>> {
        let root = root.into();
        let org_id = org_id.into();
        match key_store.load(&org_id)? {
            Some(key) => {
                if root.exists() {
                    cleanup_tmp_files(&root)?;
                }
                Ok(Some(Self {
                    root,
                    org_id,
                    key,
                    cap_bytes: ARCHIVE_SPOOL_CAP_BYTES,
                }))
            }
            None => {
                if durable_files_exist(&root)? {
                    Err(ArchiveSyncError::Corrupt)
                } else {
                    Ok(None)
                }
            }
        }
    }

    fn write_capped(&self, path: &Path, blob: &[u8]) -> ArchiveSyncResult<()> {
        let used = self.on_disk_bytes()?;
        let existing = path.metadata().map(|meta| meta.len()).unwrap_or(0);
        let next = used
            .saturating_sub(existing)
            .saturating_add(blob.len() as u64);
        if next > self.cap_bytes {
            return Err(ArchiveSyncError::CapacityExceeded);
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        atomic_write(path, blob)
    }

    fn read_encrypted<T>(
        &self,
        path: &Path,
        aad: &[u8],
        decode: impl FnOnce(&[u8]) -> ArchiveSyncResult<T>,
    ) -> ArchiveSyncResult<Option<T>> {
        match fs::read(path) {
            Ok(blob) => {
                let plain = decrypt(&self.key, aad, &blob)?;
                decode(&plain).map(Some)
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    fn pending_path(
        &self,
        source: ArchiveSource,
        source_session_id: &str,
    ) -> ArchiveSyncResult<PathBuf> {
        Ok(self
            .root
            .join("pending")
            .join(source.as_str())
            .join(session_file_name(source_session_id)?))
    }

    fn progress_path(
        &self,
        source: ArchiveSource,
        source_session_id: &str,
    ) -> ArchiveSyncResult<PathBuf> {
        Ok(self
            .root
            .join("progress")
            .join(source.as_str())
            .join(session_file_name(source_session_id)?))
    }

    fn aad(&self, kind: &str, source: ArchiveSource, source_session_id: &str) -> Vec<u8> {
        format!(
            "{kind}:{}:{}:{source_session_id}",
            self.org_id,
            source.as_str()
        )
        .into_bytes()
    }
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> ArchiveSyncResult<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    if let Some(dir) = path.parent() {
        if let Ok(dir_file) = File::open(dir) {
            let _ = dir_file.sync_all();
        }
    }
    Ok(())
}

pub(crate) fn validate_spool_session_id(value: &str) -> ArchiveSyncResult<()> {
    let is_windows_path = value.len() >= 2
        && value.as_bytes()[0].is_ascii_alphabetic()
        && value.as_bytes()[1] == b':';
    if value.is_empty()
        || value.encode_utf16().count() > 1024
        || value
            .chars()
            .any(|character| character <= '\u{001f}' || character == '\u{007f}')
        || value.contains(['/', '\\'])
        || is_windows_path
        || value == "."
        || value == ".."
    {
        return Err(ArchiveSyncError::InvalidSession);
    }
    Ok(())
}

fn session_file_name(source_session_id: &str) -> ArchiveSyncResult<String> {
    validate_spool_session_id(source_session_id)?;
    Ok(format!("{source_session_id}.bin"))
}

fn encode_pending(pending: &PendingArchiveRequest) -> Vec<u8> {
    let session = pending.source_session_id.as_bytes();
    let mut out = Vec::with_capacity(1 + 1 + 2 + session.len() + 8 + pending.body.len());
    out.push(PENDING_KIND);
    out.push(match pending.source {
        ArchiveSource::Claude => CLAUDE,
        ArchiveSource::Codex => CODEX,
    });
    out.extend_from_slice(&(session.len() as u16).to_be_bytes());
    out.extend_from_slice(session);
    out.extend_from_slice(&pending.expected_record_count.to_be_bytes());
    out.extend_from_slice(&pending.body);
    out
}

fn decode_pending(bytes: &[u8]) -> ArchiveSyncResult<PendingArchiveRequest> {
    if bytes.len() < 1 + 1 + 2 + 8 {
        return Err(ArchiveSyncError::Corrupt);
    }
    if bytes[0] != PENDING_KIND {
        return Err(ArchiveSyncError::Corrupt);
    }
    let source = match bytes[1] {
        CLAUDE => ArchiveSource::Claude,
        CODEX => ArchiveSource::Codex,
        _ => return Err(ArchiveSyncError::Corrupt),
    };
    let session_len = u16::from_be_bytes([bytes[2], bytes[3]]) as usize;
    let session_start: usize = 4;
    let session_end = session_start
        .checked_add(session_len)
        .ok_or(ArchiveSyncError::Corrupt)?;
    let count_end = session_end
        .checked_add(8)
        .ok_or(ArchiveSyncError::Corrupt)?;
    if bytes.len() < count_end {
        return Err(ArchiveSyncError::Corrupt);
    }
    let source_session_id = std::str::from_utf8(&bytes[session_start..session_end])
        .map_err(|_| ArchiveSyncError::Corrupt)?
        .to_string();
    let expected_record_count = u64::from_be_bytes(
        bytes[session_end..count_end]
            .try_into()
            .map_err(|_| ArchiveSyncError::Corrupt)?,
    );
    Ok(PendingArchiveRequest {
        source,
        source_session_id,
        expected_record_count,
        body: bytes[count_end..].to_vec(),
    })
}

fn sum_dir(root: &Path) -> ArchiveSyncResult<u64> {
    if !root.exists() {
        return Ok(0);
    }
    let mut total = 0u64;
    for entry in walkdir_files(root)? {
        if entry.extension().and_then(|ext| ext.to_str()) == Some("tmp") {
            continue;
        }
        total = total.saturating_add(entry.metadata()?.len());
    }
    Ok(total)
}

fn durable_files_exist(root: &Path) -> ArchiveSyncResult<bool> {
    if !root.exists() {
        return Ok(false);
    }
    Ok(walkdir_files(root)?
        .into_iter()
        .any(|path| path.extension().and_then(|ext| ext.to_str()) != Some("tmp")))
}

fn cleanup_tmp_files(root: &Path) -> ArchiveSyncResult<()> {
    for path in walkdir_files(root)? {
        if path.extension().and_then(|ext| ext.to_str()) == Some("tmp") {
            remove_if_present(&path)?;
        }
    }
    Ok(())
}

fn walkdir_files(root: &Path) -> ArchiveSyncResult<Vec<PathBuf>> {
    let mut files = Vec::new();
    if !root.exists() {
        return Ok(files);
    }
    visit(root, &mut files)?;
    Ok(files)
}

fn visit(dir: &Path, files: &mut Vec<PathBuf>) -> ArchiveSyncResult<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            visit(&path, files)?;
        } else if path.is_file() {
            files.push(path);
        }
    }
    Ok(())
}

fn remove_if_present(path: &Path) -> ArchiveSyncResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}
