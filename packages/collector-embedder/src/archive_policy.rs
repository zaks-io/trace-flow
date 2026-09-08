use anyhow::{anyhow, Context, Result};
use collector_archive_sync::{
    cleanup_obligation_exists, policy_from_denial_reason, ArchiveClient, ArchiveClientConfig,
    ArchiveClientError, ArchiveEnrollmentRecord, ArchiveEnrollmentRequest, ArchivePolicyResponse,
    ConfirmedArchivePolicy,
};

use crate::connection::Paths;

const POLICY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

pub fn load_archive_policy(paths: &Paths, org_id: &str) -> Result<ArchiveEnrollmentRecord> {
    ArchiveEnrollmentRecord::load_record(&paths.archive_enrollment_file(org_id))
        .context("load archive enrollment")
}

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

pub async fn enroll_archive_source(
    paths: &Paths,
    org_id: &str,
    archive_url: String,
    credential: &str,
    request: &ArchiveEnrollmentRequest,
) -> Result<bool> {
    let mut config = ArchiveClientConfig::new(archive_url, credential);
    config.timeout = POLICY_TIMEOUT;
    let client = ArchiveClient::new(config).context("build archive enrollment client")?;
    let result = client.enroll(request).await;
    let enrolled = result.as_ref().is_ok_and(|response| response.enrolled);
    persist_policy_result(paths, org_id, result)?;
    Ok(enrolled)
}

fn persist_policy_result(
    paths: &Paths,
    org_id: &str,
    result: std::result::Result<ArchivePolicyResponse, ArchiveClientError>,
) -> Result<()> {
    let path = paths.archive_enrollment_file(org_id);
    let previous = ArchiveEnrollmentRecord::load_record(&path)
        .context("load prior archive enrollment policy")?;
    previous
        .policy()
        .context("load prior archive enrollment policy")?;
    let (confirmed, reason) = match result {
        Ok(response) => {
            let reason = response.reason.clone();
            let confirmed = response
                .confirmed()
                .map_err(|_| anyhow!("archive policy response is invalid"))?;
            (confirmed, reason)
        }
        Err(error) => match error.denial_reason().and_then(policy_from_denial_reason) {
            Some(policy) => (
                ConfirmedArchivePolicy {
                    policy,
                    authorized_sources: Vec::new(),
                },
                error.denial_reason().map(str::to_string),
            ),
            None if policy_is_unavailable(&error)
                && !previous.has_enrollment_footprint()
                && !cleanup_obligation_exists(&paths.archive_spool_dir(org_id)) =>
            {
                return Ok(())
            }
            None => return Err(anyhow!("archive policy refresh failed: {}", error.class())),
        },
    };

    let mut record = ArchiveEnrollmentRecord::from_confirmed(confirmed, Some(&previous));
    record.reason = reason;
    record
        .save_record(&path)
        .context("save archive enrollment policy")
}

fn policy_is_unavailable(error: &ArchiveClientError) -> bool {
    matches!(
        error,
        ArchiveClientError::Transport(_)
            | ArchiveClientError::Unavailable { .. }
            | ArchiveClientError::UploadRejected { .. }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use collector_archive::{scan_claude_jsonl, ArchiveSource};
    use collector_archive_sync::{
        ArchiveAuthorizedSource, ArchiveHistoryChoice, ArchiveKeyStore, ArchivePolicy,
        ArchiveSourceChoice, ArchiveSpool, MemoryKeyStore, PendingArchiveRequest,
    };
    use tempfile::TempDir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn enrollment_response_is_persisted_and_reports_enrolled() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0u8; 8192];
            let _ = stream.read(&mut request).await.unwrap();
            let body = r#"{"enrolled":true,"authorizedSources":[{"source":"claude","historyChoice":"all_history","authorizedAt":1770000000001}],"reason":null}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let request = ArchiveEnrollmentRequest {
            authorized_sources: vec![ArchiveSourceChoice {
                source: ArchiveSource::Claude,
                history_choice: ArchiveHistoryChoice::AllHistory,
            }],
            idempotency_key: "archive-enroll:test".to_string(),
        };

        assert!(enroll_archive_source(
            &paths,
            "org_1",
            format!("http://{addr}"),
            "tfc_test_secret",
            &request,
        )
        .await
        .unwrap());

        let record = load_archive_policy(&paths, "org_1").unwrap();
        assert_eq!(record.policy().unwrap(), ArchivePolicy::Enrolled);
        assert_eq!(record.authorized_sources.len(), 1);
        assert_eq!(
            record.authorized_sources[0].history_choice,
            ArchiveHistoryChoice::AllHistory
        );
        assert!(
            !std::fs::read_to_string(paths.archive_enrollment_file("org_1"))
                .unwrap()
                .contains("tfc_test_secret")
        );
    }

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
            reason: None,
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
    fn deleting_policy_uses_the_terminal_marker() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        persist_policy_result(
            &paths,
            "org_1",
            Ok(ArchivePolicyResponse {
                enrolled: false,
                authorized_sources: Vec::new(),
                reason: Some("deleting".to_string()),
            }),
        )
        .unwrap();
        assert_eq!(
            ArchiveEnrollmentRecord::load(&paths.archive_enrollment_file("org_1")).unwrap(),
            ArchivePolicy::Revoked
        );
    }

    #[test]
    fn denial_only_marker_keeps_unavailability_nonfatal_and_is_not_rewritten() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let path = paths.archive_enrollment_file("org_1");
        persist_policy_result(
            &paths,
            "org_1",
            Ok(ArchivePolicyResponse {
                enrolled: false,
                authorized_sources: Vec::new(),
                reason: Some("not_pro".to_string()),
            }),
        )
        .unwrap();
        let before = std::fs::read(&path).unwrap();

        for error in [
            ArchiveClientError::Unavailable {
                reason: "policy_unavailable".to_string(),
            },
            ArchiveClientError::UploadRejected {
                reason: "not_found".to_string(),
            },
            ArchiveClientError::Transport(anyhow!("offline")),
        ] {
            persist_policy_result(&paths, "org_1", Err(error)).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), before);
        }
    }

    #[test]
    fn malformed_policy_stays_loud_and_does_not_rewrite_the_marker() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let path = paths.archive_enrollment_file("org_1");
        ArchiveEnrollmentRecord::from_policy(ArchivePolicy::Grace)
            .save_record(&path)
            .unwrap();
        let before = std::fs::read(&path).unwrap();

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
    fn legacy_enrolled_marker_and_cleanup_obligation_keep_unavailability_visible() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let path = paths.archive_enrollment_file("org_1");
        std::fs::write(&path, br#"{"status":"enrolled"}"#).unwrap();

        assert!(persist_policy_result(
            &paths,
            "org_1",
            Err(ArchiveClientError::Transport(anyhow!("offline"))),
        )
        .is_err());

        ArchiveEnrollmentRecord::from_policy(ArchivePolicy::Grace)
            .save_record(&path)
            .unwrap();
        std::fs::write(
            ArchiveSpool::durable_cleanup_marker_path(&paths.archive_spool_dir("org_1")),
            b"",
        )
        .unwrap();
        assert!(persist_policy_result(
            &paths,
            "org_1",
            Err(ArchiveClientError::Transport(anyhow!("offline"))),
        )
        .is_err());
    }

    #[test]
    fn corrupt_local_marker_stays_loud_during_unavailability() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let path = paths.archive_enrollment_file("org_1");
        std::fs::write(&path, br#"{"status":"enrolle"}"#).unwrap();
        let before = std::fs::read(&path).unwrap();

        let error = persist_policy_result(
            &paths,
            "org_1",
            Err(ArchiveClientError::Transport(anyhow!("offline"))),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("load prior archive enrollment policy"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn unavailable_policy_is_nonfatal_before_enrollment() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();

        for error in [
            ArchiveClientError::Unavailable {
                reason: "policy_unavailable".to_string(),
            },
            ArchiveClientError::UploadRejected {
                reason: "not_found".to_string(),
            },
            ArchiveClientError::Transport(anyhow!("offline")),
        ] {
            persist_policy_result(&paths, "org_1", Err(error)).unwrap();
        }
        assert!(!paths.archive_enrollment_file("org_1").exists());
    }

    #[test]
    fn expired_credential_preserves_pending_data_key_and_source_metadata() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let path = paths.archive_enrollment_file("org_1");
        ArchiveEnrollmentRecord {
            status: ArchivePolicy::Enrolled.as_str().to_string(),
            authorized_sources: vec![ArchiveAuthorizedSource {
                source: ArchiveSource::Claude,
                history_choice: ArchiveHistoryChoice::AllHistory,
                authorized_at: 1_770_000_000_001,
            }],
            reason: None,
        }
        .save_record(&path)
        .unwrap();

        let keys = MemoryKeyStore::new();
        let spool_dir = paths.archive_spool_dir("org_1");
        let spool = ArchiveSpool::open(&spool_dir, "org_1", &keys).unwrap();
        let pending = PendingArchiveRequest {
            source: ArchiveSource::Claude,
            source_session_id: "claude-session-001".to_string(),
            source_transcript_part_id: PendingArchiveRequest::default_part(ArchiveSource::Claude),
            expected_record_count: 1,
            expected_appended_records: 1,
            body: b"pending archive data".to_vec(),
        };
        spool.persist_pending(&pending).unwrap();
        let progress_session = "claude-progress-session";
        let progress = scan_claude_jsonl(progress_session, b"{\"uuid\":\"r1\"}\n", 10, None)
            .unwrap()
            .checkpoint;
        spool
            .persist_progress(ArchiveSource::Claude, progress_session, &progress)
            .unwrap();

        persist_policy_result(
            &paths,
            "org_1",
            Err(ArchiveClientError::Unauthorized {
                reason: "expired".to_string(),
            }),
        )
        .unwrap();

        let record = ArchiveEnrollmentRecord::load_record(&path).unwrap();
        assert_eq!(record.policy().unwrap(), ArchivePolicy::Frozen);
        assert_eq!(
            record.authorized_sources[0].authorized_at,
            1_770_000_000_001
        );
        assert_eq!(
            record.authorized_sources[0].history_choice,
            ArchiveHistoryChoice::AllHistory
        );
        assert!(keys.load("org_1").unwrap().is_some());
        assert!(spool
            .pending(ArchiveSource::Claude, "claude-session-001")
            .unwrap()
            .is_some());
        assert!(spool
            .progress(ArchiveSource::Claude, progress_session)
            .unwrap()
            .is_some());

        let frozen = std::fs::read(&path).unwrap();
        assert!(persist_policy_result(
            &paths,
            "org_1",
            Err(ArchiveClientError::Transport(anyhow!("offline"))),
        )
        .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), frozen);
        assert!(keys.load("org_1").unwrap().is_some());
        assert!(spool
            .pending(ArchiveSource::Claude, "claude-session-001")
            .unwrap()
            .is_some());
        assert!(spool
            .progress(ArchiveSource::Claude, progress_session)
            .unwrap()
            .is_some());
    }

    #[test]
    fn policy_errors_and_disk_state_never_contain_the_credential() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let path = paths.archive_enrollment_file("org_1");
        ArchiveEnrollmentRecord::save(&path, ArchivePolicy::Enrolled).unwrap();
        let credential = "tfc_must_not_persist";
        let error = persist_policy_result(
            &paths,
            "org_1",
            Err(ArchiveClientError::Transport(anyhow!("offline"))),
        )
        .unwrap_err()
        .to_string();
        assert!(!error.contains(credential));
        assert!(!std::fs::read_to_string(path).unwrap().contains(credential));
    }
}
