// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector CLI: non-secret local config + state directory.

//! The CLI's on-disk, **non-secret** state.
//!
//! Two split concerns: the Collector Credential *secret* lives in its own store (see [`crate::keychain`]),
//! never in this file; everything else — which Organization is connected, the ingest URL, the
//! Collector id, which store holds the credential, and the last-sync bookkeeping — lives in a JSON
//! file under the platform config dir, alongside the SQLite cursor store. None of it is secret: an
//! org id is not a credential, and the cursor DB holds local paths that never leave the machine.
//!
//! It still decides where the credential is sent, so the state dir is private and the connection
//! file is written and read through [`crate::private_file`]: another local user cannot plant one
//! that points the Collector at their own ingest URL.
//!
//! Modern connection state stores the ingest URL minted alongside the Convex credential. Legacy
//! connection files can infer it only for known prod/dev Convex URLs; unknown legacy state must
//! reconnect so a credential is never silently sent to the wrong ingest endpoint.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::defaults;
use crate::keychain::{CredentialStore, CredentialStoreKind};
use crate::private_file;

/// The directory env var (set in tests, or to relocate state). Falls back to the platform config dir.
const STATE_DIR_ENV: &str = "TRACE_FLOW_STATE_DIR";

/// Persisted connection state. Written by `login`, read by `sync`/`status`, removed by `disconnect`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Connection {
    /// The Convex Organization id this collector is bound to. Not a secret; scopes the cursor store.
    pub org_id: String,
    /// The Collector id minted at login. Identifies this collector to the control plane.
    pub collector_id: String,
    /// The Convex deployment URL the credential was minted against (audit/UX only).
    pub convex_url: String,
    /// The ingest Worker base URL that matches the credential's control-plane environment.
    #[serde(default)]
    pub ingest_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    /// The store `login` put the credential in. Every later command reads it from there, so
    /// changing the configured store never strands a login.
    #[serde(default = "legacy_credential_store")]
    pub credential_store: CredentialStoreKind,
}

/// Connections saved before the file store existed always kept the credential in the OS keychain.
fn legacy_credential_store() -> CredentialStoreKind {
    CredentialStoreKind::Keyring
}

impl Connection {
    /// The store holding this connection's credential.
    pub fn credentials(&self, paths: &Paths) -> CredentialStore {
        CredentialStore::new(self.credential_store, paths)
    }

    pub fn sync_ingest_url(&self) -> Result<String> {
        let explicit = self.ingest_url.trim();
        if !explicit.is_empty() {
            return Ok(explicit.to_string());
        }
        if let Some(url) = defaults::ingest_url_for_convex(&self.convex_url) {
            return Ok(url.to_string());
        }
        anyhow::bail!(
            "connection is missing an ingest URL for {}; reconnect to bind this collector to the correct ingest endpoint",
            self.convex_url
        )
    }
}

/// The CLI's resolved local layout. All paths derive from one state dir so tests can sandbox it.
pub struct Paths {
    root: PathBuf,
}

impl Paths {
    /// Resolve the state dir: `$TRACE_FLOW_STATE_DIR` if set, else `<config_dir>/trace-flow`.
    pub fn resolve() -> Result<Self> {
        if let Some(dir) = std::env::var_os(STATE_DIR_ENV) {
            return Ok(Self::at(PathBuf::from(dir)));
        }
        let base = dirs::config_dir().context(
            "no OS config dir; set TRACE_FLOW_STATE_DIR to choose where the CLI keeps its state",
        )?;
        Ok(Self::at(base.join("trace-flow")))
    }

    /// Root the layout at an explicit dir (tests, `resolve`, and host-wide services).
    pub fn at(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The connection-state JSON file.
    pub fn connection_file(&self) -> PathBuf {
        self.root.join("connection.json")
    }

    /// The per-org SQLite cursor store. One DB per org keeps cursors isolated (the store itself also
    /// scopes by org_id, but a per-org file makes `disconnect` a clean delete).
    pub fn cursor_db(&self, org_id: &str) -> PathBuf {
        self.root
            .join(format!("cursors-{}.sqlite3", sanitize(org_id)))
    }

    /// A scratch dir for the Cursor reader's read-only `state.vscdb` snapshot copy. Under the state root
    /// so it shares the same volume (a cross-device copy of a multi-GB DB would be slow) and is swept by
    /// the same cleanup; the reader makes a private per-pass subdir inside it and removes it on drop.
    pub fn scratch_dir(&self) -> PathBuf {
        self.root.join("scratch")
    }

    /// Create the state dir and its scratch subdir private (`0700`), or make existing ones private.
    /// Idempotent. See [`crate::private_file`] for what an existing open dir must pass.
    pub fn ensure(&self) -> Result<()> {
        private_file::ensure_private_dir(&self.root)?;
        private_file::ensure_private_dir(&self.scratch_dir())
    }

    /// Read the saved connection, or `None` if the CLI is not logged in. Refuses a symlink or a
    /// file another user owns or can change.
    pub fn load_connection(&self) -> Result<Option<Connection>> {
        let path = self.connection_file();
        let Some(bytes) = private_file::read_owned(&path)? else {
            return Ok(None);
        };
        let conn =
            serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
        Ok(Some(conn))
    }

    /// Persist the connection state, atomically replacing (never following) whatever is there.
    pub fn save_connection(&self, conn: &Connection) -> Result<()> {
        let json = serde_json::to_vec_pretty(conn).context("serialize connection")?;
        private_file::write(&self.root, &self.connection_file(), &json)
    }

    /// Remove the connection file and the org's cursor DB. Used by `disconnect`. Missing files are
    /// not an error — disconnect is idempotent.
    pub fn clear_connection(&self, org_id: &str) -> Result<()> {
        remove_if_present(&self.connection_file())?;
        remove_if_present(&self.cursor_db(org_id))?;
        Ok(())
    }

    /// Remove only the connection marker. Cursors are local replay state and should survive a
    /// desktop reconnect so replacing a credential does not force a full backfill.
    pub fn clear_connection_only(&self) -> Result<()> {
        remove_if_present(&self.connection_file())
    }
}

fn remove_if_present(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err).with_context(|| format!("remove {}", path.display())),
    }
}

/// Keep an org id safe as a filename component: only `[A-Za-z0-9_-]`, everything else to `_`.
pub(crate) fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn conn() -> Connection {
        Connection {
            org_id: "org_123".to_string(),
            collector_id: "col_abc".to_string(),
            convex_url: "https://example.convex.cloud".to_string(),
            ingest_url: "https://collector.example.test".to_string(),
            expires_at: None,
            credential_store: CredentialStoreKind::File,
        }
    }

    #[test]
    fn connection_round_trips_through_disk() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().join("state"));
        paths.ensure().unwrap();
        assert_eq!(paths.load_connection().unwrap(), None);
        paths.save_connection(&conn()).unwrap();
        assert_eq!(paths.load_connection().unwrap(), Some(conn()));
    }

    #[test]
    fn legacy_connection_expiry_remains_readable() {
        let value = r#"{
            "org_id":"org_123",
            "collector_id":"col_abc",
            "convex_url":"https://example.convex.site",
            "ingest_url":"https://collector.example.test",
            "expires_at":1
        }"#;
        let connection: Connection = serde_json::from_str(value).unwrap();
        assert_eq!(connection.expires_at, Some(1));
        assert_eq!(connection.credential_store, CredentialStoreKind::Keyring);
    }

    #[test]
    fn current_connection_omits_expiry() {
        let value = serde_json::to_value(conn()).unwrap();
        assert_eq!(value.get("expires_at"), None);
    }

    #[test]
    fn disconnect_removes_connection_and_cursor_db_idempotently() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().join("state"));
        paths.ensure().unwrap();
        paths.save_connection(&conn()).unwrap();
        std::fs::write(paths.cursor_db("org_123"), b"db").unwrap();

        paths.clear_connection("org_123").unwrap();
        assert_eq!(paths.load_connection().unwrap(), None);
        assert!(!paths.cursor_db("org_123").exists());
        // Second call is a no-op, not an error.
        paths.clear_connection("org_123").unwrap();
    }

    #[test]
    fn clear_connection_only_preserves_cursor_db() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().join("state"));
        paths.ensure().unwrap();
        paths.save_connection(&conn()).unwrap();
        std::fs::write(paths.cursor_db("org_123"), b"db").unwrap();

        paths.clear_connection_only().unwrap();
        assert_eq!(paths.load_connection().unwrap(), None);
        assert!(paths.cursor_db("org_123").exists());
    }

    #[test]
    fn missing_ingest_url_is_inferred_from_known_convex_url() {
        let conn = Connection {
            org_id: "org_123".to_string(),
            collector_id: "col_abc".to_string(),
            convex_url: defaults::DEV_CONVEX_SITE_URL.to_string(),
            ingest_url: String::new(),
            expires_at: None,
            credential_store: CredentialStoreKind::Keyring,
        };
        assert_eq!(conn.sync_ingest_url().unwrap(), defaults::DEV_INGEST_URL);
    }

    #[test]
    fn missing_ingest_url_for_unknown_convex_url_requires_reconnect() {
        let conn = Connection {
            org_id: "org_123".to_string(),
            collector_id: "col_abc".to_string(),
            convex_url: "https://custom.example.convex.site".to_string(),
            ingest_url: String::new(),
            expires_at: None,
            credential_store: CredentialStoreKind::Keyring,
        };

        let err = conn.sync_ingest_url().unwrap_err().to_string();
        assert!(err.contains("missing an ingest URL"));
        assert!(err.contains("reconnect"));
    }

    #[cfg(unix)]
    #[test]
    fn a_planted_connection_file_is_refused_on_read_and_replaced_on_write() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().join("state"));
        std::fs::create_dir(paths.root()).unwrap();
        std::fs::set_permissions(paths.root(), std::fs::Permissions::from_mode(0o775)).unwrap();
        let elsewhere = dir.path().join("elsewhere.json");
        let mut redirected = conn();
        redirected.ingest_url = "https://attacker.example.test".to_string();
        std::fs::write(&elsewhere, serde_json::to_vec(&redirected).unwrap()).unwrap();
        symlink(&elsewhere, paths.connection_file()).unwrap();

        assert!(
            paths.load_connection().is_err(),
            "a symlink is never followed"
        );
        paths.ensure().unwrap();
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(paths.root()), 0o700);
        assert_eq!(mode(&paths.scratch_dir()), 0o700);

        paths.save_connection(&conn()).unwrap();
        assert_eq!(paths.load_connection().unwrap(), Some(conn()));
        assert_eq!(
            serde_json::from_slice::<Connection>(&std::fs::read(&elsewhere).unwrap()).unwrap(),
            redirected,
            "the link target is untouched"
        );

        std::fs::set_permissions(
            paths.connection_file(),
            std::fs::Permissions::from_mode(0o666),
        )
        .unwrap();
        let err = paths.load_connection().unwrap_err().to_string();
        assert!(err.contains("writable by other users"), "{err}");
    }

    #[test]
    fn cursor_db_name_is_filename_safe() {
        let paths = Paths::at(PathBuf::from("/state"));
        let name = paths.cursor_db("org/../etc");
        let file = name.file_name().unwrap().to_str().unwrap();
        assert!(!file.contains('/'));
        assert!(file.starts_with("cursors-org_"));
    }
}
