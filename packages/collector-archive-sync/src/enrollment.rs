use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{ArchiveSyncError, ArchiveSyncResult};
use crate::policy::ArchivePolicy;
use crate::spool::atomic_write;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveSourceConsentRecord {
    pub source: String,
    pub history_choice: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveEnrollmentRecord {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enrollment_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contribution_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authorized_sources: Vec<ArchiveSourceConsentRecord>,
}

impl ArchiveEnrollmentRecord {
    pub fn from_policy(policy: ArchivePolicy) -> Self {
        Self {
            status: policy.as_str().to_string(),
            enrollment_id: None,
            activation_id: None,
            contribution_id: None,
            authorized_sources: Vec::new(),
        }
    }

    pub fn with_consent(
        policy: ArchivePolicy,
        enrollment_id: impl Into<String>,
        activation_id: Option<String>,
        contribution_id: impl Into<String>,
        authorized_sources: Vec<ArchiveSourceConsentRecord>,
    ) -> Self {
        Self {
            status: policy.as_str().to_string(),
            enrollment_id: Some(enrollment_id.into()),
            activation_id,
            contribution_id: Some(contribution_id.into()),
            authorized_sources,
        }
    }

    pub fn policy(&self) -> ArchiveSyncResult<ArchivePolicy> {
        self.status
            .parse()
            .map_err(|_| ArchiveSyncError::InvalidEnrollment)
    }

    pub fn load(path: &Path) -> ArchiveSyncResult<ArchivePolicy> {
        match fs::read(path) {
            Ok(bytes) => {
                let record: Self = serde_json::from_slice(&bytes)?;
                record.policy()
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(ArchivePolicy::Inactive),
            Err(err) => Err(err.into()),
        }
    }

    pub fn save(path: &Path, policy: ArchivePolicy) -> ArchiveSyncResult<()> {
        Self::save_record(path, &Self::from_policy(policy))
    }

    pub fn save_record(path: &Path, record: &Self) -> ArchiveSyncResult<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_vec_pretty(record)?;
        atomic_write(path, &json)
    }

    pub fn load_record(path: &Path) -> ArchiveSyncResult<Self> {
        match fs::read(path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                Ok(Self::from_policy(ArchivePolicy::Inactive))
            }
            Err(err) => Err(err.into()),
        }
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
        assert!(!persisted.contains("tfc_"));
        assert!(!persisted.contains("payload"));
    }

    #[test]
    fn consent_record_round_trips_source_authorizations() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("archive-enrollment.json");
        let record = ArchiveEnrollmentRecord::with_consent(
            ArchivePolicy::Enrolled,
            "enr_1",
            Some("act_1".into()),
            "con_1",
            vec![ArchiveSourceConsentRecord {
                source: "claude".into(),
                history_choice: "new_only".into(),
            }],
        );
        ArchiveEnrollmentRecord::save_record(&path, &record).unwrap();
        let loaded = ArchiveEnrollmentRecord::load_record(&path).unwrap();
        assert_eq!(loaded.enrollment_id.as_deref(), Some("enr_1"));
        assert_eq!(loaded.activation_id.as_deref(), Some("act_1"));
        assert_eq!(loaded.authorized_sources[0].source, "claude");
        assert_ne!(loaded.activation_id, loaded.enrollment_id);
        let persisted = fs::read_to_string(&path).unwrap();
        assert!(!persisted.contains("tfc_"));
        assert!(!persisted.contains("session"));
    }

    #[test]
    fn truncated_or_unknown_status_fails_loud() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("archive-enrollment.json");
        fs::write(&path, br#"{"status":"enrolle"}"#).unwrap();
        let err = ArchiveEnrollmentRecord::load(&path).unwrap_err();
        assert!(matches!(
            err,
            crate::error::ArchiveSyncError::InvalidEnrollment
        ));
        fs::write(&path, br#"{"status":"inactive"}"#).unwrap();
        assert_eq!(
            ArchiveEnrollmentRecord::load(&path).unwrap(),
            ArchivePolicy::Inactive
        );
    }
}
