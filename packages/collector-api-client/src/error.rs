// SPDX-License-Identifier: Apache-2.0
// Vendored and refactored from otto-api-client/src/lib.rs (~/src/otto, 2026-05-25).
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

use std::fmt;
use std::time::Duration;

use thiserror::Error;

/// Returned by the ingest worker when the client or Collector binary is too old.
#[derive(Debug, Clone, PartialEq)]
pub struct UpgradeRequiredDetail {
    pub detail: String,
    pub min_desktop_version: String,
    pub min_parser_version: String,
}

/// What a `400 invalid_envelope` body says about the rejection. Older ingest Workers send only
/// `{error}`, so every field is optional; a `fact_identity_conflict` names the vendor sessions whose
/// facts conflicted, which lets the sync loop isolate the bad unit without bisecting the batch.
/// `reason` and `category` hold only code-like tokens; the client drops any other text the server
/// sends there, so they are safe to show in sync reports.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct InvalidEnvelopeDetail {
    pub reason: Option<String>,
    pub category: Option<String>,
    pub vendor_session_ids: Vec<String>,
}

impl InvalidEnvelopeDetail {
    /// The report-safe part of the rejection: its reason and category codes, without session ids.
    pub fn cause(&self) -> InvalidEnvelopeCause {
        InvalidEnvelopeCause {
            reason: self.reason.clone(),
            category: self.category.clone(),
        }
    }
}

/// Why ingest rejected an envelope, as the enum-like codes a sync report shows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InvalidEnvelopeCause {
    pub reason: Option<String>,
    pub category: Option<String>,
}

impl InvalidEnvelopeCause {
    pub fn is_empty(&self) -> bool {
        self.reason.is_none() && self.category.is_none()
    }
}

impl fmt::Display for InvalidEnvelopeCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (&self.reason, &self.category) {
            (None, None) => f.write_str("no reason given"),
            (Some(reason), None) => write!(f, "reason={reason}"),
            (None, Some(category)) => write!(f, "category={category}"),
            (Some(reason), Some(category)) => write!(f, "reason={reason} category={category}"),
        }
    }
}

/// Accept a server-supplied reason or category only when it looks like a code (`snake_case`, short),
/// so a misbehaving Worker cannot route transcript text or paths into a report.
pub(crate) fn code_token(value: Option<String>) -> Option<String> {
    value.filter(|v| {
        (1..=64).contains(&v.len())
            && v.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    })
}

fn invalid_envelope_suffix(detail: &InvalidEnvelopeDetail) -> String {
    let cause = detail.cause();
    if cause.is_empty() {
        String::new()
    } else {
        format!(" ({cause})")
    }
}

/// Every distinct terminal outcome from `POST /v1/ingest`.
///
/// The 3b sync loop advances its cursor only on `Ok(IngestOk)`. All other
/// variants are terminal for the current request; the loop decides whether to
/// retry the batch next cycle.
#[derive(Debug, Error)]
pub enum IngestError {
    /// `401` — credential missing, invalid, expired, or revoked.
    #[error("unauthorized: {reason}")]
    Unauthorized { reason: String },

    /// `413` — envelope exceeds the worker's hard size cap.
    #[error("payload too large")]
    PayloadTooLarge,

    /// `400` — envelope failed structural validation or carried conflicting fact identities.
    #[error("invalid envelope{}", invalid_envelope_suffix(.0))]
    InvalidEnvelope(InvalidEnvelopeDetail),

    /// `426` — client or parser is below the policy minimum version.
    #[error("upgrade required: {}", .0.detail)]
    UpgradeRequired(Box<UpgradeRequiredDetail>),

    /// `429` — org-level rate limit exhausted. `retry_after` is the server's `Retry-After`, if sent.
    #[error("rate limited")]
    RateLimited { retry_after: Option<Duration> },

    /// `503 session_claim_unavailable` — Convex unreachable for session ownership.
    /// Not retried in-request; the sync loop re-sends next cycle.
    #[error("session claim unavailable")]
    SessionClaimUnavailable,

    /// `503 enqueue_failed`: delivery admission is closed or the queue send failed. Retried
    /// in-request only while a bounded `Retry-After` marks admission backpressure. Once that budget
    /// is spent, the sync loop stops the cycle and backs off for at least `retry_after`.
    #[error("enqueue failed")]
    EnqueueFailed { retry_after: Option<Duration> },

    /// `500` — unexpected server error.
    #[error("internal server error")]
    InternalError,

    /// Transport or serialization error (network failure, gzip, JSON decode).
    #[error("transport error: {0}")]
    Transport(#[from] anyhow::Error),
}

impl IngestError {
    /// True for responses that say the server is shedding this collector's load, so every remaining
    /// POST in the cycle would be refused too and the embedder should back off before the next one.
    pub fn is_backoff(&self) -> bool {
        matches!(self, Self::RateLimited { .. } | Self::EnqueueFailed { .. })
    }

    /// The server's requested `Retry-After`, when the response carried one.
    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            Self::RateLimited { retry_after } | Self::EnqueueFailed { retry_after } => *retry_after,
            _ => None,
        }
    }
}

/// Successful `202 accepted` response payload.
#[derive(Debug, Clone, PartialEq)]
pub struct IngestOk {
    pub sessions: u32,
    pub skipped_conflict: u32,
}

pub type IngestResult = Result<IngestOk, IngestError>;
