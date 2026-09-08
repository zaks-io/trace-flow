// SPDX-License-Identifier: Apache-2.0
// Trace Flow Desktop: the broadcast app state. Adapted from otto-desktop's state.rs, trimmed of the
// provider-usage surface (that is a separate Trace Flow feature, not part of agent analytics).

use std::sync::Arc;
use std::time::SystemTime;

use collector_embedder::{ArchiveHistoryChoice, ArchiveSource};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveConnectionIdentity {
    pub org_id: String,
    pub collector_id: String,
}

/// Whether the app holds a usable Collector Credential yet.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum ConnectionState {
    /// No connection on disk — first run, or after disconnect.
    #[default]
    Disconnected,
    /// A connection + credential is present. The collector id stays inside the native process and
    /// lets Archive state distinguish two saved connections to the same organization.
    Connected {
        org_id: String,
        #[serde(skip)]
        collector_id: String,
    },
}

impl ConnectionState {
    pub fn archive_identity(&self) -> Option<ArchiveConnectionIdentity> {
        match self {
            Self::Disconnected => None,
            Self::Connected {
                org_id,
                collector_id,
            } => Some(ArchiveConnectionIdentity {
                org_id: org_id.clone(),
                collector_id: collector_id.clone(),
            }),
        }
    }
}

/// What the background sync engine is doing. Starts `Paused` so nothing leaves the machine until the
/// user explicitly clicks "Start syncing" through the first-egress gate.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum SyncStatus {
    /// Connected and watching, but the user has not authorized egress yet.
    #[default]
    Paused,
    /// Idle between cycles (egress authorized).
    Idle,
    /// A sync cycle is running.
    Syncing,
    /// The last cycle failed; `message` is a stable error class, never a secret.
    Error { message: String },
}

impl SyncStatus {
    /// A short, stable label for the UI. (The serde representation is externally tagged, so unit
    /// variants serialize to a bare string — do not derive the label from JSON; match here.)
    pub fn label(&self) -> &'static str {
        match self {
            SyncStatus::Paused => "paused",
            SyncStatus::Idle => "watching",
            SyncStatus::Syncing => "syncing",
            SyncStatus::Error { .. } => "error",
        }
    }
}

/// Per-source `.jsonl` file counts on this machine. Cursor transcripts are not supported.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SourceCounts {
    pub claude_files: u32,
    pub codex_files: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentError {
    pub at: SystemTime,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArchiveMenuState {
    pub enrolled: bool,
    pub reason: Option<String>,
    pub sources: Vec<(ArchiveSource, ArchiveHistoryChoice)>,
    pub pending: Option<ArchiveSource>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdateStatus {
    #[default]
    Idle,
    Checking,
    Installing {
        version: String,
    },
    UpToDate {
        version: String,
    },
    Failed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppState {
    pub connection: ConnectionState,
    pub sync: SyncStatus,
    pub sources: SourceCounts,
    pub archive: ArchiveMenuState,
    pub autostart: bool,
    pub update: UpdateStatus,
    pub last_sync_at: Option<SystemTime>,
    pub recent_errors: Vec<RecentError>,
}

#[derive(Clone)]
pub struct AppStateBus {
    tx: Arc<watch::Sender<AppState>>,
}

impl AppStateBus {
    pub fn new() -> Self {
        let (tx, _) = watch::channel(AppState::default());
        Self { tx: Arc::new(tx) }
    }

    pub fn subscribe(&self) -> watch::Receiver<AppState> {
        self.tx.subscribe()
    }

    pub fn snapshot(&self) -> AppState {
        self.tx.borrow().clone()
    }

    pub fn update<F: FnOnce(&mut AppState)>(&self, f: F) {
        self.tx.send_modify(f);
    }
}

impl Default for AppStateBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{ConnectionState, UpdateStatus};

    #[test]
    fn connection_state_keeps_collector_identity_inside_the_native_process() {
        let state = ConnectionState::Connected {
            org_id: "org_1".to_string(),
            collector_id: "collector_secretless_identity".to_string(),
        };

        let serialized = serde_json::to_value(state).unwrap();

        assert_eq!(
            serialized,
            serde_json::json!({ "Connected": { "org_id": "org_1" } })
        );
    }

    #[test]
    fn update_status_has_a_stable_window_contract() {
        assert_eq!(
            serde_json::to_value(UpdateStatus::Checking).unwrap(),
            serde_json::json!({ "status": "checking" })
        );
        assert_eq!(
            serde_json::to_value(UpdateStatus::Installing {
                version: "1.2.3".to_string(),
            })
            .unwrap(),
            serde_json::json!({ "status": "installing", "version": "1.2.3" })
        );
    }
}
