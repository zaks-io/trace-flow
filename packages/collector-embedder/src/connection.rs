// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector CLI: non-secret local config + state directory.

//! The CLI's on-disk, **non-secret** state.
//!
//! Two split concerns: the Collector Credential *secret* lives in the OS keychain (see [`crate::keychain`])
//! and never touches disk; everything else — which Organization is connected, the ingest URL, the
//! Collector id, and the last-sync bookkeeping — lives in a plain JSON file under the platform config
//! dir, alongside the SQLite cursor store. None of it is sensitive: an org id is not a credential, and
//! the cursor DB holds local paths that never leave the machine.
//!
//! Modern connection state stores the ingest URL minted alongside the Convex credential. Legacy
//! connection files can infer it only for known prod/dev Convex URLs; unknown legacy state must
//! reconnect so a credential is never silently sent to the wrong ingest endpoint.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::defaults;

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
    /// Epoch-ms expiry of the Collector Credential, surfaced by `status`.
    pub expires_at: i64,
}

impl Connection {
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

    /// Root the layout at an explicit dir (used by tests and by `resolve`).
    pub fn at(root: PathBuf) -> Self {
        Self { root }
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

    /// Create the state dir (and the scratch subdir) if absent. Idempotent.
    pub fn ensure(&self) -> Result<()> {
        std::fs::create_dir_all(&self.root)
            .with_context(|| format!("create state dir {}", self.root.display()))?;
        std::fs::create_dir_all(self.scratch_dir())
            .with_context(|| format!("create scratch dir {}", self.scratch_dir().display()))
    }

    /// Read the saved connection, or `None` if the CLI is not logged in.
    pub fn load_connection(&self) -> Result<Option<Connection>> {
        let path = self.connection_file();
        match std::fs::read(&path) {
            Ok(bytes) => {
                let conn = serde_json::from_slice(&bytes)
                    .with_context(|| format!("parse {}", path.display()))?;
                Ok(Some(conn))
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err).with_context(|| format!("read {}", path.display())),
        }
    }

    /// Persist the connection state (overwrites). Caller must have created the dir.
    pub fn save_connection(&self, conn: &Connection) -> Result<()> {
        let path = self.connection_file();
        let json = serde_json::to_vec_pretty(conn).context("serialize connection")?;
        std::fs::write(&path, json).with_context(|| format!("write {}", path.display()))
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
fn sanitize(s: &str) -> String {
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
            expires_at: 1_900_000_000_000,
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
            expires_at: 1_900_000_000_000,
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
            expires_at: 1_900_000_000_000,
        };

        let err = conn.sync_ingest_url().unwrap_err().to_string();
        assert!(err.contains("missing an ingest URL"));
        assert!(err.contains("reconnect"));
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
