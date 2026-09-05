use std::time::Duration;

use anyhow::{anyhow, Context};
use collector_archive::ArchiveSource;
use reqwest::Client;
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::ack::ArchiveAcknowledgement;
use crate::error::ArchiveClientError;

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
            reason: parsed.reason.unwrap_or_default(),
        }),
        403 => Err(ArchiveClientError::Forbidden {
            reason: parsed.reason.unwrap_or_default(),
        }),
        413 => Err(ArchiveClientError::UploadTooLarge),
        400 => Err(ArchiveClientError::InvalidUpload),
        503 => Err(ArchiveClientError::Unavailable {
            reason: parsed.reason.or(parsed.error).unwrap_or_default(),
        }),
        _ => Err(ArchiveClientError::UploadRejected {
            reason: parsed.reason.or(parsed.error).unwrap_or_default(),
        }),
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
}
