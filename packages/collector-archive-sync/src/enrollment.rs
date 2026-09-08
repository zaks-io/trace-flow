use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{ArchiveSyncError, ArchiveSyncResult};
use crate::policy::{ArchiveAuthorizedSource, ArchivePolicy, ConfirmedArchivePolicy};
use crate::spool::atomic_write;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveEnrollmentRecord {
    pub status: String,
    #[serde(default)]
    pub authorized_sources: Vec<ArchiveAuthorizedSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl ArchiveEnrollmentRecord {
    pub fn from_policy(policy: ArchivePolicy) -> Self {
        Self {
            status: policy.as_str().to_string(),
            authorized_sources: Vec::new(),
            reason: None,
        }
    }

    pub fn from_confirmed(
        confirmed: ConfirmedArchivePolicy,
        previous: Option<&ArchiveEnrollmentRecord>,
    ) -> Self {
        let authorized_sources = if confirmed.policy.retains() {
            if confirmed.authorized_sources.is_empty() {
                previous
                    .map(|record| record.authorized_sources.clone())
                    .unwrap_or_default()
            } else {
                confirmed.authorized_sources
            }
        } else {
            Vec::new()
        };
        Self {
            status: confirmed.policy.as_str().to_string(),
            authorized_sources,
            reason: None,
        }
    }

    pub fn policy(&self) -> ArchiveSyncResult<ArchivePolicy> {
        self.status
            .parse()
            .map_err(|_| ArchiveSyncError::InvalidEnrollment)
    }

    /// Server-confirmed source metadata is the durable enrollment footprint. The legacy enrolled
    /// marker predates that metadata and still counts; denial-only legacy markers are ambiguous and
    /// carry no actionable evidence.
    pub fn has_enrollment_footprint(&self) -> bool {
        !self.authorized_sources.is_empty()
            || self
                .policy()
                .is_ok_and(|policy| policy == ArchivePolicy::Enrolled)
    }

    pub fn load(path: &Path) -> ArchiveSyncResult<ArchivePolicy> {
        Self::load_record(path)?.policy()
    }

    pub fn load_record(path: &Path) -> ArchiveSyncResult<Self> {
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(Into::into),
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                Ok(Self::from_policy(ArchivePolicy::Inactive))
            }
            Err(err) => Err(err.into()),
        }
    }

    pub fn save(path: &Path, policy: ArchivePolicy) -> ArchiveSyncResult<()> {
        Self::from_policy(policy).save_record(path)
    }

    pub fn save_record(&self, path: &Path) -> ArchiveSyncResult<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_vec_pretty(self)?;
        atomic_write(path, &json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn missing_file_is_inactive() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            ArchiveEnrollmentRecord::load(&dir.path().join("missing.json")).unwrap(),
            ArchivePolicy::Inactive
        );
    }

    #[test]
    fn enrollment_round_trips_without_secrets() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("archive-enrollment.json");
        ArchiveEnrollmentRecord::save(&path, ArchivePolicy::Grace).unwrap();
        assert_eq!(
            ArchiveEnrollmentRecord::load(&path).unwrap(),
            ArchivePolicy::Grace
        );
        let persisted = fs::read_to_string(&path).unwrap();
        assert!(persisted.contains("grace"));
        assert!(persisted.contains("authorizedSources"));
        assert!(!persisted.contains("tfc_"));
        assert!(!persisted.contains("payload"));
    }

    #[test]
    fn existing_status_only_marker_remains_readable_until_policy_refresh() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("archive-enrollment.json");
        fs::write(&path, br#"{"status":"enrolled"}"#).unwrap();

        let record = ArchiveEnrollmentRecord::load_record(&path).unwrap();
        assert_eq!(record.policy().unwrap(), ArchivePolicy::Enrolled);
        assert!(record.authorized_sources.is_empty());
        assert!(record.has_enrollment_footprint());
    }

    #[test]
    fn denial_only_markers_have_no_enrollment_footprint() {
        for policy in [
            ArchivePolicy::Inactive,
            ArchivePolicy::Grace,
            ArchivePolicy::Frozen,
            ArchivePolicy::Revoked,
        ] {
            assert!(!ArchiveEnrollmentRecord::from_policy(policy).has_enrollment_footprint());
        }
    }

    #[test]
    fn truncated_or_unknown_status_fails_loud() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("archive-enrollment.json");
        fs::write(&path, br#"{"status":"enrolle","authorizedSources":[]}"#).unwrap();
        let err = ArchiveEnrollmentRecord::load(&path).unwrap_err();
        assert!(matches!(
            err,
            crate::error::ArchiveSyncError::InvalidEnrollment
        ));
        fs::write(&path, br#"{"status":"inactive","authorizedSources":[]}"#).unwrap();
        assert_eq!(
            ArchiveEnrollmentRecord::load(&path).unwrap(),
            ArchivePolicy::Inactive
        );
    }

    #[test]
    fn confirmed_enrollment_round_trips_source_authorization_metadata() {
        use crate::policy::ArchiveHistoryChoice;
        use collector_archive::ArchiveSource;

        let dir = TempDir::new().unwrap();
        let path = dir.path().join("archive-enrollment.json");
        let record = ArchiveEnrollmentRecord::from_confirmed(
            ConfirmedArchivePolicy {
                policy: ArchivePolicy::Enrolled,
                authorized_sources: vec![ArchiveAuthorizedSource {
                    source: ArchiveSource::Claude,
                    history_choice: ArchiveHistoryChoice::AllHistory,
                    authorized_at: 1_770_000_000_001,
                }],
            },
            None,
        );
        record.save_record(&path).unwrap();

        assert_eq!(ArchiveEnrollmentRecord::load_record(&path).unwrap(), record);
        let persisted = fs::read_to_string(path).unwrap();
        assert!(persisted.contains("all_history"));
        assert!(persisted.contains("1770000000001"));
        assert!(!persisted.contains("tfc_"));
    }
}
