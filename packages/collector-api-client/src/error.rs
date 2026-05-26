// SPDX-License-Identifier: MIT
// Vendored and refactored from otto-api-client/src/lib.rs (~/src/otto, 2026-05-25).
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

use thiserror::Error;

/// Returned by the ingest worker when the client or Collector binary is too old.
#[derive(Debug, Clone, PartialEq)]
pub struct UpgradeRequiredDetail {
    pub detail: String,
    pub min_desktop_version: String,
    pub min_parser_version: String,
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

    /// `400` — envelope failed structural validation in the worker.
    #[error("invalid envelope")]
    InvalidEnvelope,

    /// `426` — client or parser is below the policy minimum version.
    #[error("upgrade required: {}", .0.detail)]
    UpgradeRequired(Box<UpgradeRequiredDetail>),

    /// `429` — org-level rate limit exhausted.
    #[error("rate limited")]
    RateLimited,

    /// `503 session_claim_unavailable` — Convex unreachable for session ownership.
    /// Not retried in-request; the sync loop re-sends next cycle.
    #[error("session claim unavailable")]
    SessionClaimUnavailable,

    /// `503 enqueue_failed` — queue send failed after partial or full enqueue.
    /// Not retried in-request; the sync loop re-sends next cycle.
    #[error("enqueue failed")]
    EnqueueFailed,

    /// `500` — unexpected server error.
    #[error("internal server error")]
    InternalError,

    /// Transport or serialization error (network failure, gzip, JSON decode).
    #[error("transport error: {0}")]
    Transport(#[from] anyhow::Error),
}

/// Successful `202 accepted` response payload.
#[derive(Debug, Clone, PartialEq)]
pub struct IngestOk {
    pub sessions: u32,
    pub skipped_conflict: u32,
}

pub type IngestResult = Result<IngestOk, IngestError>;
