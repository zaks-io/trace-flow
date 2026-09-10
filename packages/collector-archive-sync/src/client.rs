use std::time::Duration;

use anyhow::{anyhow, Context};
use collector_archive::ArchiveSource;
use reqwest::Client;
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::ack::ArchiveAcknowledgement;
use crate::error::ArchiveClientError;
use crate::policy::{ArchiveEnrollmentRequest, ArchivePolicyResponse};

const COLLECTOR_SECRET_HEADER: &str = "X-Trace-Flow-Collector-Secret";
const ARCHIVE_SOURCE_HEADER: &str = "X-Trace-Flow-Archive-Source";

#[derive(Clone)]
pub struct ArchiveClientConfig {
    pub archive_url: String,
    pub credential: String,
    pub timeout: Duration,
}

impl std::fmt::Debug for ArchiveClientConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ArchiveClientConfig")
            .field("archive_url", &self.archive_url)
            .field("credential", &"<redacted>")
            .field("timeout", &self.timeout)
            .finish()
    }
}

impl ArchiveClientConfig {
    pub fn new(archive_url: impl Into<String>, credential: impl Into<String>) -> Self {
        Self {
            archive_url: archive_url.into(),
            credential: credential.into(),
            timeout: Duration::from_secs(120),
        }
    }
}

#[derive(Clone)]
pub struct ArchiveClient {
    client: Client,
    config: ArchiveClientConfig,
}

impl ArchiveClient {
    pub fn new(config: ArchiveClientConfig) -> anyhow::Result<Self> {
        let client = Client::builder()
            .timeout(config.timeout)
            .build()
            .context("build archive http client")?;
        Ok(Self { client, config })
    }

    pub fn with_reqwest_client(client: Client, config: ArchiveClientConfig) -> Self {
        Self { client, config }
    }

    pub async fn fetch_policy(&self) -> Result<ArchivePolicyResponse, ArchiveClientError> {
        let url = format!(
            "{}/v1/archive/policy",
            self.config.archive_url.trim_end_matches('/')
        );
        let response = self
            .client
            .get(&url)
            .header(COLLECTOR_SECRET_HEADER, self.config.credential.as_str())
            .send()
            .await
            .map_err(|err| ArchiveClientError::Transport(anyhow!("http send failed: {err}")))?;
        let status = response.status().as_u16();
        let body = response
            .text()
            .await
            .map_err(|_| ArchiveClientError::InvalidPolicy)?;
        classify_policy_response(status, &body)
    }

    pub async fn enroll(
        &self,
        request: &ArchiveEnrollmentRequest,
    ) -> Result<ArchivePolicyResponse, ArchiveClientError> {
        let url = format!(
            "{}/v1/archive/enrollments",
            self.config.archive_url.trim_end_matches('/')
        );
        let response = self
            .client
            .post(&url)
            .header(COLLECTOR_SECRET_HEADER, self.config.credential.as_str())
            .json(request)
            .send()
            .await
            .map_err(|err| ArchiveClientError::Transport(anyhow!("http send failed: {err}")))?;
        let status = response.status().as_u16();
        let body = response
            .text()
            .await
            .map_err(|_| ArchiveClientError::InvalidPolicy)?;
        classify_enrollment_response(status, &body)
    }
}

#[allow(async_fn_in_trait)]
pub trait ArchiveUploader {
    async fn upload(
        &self,
        source: ArchiveSource,
        body: &[u8],
        cancel: Option<&CancellationToken>,
    ) -> Result<ArchiveAcknowledgement, ArchiveClientError>;
}

impl ArchiveUploader for ArchiveClient {
    async fn upload(
        &self,
        source: ArchiveSource,
        body: &[u8],
        cancel: Option<&CancellationToken>,
    ) -> Result<ArchiveAcknowledgement, ArchiveClientError> {
        let url = format!(
            "{}/v1/archive/uploads",
            self.config.archive_url.trim_end_matches('/')
        );
        let request = self
            .client
            .post(&url)
            .header(COLLECTOR_SECRET_HEADER, self.config.credential.as_str())
            .header(ARCHIVE_SOURCE_HEADER, source.as_str())
            .header("Content-Type", "application/json")
            .body(body.to_vec());

        let response = if let Some(token) = cancel {
            tokio::select! {
                _ = token.cancelled() => {
                    return Err(ArchiveClientError::Transport(anyhow!("request cancelled")));
                }
                res = request.send() => res,
            }
        } else {
            request.send().await
        }
        .map_err(|err| ArchiveClientError::Transport(anyhow!("http send failed: {err}")))?;

        let status = response.status().as_u16();
        let body_text = response.text().await.unwrap_or_else(|_| String::from("{}"));
        classify_response(status, &body_text)
    }
}

#[derive(Deserialize)]
struct ErrorBody {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

fn safe_server_reason(value: Option<String>) -> String {
    match value.as_deref() {
        Some(
            reason @ ("invalid_credential_class"
            | "invalid"
            | "credential_revoked"
            | "enrollment_invalid"
            | "deleting"
            | "revoked"
            | "frozen"
            | "expired"
            | "not_pro"
            | "server_disabled"
            | "not_activated"
            | "not_enrolled"
            | "policy_unavailable"
            | "policy_mismatch"
            | "policy_malformed"
            | "request_body_limit"
            | "archive_upload_observation_limit"
            | "unsupported_archive_upload_wire_version"
            | "archive_element_exceeds_chunk_limit"
            | "storage_cap_exceeded"
            | "archive_commit_failed"
            | "key_configuration_invalid"
            | "key_unavailable"
            | "archive_registry_failed"),
        ) => reason.to_string(),
        _ => "unknown".to_string(),
    }
}

fn classify_response(
    status: u16,
    body: &str,
) -> Result<ArchiveAcknowledgement, ArchiveClientError> {
    if (200..300).contains(&status) {
        return serde_json::from_str::<ArchiveAcknowledgement>(body)
            .map_err(|_| ArchiveClientError::InvalidAcknowledgement)
            .and_then(|ack| {
                if ack.status == "acknowledged" {
                    Ok(ack)
                } else {
                    Err(ArchiveClientError::InvalidAcknowledgement)
                }
            });
    }
    let parsed: ErrorBody = serde_json::from_str(body).unwrap_or(ErrorBody {
        error: None,
        reason: None,
    });
    match status {
        401 => Err(ArchiveClientError::Unauthorized {
            reason: safe_server_reason(parsed.reason),
        }),
        403 => Err(ArchiveClientError::Forbidden {
            reason: safe_server_reason(parsed.reason),
        }),
        413 => Err(ArchiveClientError::UploadTooLarge {
            reason: safe_server_reason(parsed.reason.or(parsed.error)),
        }),
        400 => Err(ArchiveClientError::InvalidUpload {
            reason: safe_server_reason(parsed.reason.or(parsed.error)),
        }),
        503 => Err(ArchiveClientError::Unavailable {
            reason: safe_server_reason(parsed.reason.or(parsed.error)),
        }),
        _ => Err(ArchiveClientError::UploadRejected {
            status,
            reason: safe_server_reason(parsed.reason.or(parsed.error)),
        }),
    }
}

fn classify_policy_response(
    status: u16,
    body: &str,
) -> Result<ArchivePolicyResponse, ArchiveClientError> {
    if (200..300).contains(&status) {
        return serde_json::from_str(body).map_err(|_| ArchiveClientError::InvalidPolicy);
    }
    let parsed: ErrorBody = serde_json::from_str(body).unwrap_or(ErrorBody {
        error: None,
        reason: None,
    });
    match status {
        401 => Err(ArchiveClientError::Unauthorized {
            reason: safe_server_reason(parsed.reason),
        }),
        403 => Err(ArchiveClientError::Forbidden {
            reason: safe_server_reason(parsed.reason),
        }),
        503 => Err(ArchiveClientError::Unavailable {
            reason: safe_server_reason(parsed.reason.or(parsed.error)),
        }),
        _ => Err(ArchiveClientError::UploadRejected {
            status,
            reason: safe_server_reason(parsed.reason.or(parsed.error)),
        }),
    }
}

fn classify_enrollment_response(
    status: u16,
    body: &str,
) -> Result<ArchivePolicyResponse, ArchiveClientError> {
    match status {
        400 => Err(ArchiveClientError::InvalidEnrollmentRequest),
        409 => Err(ArchiveClientError::ConsentConflict),
        _ => classify_policy_response(status, body),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_debug_redacts_credential() {
        let debug = format!(
            "{:?}",
            ArchiveClientConfig::new("https://archive.example", "tfc_secret")
        );
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains("tfc_secret"));
    }

    #[test]
    fn success_requires_acknowledged_status() {
        let err = classify_response(
            200,
            r#"{"status":"pending","source":"claude","source_session_id":"s","record_count":1}"#,
        );
        assert!(matches!(
            err,
            Err(ArchiveClientError::InvalidAcknowledgement)
        ));
    }

    #[test]
    fn policy_response_preserves_history_choice_and_authorized_at() {
        let policy = classify_policy_response(
            200,
            r#"{"enrolled":true,"authorizedSources":[{"source":"claude","historyChoice":"all_history","authorizedAt":1770000000001}],"reason":null}"#,
        )
        .unwrap();
        let confirmed = policy.confirmed().unwrap();
        assert_eq!(confirmed.policy, crate::policy::ArchivePolicy::Enrolled);
        assert_eq!(
            confirmed.authorized_sources[0].authorized_at,
            1_770_000_000_001
        );
    }

    #[test]
    fn malformed_policy_response_fails_loud() {
        assert!(matches!(
            classify_policy_response(200, r#"{"enrolled":true}"#),
            Err(ArchiveClientError::InvalidPolicy)
        ));
    }

    #[test]
    fn enrollment_errors_have_distinct_request_and_consent_classes() {
        assert!(matches!(
            classify_enrollment_response(400, r#"{"error":"invalid_request"}"#),
            Err(ArchiveClientError::InvalidEnrollmentRequest)
        ));
        assert!(matches!(
            classify_enrollment_response(409, r#"{"error":"consent_conflict"}"#),
            Err(ArchiveClientError::ConsentConflict)
        ));
    }

    #[test]
    fn upload_errors_keep_status_and_only_known_server_reasons() {
        let unsupported = classify_response(
            400,
            r#"{"error":"upload_rejected","reason":"unsupported_archive_upload_wire_version"}"#,
        )
        .unwrap_err();
        assert_eq!(unsupported.http_status(), Some(400));
        assert_eq!(
            unsupported.safe_reason(),
            Some("unsupported_archive_upload_wire_version")
        );
        assert_eq!(unsupported.class(), "archive_wire_unsupported");

        let untrusted = classify_response(
            503,
            r#"{"reason":"source payload and secret-like attacker text"}"#,
        )
        .unwrap_err();
        assert_eq!(untrusted.http_status(), Some(503));
        assert_eq!(untrusted.safe_reason(), Some("unknown"));
        assert!(!format!("{untrusted:?}").contains("attacker text"));
    }
}
