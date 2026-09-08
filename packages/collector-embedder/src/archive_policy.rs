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
    collector_id: &str,
    archive_url: String,
    credential: &str,
) -> Result<bool> {
    let mut config = ArchiveClientConfig::new(archive_url, credential);
    config.timeout = POLICY_TIMEOUT;
    let client = ArchiveClient::new(config).context("build archive policy client")?;
    let result = client.fetch_policy().await;
    persist_policy_result_for_collector(paths, org_id, collector_id, result)
}

pub async fn enroll_archive_source(
    paths: &Paths,
    org_id: &str,
    collector_id: &str,
    archive_url: String,
    credential: &str,
    request: &ArchiveEnrollmentRequest,
) -> Result<bool> {
    let mut config = ArchiveClientConfig::new(archive_url, credential);
    config.timeout = POLICY_TIMEOUT;
    let client = ArchiveClient::new(config).context("build archive enrollment client")?;
    match client.enroll(request).await {
        Ok(response) => {
            let enrolled = response.enrolled;
            persist_policy_result_for_collector(paths, org_id, collector_id, Ok(response))?;
            Ok(enrolled)
        }
        Err(error) => {
            let message = enrollment_failure_message(error.class());
            let detail = error.to_string();
            if error
                .denial_reason()
                .and_then(policy_from_denial_reason)
                .is_some()
            {
                persist_policy_result_for_collector(paths, org_id, collector_id, Err(error))?;
                return Err(anyhow!(detail).context(message));
            }
            Err(anyhow!(error).context(message))
        }
    }
}

fn enrollment_failure_message(class: &str) -> &'static str {
    match class {
        "consent_conflict" => "history choice conflicts with existing consent",
        "invalid_request" => "request was rejected",
        "unauthorized" | "forbidden" => "collector credential was rejected",
        "invalid_policy" => "returned an invalid response",
        _ => "service unavailable",
    }
}

fn persist_policy_result_for_collector(
    paths: &Paths,
    org_id: &str,
    collector_id: &str,
    result: std::result::Result<ArchivePolicyResponse, ArchiveClientError>,
) -> Result<bool> {
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
            Some(_) if previous.collector_id.as_deref() != Some(collector_id) => return Ok(false),
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
                return Ok(false)
            }
            None => return Err(anyhow!("archive policy refresh failed: {}", error.class())),
        },
    };

    let previous = (previous.collector_id.as_deref() == Some(collector_id)).then_some(&previous);
    let mut record = ArchiveEnrollmentRecord::from_confirmed(confirmed, previous);
    record.collector_id = Some(collector_id.to_string());
    record.reason = reason;
    record
        .save_record(&path)
        .context("save archive enrollment policy")?;
    Ok(true)
}

#[cfg(test)]
fn persist_policy_result(
    paths: &Paths,
    org_id: &str,
    result: std::result::Result<ArchivePolicyResponse, ArchiveClientError>,
) -> Result<bool> {
    persist_policy_result_for_collector(paths, org_id, "collector_test", result)
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

    async fn serve_policy_response(status: &str, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let status = status.to_string();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0u8; 8192];
            let _ = stream.read(&mut request).await.unwrap();
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        format!("http://{addr}")
    }

    fn enrollment_request(
        history_choice: ArchiveHistoryChoice,
        idempotency_key: &str,
    ) -> ArchiveEnrollmentRequest {
        ArchiveEnrollmentRequest {
            authorized_sources: vec![ArchiveSourceChoice {
                source: ArchiveSource::Claude,
                history_choice,
            }],
            idempotency_key: idempotency_key.to_string(),
        }
    }

    async fn assert_enrollment_failure(
        status: &str,
        body: &'static str,
        request: ArchiveEnrollmentRequest,
        message: &str,
        detail: &str,
    ) {
        let archive_url = serve_policy_response(status, body).await;
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();

        let error = enroll_archive_source(
            &paths,
            "org_1",
            "collector_1",
            archive_url,
            "tfc_test_secret",
            &request,
        )
        .await
        .unwrap_err();

        assert_eq!(error.to_string(), message);
        assert!(format!("{error:#}").contains(detail));
        assert!(!paths.archive_enrollment_file("org_1").exists());
    }

    #[tokio::test]
    async fn enrollment_response_is_persisted_and_reports_enrolled() {
        let archive_url = serve_policy_response(
            "200 OK",
            r#"{"enrolled":true,"authorizedSources":[{"source":"claude","historyChoice":"all_history","authorizedAt":1770000000001}],"reason":null}"#,
        )
        .await;

        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let request = enrollment_request(ArchiveHistoryChoice::AllHistory, "archive-enroll:test");

        assert!(enroll_archive_source(
            &paths,
            "org_1",
            "collector_1",
            archive_url,
            "tfc_test_secret",
            &request,
        )
        .await
        .unwrap());

        let record = load_archive_policy(&paths, "org_1").unwrap();
        assert_eq!(record.collector_id.as_deref(), Some("collector_1"));
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

    #[tokio::test]
    async fn user_enrollment_keeps_first_use_unavailability_loud() {
        assert_enrollment_failure(
            "503 Service Unavailable",
            r#"{"error":"archive_unavailable","reason":"policy_unavailable"}"#,
            enrollment_request(ArchiveHistoryChoice::AllHistory, "archive-enroll:retry"),
            "service unavailable",
            "archive unavailable",
        )
        .await;
    }

    #[tokio::test]
    async fn background_refresh_reports_only_a_received_policy_as_recovery() {
        let unavailable_url = serve_policy_response(
            "503 Service Unavailable",
            r#"{"error":"archive_unavailable","reason":"policy_unavailable"}"#,
        )
        .await;
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();

        assert!(!refresh_archive_policy(
            &paths,
            "org_1",
            "collector_1",
            unavailable_url,
            "tfc_test_secret",
        )
        .await
        .unwrap());
        assert!(!paths.archive_enrollment_file("org_1").exists());

        let policy_url = serve_policy_response(
            "200 OK",
            r#"{"enrolled":false,"authorizedSources":[],"reason":"not_activated"}"#,
        )
        .await;
        assert!(refresh_archive_policy(
            &paths,
            "org_1",
            "collector_1",
            policy_url,
            "tfc_test_secret",
        )
        .await
        .unwrap());
        assert_eq!(
            load_archive_policy(&paths, "org_1")
                .unwrap()
                .reason
                .as_deref(),
            Some("not_activated")
        );
    }

    async fn assert_terminal_refresh_does_not_apply_to_another_collector(
        stored_collector_id: Option<&str>,
    ) {
        let archive_url = serve_policy_response(
            "401 Unauthorized",
            r#"{"error":"unauthorized","reason":"expired"}"#,
        )
        .await;
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let path = paths.archive_enrollment_file("org_1");
        ArchiveEnrollmentRecord {
            status: ArchivePolicy::Enrolled.as_str().to_string(),
            collector_id: stored_collector_id.map(str::to_string),
            authorized_sources: vec![ArchiveAuthorizedSource {
                source: ArchiveSource::Claude,
                history_choice: ArchiveHistoryChoice::AllHistory,
                authorized_at: 1_770_000_000_002,
            }],
            reason: None,
        }
        .save_record(&path)
        .unwrap();
        let before = std::fs::read(&path).unwrap();

        assert!(!refresh_archive_policy(
            &paths,
            "org_1",
            "collector_current",
            archive_url,
            "tfc_test_secret",
        )
        .await
        .unwrap());
        assert_eq!(std::fs::read(path).unwrap(), before);
    }

    #[tokio::test]
    async fn terminal_refresh_does_not_report_recovery_for_unbound_or_other_collector_policy() {
        assert_terminal_refresh_does_not_apply_to_another_collector(None).await;
        assert_terminal_refresh_does_not_apply_to_another_collector(Some("collector_other")).await;
    }

    #[tokio::test]
    async fn terminal_refresh_applies_and_reports_recovery_for_matching_collector_policy() {
        let archive_url = serve_policy_response(
            "401 Unauthorized",
            r#"{"error":"unauthorized","reason":"expired"}"#,
        )
        .await;
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let path = paths.archive_enrollment_file("org_1");
        ArchiveEnrollmentRecord {
            status: ArchivePolicy::Enrolled.as_str().to_string(),
            collector_id: Some("collector_current".to_string()),
            authorized_sources: vec![ArchiveAuthorizedSource {
                source: ArchiveSource::Claude,
                history_choice: ArchiveHistoryChoice::AllHistory,
                authorized_at: 1_770_000_000_002,
            }],
            reason: None,
        }
        .save_record(&path)
        .unwrap();

        assert!(refresh_archive_policy(
            &paths,
            "org_1",
            "collector_current",
            archive_url,
            "tfc_test_secret",
        )
        .await
        .unwrap());
        let record = ArchiveEnrollmentRecord::load_record(&path).unwrap();
        assert_eq!(record.policy().unwrap(), ArchivePolicy::Frozen);
        assert_eq!(record.collector_id.as_deref(), Some("collector_current"));
        assert_eq!(record.authorized_sources.len(), 1);
        assert_eq!(
            record.authorized_sources[0].authorized_at,
            1_770_000_000_002
        );
    }

    #[tokio::test]
    async fn user_enrollment_reports_consent_conflict_without_rewriting_policy() {
        assert_enrollment_failure(
            "409 Conflict",
            r#"{"error":"consent_conflict","reason":"consent_conflict"}"#,
            enrollment_request(ArchiveHistoryChoice::NewOnly, "archive-enroll:conflict"),
            "history choice conflicts with existing consent",
            "archive history choice conflicts",
        )
        .await;
    }

    #[tokio::test]
    async fn user_enrollment_reports_an_invalid_request_without_rewriting_policy() {
        assert_enrollment_failure(
            "400 Bad Request",
            r#"{"error":"invalid_request","reason":"invalid_request"}"#,
            enrollment_request(ArchiveHistoryChoice::AllHistory, "archive-enroll:invalid"),
            "request was rejected",
            "archive enrollment request is invalid",
        )
        .await;
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
            collector_id: Some("collector_test".to_string()),
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
    fn new_collector_policy_never_inherits_prior_collector_sources() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let path = paths.archive_enrollment_file("org_1");
        ArchiveEnrollmentRecord {
            status: ArchivePolicy::Enrolled.as_str().to_string(),
            collector_id: Some("collector_old".to_string()),
            authorized_sources: vec![ArchiveAuthorizedSource {
                source: ArchiveSource::Claude,
                history_choice: ArchiveHistoryChoice::AllHistory,
                authorized_at: 1_770_000_000_002,
            }],
            reason: None,
        }
        .save_record(&path)
        .unwrap();

        persist_policy_result_for_collector(
            &paths,
            "org_1",
            "collector_new",
            Ok(ArchivePolicyResponse {
                enrolled: false,
                authorized_sources: Vec::new(),
                reason: Some("frozen".to_string()),
            }),
        )
        .unwrap();

        let record = ArchiveEnrollmentRecord::load_record(&path).unwrap();
        assert_eq!(record.collector_id.as_deref(), Some("collector_new"));
        assert_eq!(record.policy().unwrap(), ArchivePolicy::Frozen);
        assert!(record.authorized_sources.is_empty());
    }

    #[test]
    fn error_policy_does_not_rebind_or_rewrite_prior_collector_state() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let path = paths.archive_enrollment_file("org_1");
        ArchiveEnrollmentRecord {
            status: ArchivePolicy::Enrolled.as_str().to_string(),
            collector_id: Some("collector_old".to_string()),
            authorized_sources: vec![ArchiveAuthorizedSource {
                source: ArchiveSource::Claude,
                history_choice: ArchiveHistoryChoice::AllHistory,
                authorized_at: 1_770_000_000_002,
            }],
            reason: None,
        }
        .save_record(&path)
        .unwrap();
        let before = std::fs::read(&path).unwrap();

        persist_policy_result_for_collector(
            &paths,
            "org_1",
            "collector_new",
            Err(ArchiveClientError::Unauthorized {
                reason: "expired".to_string(),
            }),
        )
        .unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), before);
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
            collector_id: Some("collector_test".to_string()),
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
