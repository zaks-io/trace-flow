// SPDX-License-Identifier: Apache-2.0
// Trace Flow Desktop: the engine's persisted choices.

//! The user's sync choices, persisted across relaunches.
//!
//! The first-egress gate asks the user once whether the app may upload. Before this
//! file existed that answer lived only in process memory, so every relaunch (login autostart, an
//! update, a crash) silently reset the engine to paused and nothing synced until the user noticed the
//! tray. Now the answer is written here and a relaunch resumes where the user left it.
//!
//! Only non-secret choices live here. The Collector Credential stays in the keychain and the
//! connection in `collector-embedder`'s state dir.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use collector_embedder::{
    ArchiveEnrollmentRecord, ArchiveHistoryChoice, ArchiveSource, ArchiveTargetError,
};
use serde::{Deserialize, Serialize};

use crate::error::Result;

const FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Whether the user has authorized egress and not since paused.
    pub syncing: bool,
    /// Whether the one-time first-run history backfill has reached ingest.
    pub backfilled: bool,
    /// Durable enrollment intent. The credential stays in the keychain.
    pub archive_request: Option<ArchiveRequest>,
    /// Server-confirmed denial kept when the collector enrollment marker could not be replaced.
    pub archive_policy_denial: Option<ArchivePolicyDenial>,
    /// Targets whose acknowledged Archive history no longer matches the local source. Full target
    /// identity stays local so only validation of that same target can clear the repair state.
    pub archive_repairs: Option<ArchiveRepairState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveRequest {
    pub org_id: String,
    pub collector_id: String,
    pub source: ArchiveSource,
    pub history_choice: ArchiveHistoryChoice,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchivePolicyDenial {
    pub org_id: String,
    pub collector_id: String,
    pub enrollment: ArchiveEnrollmentRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveRepairState {
    pub org_id: String,
    pub collector_id: String,
    pub targets: Vec<ArchiveTargetError>,
}

#[derive(Debug, Clone)]
pub struct SettingsFile {
    path: PathBuf,
}

impl SettingsFile {
    pub fn at(dir: &Path) -> Self {
        Self {
            path: dir.join(FILE_NAME),
        }
    }

    /// A missing file is the pre-fix state and means "never authorized": the defaults. Any other
    /// failure is an error, so a corrupt file is surfaced rather than silently treated as paused.
    pub fn load(&self) -> Result<Settings> {
        match fs::read(&self.path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Settings::default()),
            Err(err) => Err(err.into()),
        }
    }

    /// Write via a sibling temp file and rename so a crash mid-write never leaves a half-written file
    /// that would fail `load` on the next launch.
    pub fn save(&self, settings: &Settings) -> Result<()> {
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(settings)?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_means_never_authorized() {
        let dir = tempfile::tempdir().unwrap();
        let file = SettingsFile::at(dir.path());
        assert_eq!(file.load().unwrap(), Settings::default());
        assert!(!Settings::default().syncing);
    }

    #[test]
    fn saved_settings_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let file = SettingsFile::at(dir.path());
        let settings = Settings {
            syncing: true,
            backfilled: true,
            archive_request: Some(ArchiveRequest {
                org_id: "org_1".to_string(),
                collector_id: "collector_1".to_string(),
                source: ArchiveSource::Claude,
                history_choice: ArchiveHistoryChoice::AllHistory,
                idempotency_key: "archive-enroll:request-1".to_string(),
            }),
            archive_policy_denial: Some(ArchivePolicyDenial {
                org_id: "org_1".to_string(),
                collector_id: "collector_1".to_string(),
                enrollment: ArchiveEnrollmentRecord {
                    status: "inactive".to_string(),
                    collector_id: Some("collector_1".to_string()),
                    authorized_sources: Vec::new(),
                    reason: Some("not_activated".to_string()),
                },
            }),
            archive_repairs: Some(ArchiveRepairState {
                org_id: "org_1".to_string(),
                collector_id: "collector_1".to_string(),
                targets: vec![ArchiveTargetError {
                    error_class: "archive_historical_prefix_changed".to_string(),
                    source: ArchiveSource::Codex,
                    source_session_id: "session-1".to_string(),
                    source_transcript_part_id: "codex:part:primary".to_string(),
                }],
            }),
        };
        file.save(&settings).unwrap();
        assert_eq!(file.load().unwrap(), settings);
        assert!(!dir.path().join("settings.json.tmp").exists());
    }

    #[test]
    fn fields_added_later_default_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let file = SettingsFile::at(dir.path());
        fs::write(dir.path().join(FILE_NAME), br#"{"syncing":true}"#).unwrap();
        let settings = file.load().unwrap();
        assert!(settings.syncing);
        assert!(!settings.backfilled);
        assert!(settings.archive_request.is_none());
        assert!(settings.archive_policy_denial.is_none());
        assert!(settings.archive_repairs.is_none());
    }

    #[test]
    fn leftover_raw_upload_is_ignored_and_not_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let file = SettingsFile::at(dir.path());
        fs::write(
            dir.path().join(FILE_NAME),
            br#"{"syncing":true,"backfilled":true,"raw_upload":true}"#,
        )
        .unwrap();
        let settings = file.load().unwrap();
        assert!(settings.syncing);
        assert!(settings.backfilled);
        file.save(&settings).unwrap();
        let persisted = fs::read_to_string(dir.path().join(FILE_NAME)).unwrap();
        assert!(
            !persisted.contains("raw_upload"),
            "legacy raw-upload must not be copied into persisted settings: {persisted}"
        );
    }

    #[test]
    fn a_corrupt_file_is_an_error_not_a_default() {
        let dir = tempfile::tempdir().unwrap();
        let file = SettingsFile::at(dir.path());
        fs::write(dir.path().join(FILE_NAME), b"{not json").unwrap();
        assert!(file.load().is_err());
    }
}
