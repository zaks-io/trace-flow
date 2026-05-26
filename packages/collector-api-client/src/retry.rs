// SPDX-License-Identifier: MIT
// Vendored and refactored from otto-api-client/src/lib.rs (~/src/otto, 2026-05-25).
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

use std::time::Duration;

use anyhow::{anyhow, Result};
use tokio_util::sync::CancellationToken;

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_MAX_RETRIES: u32 = 3;
pub const DEFAULT_BASE_BACKOFF: Duration = Duration::from_millis(250);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct RetryConfig {
    pub max_retries: u32,
    pub base_backoff: Duration,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_retries: DEFAULT_MAX_RETRIES,
            base_backoff: DEFAULT_BASE_BACKOFF,
        }
    }
}

pub async fn backoff_delay(
    attempt: u32,
    retry: &RetryConfig,
    cancel: Option<&CancellationToken>,
) -> Result<()> {
    let factor = 1u32.checked_shl(attempt).unwrap_or(u32::MAX) as u128;
    let ms = retry.base_backoff.as_millis().saturating_mul(factor);
    let ms = ms.min(MAX_BACKOFF.as_millis()) as u64;
    let sleep = tokio::time::sleep(Duration::from_millis(ms));
    if let Some(token) = cancel {
        tokio::select! {
            _ = token.cancelled() => Err(anyhow!("request cancelled")),
            _ = sleep => Ok(()),
        }
    } else {
        sleep.await;
        Ok(())
    }
}
