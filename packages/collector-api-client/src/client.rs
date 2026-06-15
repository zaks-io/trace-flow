// SPDX-License-Identifier: MIT
// Vendored and refactored from otto-api-client/src/lib.rs (~/src/otto, 2026-05-25).
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

use std::io::Write as _;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use collector_contracts::AgentIngestEnvelope;
use flate2::{write::GzEncoder, Compression};
use reqwest::Client;
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::error::{IngestError, IngestOk, IngestResult, UpgradeRequiredDetail};
use crate::retry::{backoff_delay, RetryConfig, DEFAULT_TIMEOUT};

#[derive(Clone)]
pub struct CollectorApiClientConfig {
    /// Base URL of the ingest worker, e.g. `https://ingest.trace.flow`.
    pub ingest_url: String,
    /// Raw Collector Credential secret. Sent verbatim in the `X-Trace-Flow-Collector-Secret`
    /// header — the ingest worker (`apps/agent-ingest/src/auth.ts`) hashes it and looks it up in
    /// the `COLLECTOR_CREDS` KV namespace. Not `Authorization: Bearer` (that is the user-facing
    /// API-key scheme); the Collector Credential is a distinct, hidden credential.
    pub credential: String,
    pub timeout: Duration,
    pub retry: RetryConfig,
}

// Manual Debug so the credential never lands in logs or panic output.
impl std::fmt::Debug for CollectorApiClientConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CollectorApiClientConfig")
            .field("ingest_url", &self.ingest_url)
            .field("credential", &"<redacted>")
            .field("timeout", &self.timeout)
            .field("retry", &self.retry)
            .finish()
    }
}

impl CollectorApiClientConfig {
    pub fn new(ingest_url: impl Into<String>, credential: impl Into<String>) -> Self {
        Self {
            ingest_url: ingest_url.into(),
            credential: credential.into(),
            timeout: DEFAULT_TIMEOUT,
            retry: RetryConfig::default(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CollectorApiClient {
    client: Client,
    config: CollectorApiClientConfig,
}

impl CollectorApiClient {
    pub fn new(config: CollectorApiClientConfig) -> Result<Self> {
        let client = Client::builder()
            // gzip(true) enables automatic response decompression only — not request compression.
            .gzip(true)
            .timeout(config.timeout)
            .build()
            .context("build http client")?;
        Ok(Self { client, config })
    }

    /// Inject a pre-built reqwest client; useful in tests with a mock server.
    pub fn with_reqwest_client(client: Client, config: CollectorApiClientConfig) -> Self {
        Self { client, config }
    }

    /// POST an `AgentIngestEnvelope` to `POST /v1/ingest`.
    ///
    /// Retries transport send failures and `503 {error:"policy_unavailable"}` — transient cases
    /// where another request attempt can succeed without changing the envelope. Every other HTTP
    /// response failure is terminal for this call; the sync loop decides whether to re-send the batch
    /// on the next cycle.
    pub async fn ingest(
        &self,
        envelope: &AgentIngestEnvelope,
        cancel: Option<&CancellationToken>,
    ) -> IngestResult {
        let url = format!("{}/v1/ingest", self.config.ingest_url.trim_end_matches('/'));
        let body = gzip_json(envelope).map_err(IngestError::Transport)?;

        for attempt in 0..=self.config.retry.max_retries {
            if cancel.map(|t| t.is_cancelled()).unwrap_or(false) {
                return Err(IngestError::Transport(anyhow!("request cancelled")));
            }

            let request = self
                .client
                .post(&url)
                .header(
                    "X-Trace-Flow-Collector-Secret",
                    self.config.credential.as_str(),
                )
                .header("Content-Type", "application/json")
                .header("Content-Encoding", "gzip")
                .body(body.clone());

            let result = if let Some(token) = cancel {
                tokio::select! {
                    _ = token.cancelled() => {
                        return Err(IngestError::Transport(anyhow!("request cancelled")));
                    }
                    res = request.send() => res,
                }
            } else {
                request.send().await
            };

            let response = match result {
                Ok(r) => r,
                Err(err) => {
                    if attempt < self.config.retry.max_retries {
                        backoff_delay(attempt, &self.config.retry, cancel)
                            .await
                            .map_err(IngestError::Transport)?;
                        continue;
                    }
                    return Err(IngestError::Transport(anyhow!("http send failed: {err}")));
                }
            };

            let status = response.status().as_u16();
            let body_text = response.text().await.unwrap_or_else(|_| String::from("{}"));

            match classify_response(status, &body_text) {
                ResponseClass::Success(ok) => return Ok(ok),
                ResponseClass::RetryableUnavailable => {
                    // Only policy_unavailable is retried.
                    if attempt < self.config.retry.max_retries {
                        backoff_delay(attempt, &self.config.retry, cancel)
                            .await
                            .map_err(IngestError::Transport)?;
                        continue;
                    }
                    return Err(IngestError::Transport(anyhow!(
                        "policy_unavailable after {} attempts",
                        attempt + 1
                    )));
                }
                ResponseClass::Terminal(err) => return Err(err),
            }
        }

        // Every loop path returns or `continue`s, and the last iteration cannot `continue`
        // (the retry guard is `attempt < max_retries`), so control never falls through here.
        unreachable!("ingest retry loop must return on every iteration")
    }
}

enum ResponseClass {
    Success(IngestOk),
    /// `503 policy_unavailable` — the only case we retry.
    RetryableUnavailable,
    Terminal(IngestError),
}

#[derive(Deserialize)]
struct IngestResponseBody {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    min_desktop_version: Option<String>,
    #[serde(default)]
    min_parser_version: Option<String>,
    #[serde(default)]
    sessions: Option<u32>,
    #[serde(default)]
    skipped_conflict: Option<u32>,
}

fn classify_response(status: u16, body: &str) -> ResponseClass {
    let parsed: IngestResponseBody = serde_json::from_str(body).unwrap_or(IngestResponseBody {
        error: None,
        reason: None,
        detail: None,
        min_desktop_version: None,
        min_parser_version: None,
        sessions: None,
        skipped_conflict: None,
    });

    match status {
        202 => ResponseClass::Success(IngestOk {
            sessions: parsed.sessions.unwrap_or(0),
            skipped_conflict: parsed.skipped_conflict.unwrap_or(0),
        }),
        401 => ResponseClass::Terminal(IngestError::Unauthorized {
            reason: parsed.reason.unwrap_or_default(),
        }),
        400 => ResponseClass::Terminal(IngestError::InvalidEnvelope),
        413 => ResponseClass::Terminal(IngestError::PayloadTooLarge),
        426 => ResponseClass::Terminal(IngestError::UpgradeRequired(Box::new(
            UpgradeRequiredDetail {
                detail: parsed.detail.unwrap_or_default(),
                min_desktop_version: parsed.min_desktop_version.unwrap_or_default(),
                min_parser_version: parsed.min_parser_version.unwrap_or_default(),
            },
        ))),
        429 => ResponseClass::Terminal(IngestError::RateLimited),
        503 => match parsed.error.as_deref() {
            Some("policy_unavailable") => ResponseClass::RetryableUnavailable,
            Some("session_claim_unavailable") => {
                ResponseClass::Terminal(IngestError::SessionClaimUnavailable)
            }
            Some("enqueue_failed") => ResponseClass::Terminal(IngestError::EnqueueFailed),
            _ => ResponseClass::Terminal(IngestError::InternalError),
        },
        500 => ResponseClass::Terminal(IngestError::InternalError),
        _ => ResponseClass::Terminal(IngestError::InternalError),
    }
}

/// Serializes `value` to JSON and gzip-compresses the bytes.
///
/// The ingest worker buffers the entire body before parsing, so we use the
/// default compression level. `reqwest`'s `.gzip(true)` only decompresses
/// responses — sending compressed request bodies requires manual encoding here.
fn gzip_json<T: serde::Serialize>(value: &T) -> Result<Vec<u8>> {
    let json = serde_json::to_vec(value).context("serialize envelope to JSON")?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&json).context("gzip write")?;
    encoder.finish().context("gzip finish")
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
