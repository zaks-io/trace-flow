use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{ArchiveSyncError, ArchiveSyncResult};
use crate::policy::ArchivePolicy;
use crate::spool::atomic_write;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveEnrollmentRecord {
    pub status: String,
}

impl ArchiveEnrollmentRecord {
    pub fn from_policy(policy: ArchivePolicy) -> Self {
        Self {
            status: policy.as_str().to_string(),
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
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_vec_pretty(&Self::from_policy(policy))?;
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
        assert!(!persisted.contains("tfc_"));
        assert!(!persisted.contains("payload"));
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
