use std::collections::HashMap;
use std::sync::Mutex;

use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::{ArchiveSyncError, ArchiveSyncResult};

/// Keyring service for the Archive Spool key. Distinct from the Collector Credential service.
pub const ARCHIVE_SPOOL_KEYRING_SERVICE: &str = "trace-flow-archive-spool";

#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct ArchiveSpoolKey([u8; 32]);

impl ArchiveSpoolKey {
    pub fn generate() -> ArchiveSyncResult<Self> {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).map_err(|_| ArchiveSyncError::Crypto)?;
        Ok(Self(bytes))
    }

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Debug for ArchiveSpoolKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ArchiveSpoolKey(<redacted>)")
    }
}

pub trait ArchiveKeyStore: Send + Sync {
    fn load(&self, org_id: &str) -> ArchiveSyncResult<Option<ArchiveSpoolKey>>;
    fn store(&self, org_id: &str, key: &ArchiveSpoolKey) -> ArchiveSyncResult<()>;
    fn delete(&self, org_id: &str) -> ArchiveSyncResult<()>;
}

#[derive(Default)]
pub struct MemoryKeyStore {
    keys: Mutex<HashMap<String, [u8; 32]>>,
}

impl MemoryKeyStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ArchiveKeyStore for MemoryKeyStore {
    fn load(&self, org_id: &str) -> ArchiveSyncResult<Option<ArchiveSpoolKey>> {
        Ok(self
            .keys
            .lock()
            .expect("archive key store")
            .get(org_id)
            .copied()
            .map(ArchiveSpoolKey::from_bytes))
    }

    fn store(&self, org_id: &str, key: &ArchiveSpoolKey) -> ArchiveSyncResult<()> {
        self.keys
            .lock()
            .expect("archive key store")
            .insert(org_id.to_string(), *key.as_bytes());
        Ok(())
    }

    fn delete(&self, org_id: &str) -> ArchiveSyncResult<()> {
        self.keys.lock().expect("archive key store").remove(org_id);
        Ok(())
    }
}

pub struct OsKeyStore;

impl ArchiveKeyStore for OsKeyStore {
    fn load(&self, org_id: &str) -> ArchiveSyncResult<Option<ArchiveSpoolKey>> {
        let entry = keyring::Entry::new(ARCHIVE_SPOOL_KEYRING_SERVICE, org_id)
            .map_err(|_| ArchiveSyncError::KeyUnavailable)?;
        match entry.get_password() {
            Ok(hex) => Ok(Some(decode_key_hex(&hex)?)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(ArchiveSyncError::KeyUnavailable),
        }
    }

    fn store(&self, org_id: &str, key: &ArchiveSpoolKey) -> ArchiveSyncResult<()> {
        let entry = keyring::Entry::new(ARCHIVE_SPOOL_KEYRING_SERVICE, org_id)
            .map_err(|_| ArchiveSyncError::KeyUnavailable)?;
        entry
            .set_password(&encode_key_hex(key))
            .map_err(|_| ArchiveSyncError::KeyUnavailable)
    }

    fn delete(&self, org_id: &str) -> ArchiveSyncResult<()> {
        let entry = keyring::Entry::new(ARCHIVE_SPOOL_KEYRING_SERVICE, org_id)
            .map_err(|_| ArchiveSyncError::KeyUnavailable)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(ArchiveSyncError::KeyUnavailable),
        }
    }
}

fn encode_key_hex(key: &ArchiveSpoolKey) -> String {
    key.as_bytes()
        .iter()
        .fold(String::with_capacity(64), |mut out, byte| {
            use std::fmt::Write as _;
            let _ = write!(out, "{byte:02x}");
            out
        })
}

fn decode_key_hex(value: &str) -> ArchiveSyncResult<ArchiveSpoolKey> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ArchiveSyncError::Corrupt);
    }
    let mut bytes = [0u8; 32];
    let (pairs, remainder) = value.as_bytes().as_chunks::<2>();
    if !remainder.is_empty() {
        return Err(ArchiveSyncError::Corrupt);
    }
    for (index, chunk) in pairs.iter().enumerate() {
        bytes[index] = u8::from_str_radix(std::str::from_utf8(chunk).expect("hex"), 16)
            .map_err(|_| ArchiveSyncError::Corrupt)?;
    }
    Ok(ArchiveSpoolKey::from_bytes(bytes))
}
