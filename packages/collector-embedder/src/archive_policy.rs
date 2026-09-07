use anyhow::{anyhow, Context, Result};
use collector_archive_sync::{
    policy_from_denial_reason, ArchiveClient, ArchiveClientConfig, ArchiveClientError,
    ArchiveEnrollmentRecord, ArchivePolicyResponse, ConfirmedArchivePolicy,
};

use crate::connection::Paths;

const POLICY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

pub async fn refresh_archive_policy(
    paths: &Paths,
    org_id: &str,
    archive_url: String,
    credential: &str,
) -> Result<()> {
    let mut config = ArchiveClientConfig::new(archive_url, credential);
    config.timeout = POLICY_TIMEOUT;
    let client = ArchiveClient::new(config).context("build archive policy client")?;
    let result = client.fetch_policy().await;
    persist_policy_result(paths, org_id, result)
}

fn persist_policy_result(
    paths: &Paths,
    org_id: &str,
    result: std::result::Result<ArchivePolicyResponse, ArchiveClientError>,
) -> Result<()> {
    let confirmed = match result {
        Ok(response) => response
            .confirmed()
            .map_err(|_| anyhow!("archive policy response is invalid"))?,
        Err(error) => match error.denial_reason().and_then(policy_from_denial_reason) {
            Some(policy) => ConfirmedArchivePolicy {
                policy,
                authorized_sources: Vec::new(),
            },
            None => return Err(anyhow!("archive policy refresh failed: {}", error.class())),
        },
    };

    let path = paths.archive_enrollment_file(org_id);
    let previous = if confirmed.policy.retains() && confirmed.authorized_sources.is_empty() {
        Some(
            ArchiveEnrollmentRecord::load_record(&path)
                .context("load prior archive enrollment policy")?,
        )
    } else {
        None
    };
    ArchiveEnrollmentRecord::from_confirmed(confirmed, previous.as_ref())
        .save_record(&path)
        .context("save archive enrollment policy")
}

#[cfg(test)]
mod tests {
    use super::*;
    use collector_archive::ArchiveSource;
    use collector_archive_sync::{ArchiveAuthorizedSource, ArchiveHistoryChoice, ArchivePolicy};
    use tempfile::TempDir;

    #[test]
    fn confirmed_policy_replaces_marker_with_source_metadata() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        persist_policy_result(
            &paths,
            "org_1",
            Ok(ArchivePolicyResponse {
                enrolled: true,
                authorized_sources: vec![ArchiveAuthorizedSource {
                    source: ArchiveSource::Claude,
                    history_choice: ArchiveHistoryChoice::AllHistory,
                    authorized_at: 1_770_000_000_001,
                }],
                reason: None,
            }),
        )
        .unwrap();

        let record =
            ArchiveEnrollmentRecord::load_record(&paths.archive_enrollment_file("org_1")).unwrap();
        assert_eq!(record.policy().unwrap(), ArchivePolicy::Enrolled);
        assert_eq!(record.authorized_sources.len(), 1);
        assert_eq!(
            record.authorized_sources[0].history_choice,
            ArchiveHistoryChoice::AllHistory
        );
    }

    #[test]
    fn frozen_policy_preserves_existing_source_metadata() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let path = paths.archive_enrollment_file("org_1");
        ArchiveEnrollmentRecord {
            status: ArchivePolicy::Enrolled.as_str().to_string(),
            authorized_sources: vec![ArchiveAuthorizedSource {
                source: ArchiveSource::Codex,
                history_choice: ArchiveHistoryChoice::NewOnly,
                authorized_at: 1_770_000_000_002,
            }],
        }
        .save_record(&path)
        .unwrap();

        persist_policy_result(
            &paths,
            "org_1",
            Ok(ArchivePolicyResponse {
                enrolled: false,
                authorized_sources: Vec::new(),
                reason: Some("frozen".to_string()),
            }),
        )
        .unwrap();

        let record = ArchiveEnrollmentRecord::load_record(&path).unwrap();
        assert_eq!(record.policy().unwrap(), ArchivePolicy::Frozen);
        assert_eq!(record.authorized_sources.len(), 1);
        assert_eq!(
            record.authorized_sources[0].authorized_at,
            1_770_000_000_002
        );
    }

    #[test]
    fn confirmed_revocation_uses_the_terminal_marker() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        persist_policy_result(
            &paths,
            "org_1",
            Ok(ArchivePolicyResponse {
                enrolled: false,
                authorized_sources: Vec::new(),
                reason: Some("enrollment_invalid".to_string()),
            }),
        )
        .unwrap();
        assert_eq!(
            ArchiveEnrollmentRecord::load(&paths.archive_enrollment_file("org_1")).unwrap(),
            ArchivePolicy::Revoked
        );
    }

    #[test]
    fn unavailable_and_malformed_policy_leave_marker_unchanged() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let path = paths.archive_enrollment_file("org_1");
        let original = ArchiveEnrollmentRecord::from_policy(ArchivePolicy::Grace);
        original.save_record(&path).unwrap();
        let before = std::fs::read(&path).unwrap();

        assert!(persist_policy_result(
            &paths,
            "org_1",
            Err(ArchiveClientError::Unavailable {
                reason: "policy_unavailable".to_string(),
            }),
        )
        .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);

        assert!(persist_policy_result(
            &paths,
            "org_1",
            Ok(ArchivePolicyResponse {
                enrolled: true,
                authorized_sources: Vec::new(),
                reason: None,
            }),
        )
        .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn policy_errors_and_disk_state_never_contain_the_credential() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let credential = "tfc_must_not_persist";
        let error = persist_policy_result(
            &paths,
            "org_1",
            Err(ArchiveClientError::Transport(anyhow!("offline"))),
        )
        .unwrap_err()
        .to_string();
        assert!(!error.contains(credential));
        assert!(!paths.archive_enrollment_file("org_1").exists());
    }
}
