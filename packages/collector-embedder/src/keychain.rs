// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector embedder: Collector Credential storage.

//! The Collector Credential store.
//!
//! The raw credential (`tfc_…`) is the only sensitive material the Collector holds. It is keyed by
//! Organization id so disconnecting one org never touches another, and it is never written to the
//! connection file, logged, or passed on argv.
//!
//! Two stores exist because desktop sessions and headless hosts differ:
//! - [`CredentialStore::Keyring`]: the OS keychain (Keychain on macOS, Credential Manager on
//!   Windows, Secret Service on Linux) via the `keyring` crate.
//! - [`CredentialStore::File`]: an owner-only (`0600`) file in the state directory. Headless Linux
//!   hosts and systemd services usually have no Secret Service session, so this is the Linux default.
//!
//! The store is chosen explicitly; a failure in one never silently falls back to the other.
//!
//! `TRACE_FLOW_COLLECTOR_SECRET` overrides either store when set. That is the CI path (the same var
//! `collector-sync`'s `headless_e2e` reads). An env override is read but never persisted.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::connection::{sanitize, Paths};
use crate::private_file;

/// The keychain service name. One service, one entry per org (the account).
const SERVICE: &str = "trace-flow-collector";

/// Env override for headless/CI use. Mirrors `collector-sync`'s E2E harness var.
const ENV_OVERRIDE: &str = "TRACE_FLOW_COLLECTOR_SECRET";

/// Which credential store a configuration selects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialStoreKind {
    Keyring,
    File,
}

impl CredentialStoreKind {
    /// Keyring where desktop sessions provide one; the owner-only file on Linux, where Collector
    /// hosts are usually headless.
    pub fn platform_default() -> Self {
        if cfg!(target_os = "linux") {
            Self::File
        } else {
            Self::Keyring
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Keyring => "OS keychain",
            Self::File => "owner-only file",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialStore {
    Keyring,
    /// Credential files live in this directory, one per Organization.
    File(PathBuf),
}

impl CredentialStore {
    pub fn new(kind: CredentialStoreKind, paths: &Paths) -> Self {
        match kind {
            CredentialStoreKind::Keyring => Self::Keyring,
            CredentialStoreKind::File => Self::File(paths.root().to_path_buf()),
        }
    }

    pub fn platform_default(paths: &Paths) -> Self {
        Self::new(CredentialStoreKind::platform_default(), paths)
    }

    pub fn kind(&self) -> CredentialStoreKind {
        match self {
            Self::Keyring => CredentialStoreKind::Keyring,
            Self::File(_) => CredentialStoreKind::File,
        }
    }

    /// Store the `credential` for `org_id`, replacing any existing entry.
    pub fn store(&self, org_id: &str, credential: &str) -> Result<()> {
        match self {
            Self::Keyring => keyring_entry(org_id)?.set_password(credential).context(
                "write Collector Credential to OS keychain (headless hosts need the file store)",
            ),
            Self::File(dir) => private_file::write(dir, &credential_file(dir, org_id), credential),
        }
    }

    /// Load the credential for `org_id`. Prefers `$TRACE_FLOW_COLLECTOR_SECRET`, else the store.
    /// `Ok(None)` means none is available; the caller surfaces a "log in first" message.
    pub fn load(&self, org_id: &str) -> Result<Option<String>> {
        if let Some(env) = std::env::var_os(ENV_OVERRIDE) {
            let value = env.to_string_lossy().into_owned();
            if !value.is_empty() {
                return Ok(Some(value));
            }
        }
        match self {
            Self::Keyring => match keyring_entry(org_id)?.get_password() {
                Ok(credential) => Ok(Some(credential)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(err) => Err(err).context("read Collector Credential from OS keychain"),
            },
            Self::File(dir) => read_owner_only(&credential_file(dir, org_id)),
        }
    }

    /// Remove the credential for `org_id`. A missing entry is not an error (disconnect is
    /// idempotent). Does not clear an env override; that is the operator's to unset.
    pub fn delete(&self, org_id: &str) -> Result<()> {
        match self {
            Self::Keyring => match keyring_entry(org_id)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(err) => Err(err).context("remove Collector Credential from OS keychain"),
            },
            Self::File(dir) => {
                let path = credential_file(dir, org_id);
                match fs::remove_file(&path) {
                    Ok(()) => Ok(()),
                    Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
                    Err(err) => Err(err).with_context(|| format!("remove {}", path.display())),
                }
            }
        }
    }

    /// Whether a credential is available for `org_id`, without copying it out.
    pub fn is_present(&self, org_id: &str) -> bool {
        self.load(org_id).ok().flatten().is_some()
    }
}

fn keyring_entry(org_id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, org_id).context("open keychain entry")
}

fn credential_file(dir: &Path, org_id: &str) -> PathBuf {
    dir.join(format!("credential-{}", sanitize(org_id)))
}

fn read_owner_only(path: &Path) -> Result<Option<String>> {
    let Some(contents) = private_file::read(path)? else {
        return Ok(None);
    };
    let credential = contents.trim();
    if credential.is_empty() {
        anyhow::bail!("{} is empty; run `trace-flow login` again", path.display());
    }
    Ok(Some(credential.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_store(dir: &Path) -> CredentialStore {
        CredentialStore::new(CredentialStoreKind::File, &Paths::at(dir.to_path_buf()))
    }

    fn stored(dir: &Path, org_id: &str) -> Option<String> {
        read_owner_only(&credential_file(dir, org_id)).unwrap()
    }

    #[test]
    fn file_store_round_trips_per_org_and_deletes_idempotently() {
        let dir = tempfile::tempdir().unwrap();
        let store = file_store(dir.path());
        assert_eq!(stored(dir.path(), "org_a"), None);

        store.store("org_a", "tfc_a").unwrap();
        store.store("org_b", "tfc_b").unwrap();
        assert_eq!(stored(dir.path(), "org_a").as_deref(), Some("tfc_a"));

        store.delete("org_a").unwrap();
        store.delete("org_a").unwrap();
        assert_eq!(stored(dir.path(), "org_a"), None);
        assert_eq!(stored(dir.path(), "org_b").as_deref(), Some("tfc_b"));
    }

    #[cfg(unix)]
    #[test]
    fn stored_credentials_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        file_store(dir.path()).store("org_a", "tfc_a").unwrap();
        let mode = fs::metadata(credential_file(dir.path(), "org_a"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn an_empty_credential_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        file_store(dir.path()).store("org_a", "\n").unwrap();
        assert!(read_owner_only(&credential_file(dir.path(), "org_a")).is_err());
    }

    #[test]
    fn credential_file_name_cannot_escape_the_state_dir() {
        let path = credential_file(Path::new("/state"), "../../etc/passwd");
        assert_eq!(path.parent(), Some(Path::new("/state")));
    }

    #[test]
    fn store_kind_parses_from_lowercase_config_values() {
        let kind: CredentialStoreKind = serde_json::from_str("\"file\"").unwrap();
        assert_eq!(kind, CredentialStoreKind::File);
        assert!(serde_json::from_str::<CredentialStoreKind>("\"vault\"").is_err());
    }
}
