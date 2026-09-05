//! Encrypted Desktop Archive Spool and Archive API uploader.
//!
//! Parsed fact sync stays on [`collector_api_client::CollectorApiClient`]. This crate owns the
//! Archive request path only: an authenticated local spool capped at exactly
//! [`ARCHIVE_SPOOL_CAP_BYTES`] and [`ArchiveClient`] POSTs of those exact pending bytes.

mod ack;
mod client;
mod crypto;
mod cycle;
mod enrollment;
mod error;
mod key_store;
mod policy;
mod scan;
mod spool;

pub use ack::{acknowledgement_matches, ArchiveAcknowledgement};
pub use client::{ArchiveClient, ArchiveClientConfig, ArchiveUploader};
pub use collector_archive::ArchiveSource;
pub use cycle::{run_archive_cycle, ArchiveCycleReport, ArchiveSnapshot};
pub use enrollment::ArchiveEnrollmentRecord;
pub use error::{ArchiveClientError, ArchiveSyncError, ArchiveSyncResult};
pub use key_store::{ArchiveKeyStore, ArchiveSpoolKey, MemoryKeyStore, OsKeyStore};
pub use policy::{policy_from_denial_reason, ArchivePolicy};
pub use scan::{archive_source_session_id, scan_snapshot};
pub use spool::{
    ArchiveSpool, PendingArchiveRequest, ARCHIVE_SPOOL_CAP_BYTES, ARCHIVE_SPOOL_KEYRING_SERVICE,
};

/// Exact on-disk Archive Spool cap. Do not substitute a rounded gigabyte.
#[allow(dead_code)]
const _: () = assert!(ARCHIVE_SPOOL_CAP_BYTES == 2_147_483_648);
