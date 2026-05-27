// SPDX-License-Identifier: MIT
// Vendored and refactored from otto-api-client/src/lib.rs (~/src/otto, 2026-05-25).
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

pub mod client;
pub mod error;
pub mod retry;

pub use client::{CollectorApiClient, CollectorApiClientConfig};
pub use error::{IngestError, IngestResult, UpgradeRequiredDetail};
pub use retry::RetryConfig;
