//! Encrypted Desktop Archive Spool and Archive API uploader.
//!
//! Parsed fact sync stays on [`collector_api_client::CollectorApiClient`]. This crate owns the
//! Archive request path only: an authenticated local spool capped at exactly
//! [`ARCHIVE_SPOOL_CAP_BYTES`] and [`ArchiveClient`] POSTs of those exact pending bytes.

mod ack;
mod bound;
mod capture;
mod client;
mod crypto;
mod cycle;
mod enrollment;
mod error;
mod generation;
mod history;
mod key_store;
mod migration;
mod policy;
mod scan;
mod source_capture;
mod source_identity;
mod spool;

pub use ack::{acknowledgement_matches, ArchiveAcknowledgement};
pub use bound::{
    build_bounded_pending_for_part, build_bounded_pending_for_part_with_limits,
    MAX_ARCHIVE_UPLOAD_BYTES, MAX_UPLOAD_OBSERVATIONS,
};
pub use capture::{
    apply_archive_upload_response, prepare_next_archive_upload,
    prepare_next_archive_upload_excluding, send_prepared_archive_upload, ArchiveUploadResponse,
    PreparedArchiveUpload, UploadOutcome,
};
pub use client::{ArchiveClient, ArchiveClientConfig, ArchiveUploader};
pub use collector_archive::ArchiveSource;
pub use cycle::{
    capture_archive_snapshots, ArchiveCycleReport, ArchiveForkEvent, ArchiveInitialImport,
    ArchiveSnapshot, ArchiveSourceHistoryReport, DeferredArchiveSnapshot,
};
pub use enrollment::ArchiveEnrollmentRecord;
pub use error::{ArchiveClientError, ArchiveSyncError, ArchiveSyncResult};
pub use generation::{ArchiveGenerationHistoryEntry, ArchiveGenerationRecord};
pub use history::{
    ArchiveBaselineTarget, ArchiveHistoryGeneration, ArchiveHistoryPlan, ArchiveHistoryState,
    ArchiveWorkClass, ARCHIVE_CAPTURE_WINDOW_BYTES, ARCHIVE_HISTORY_STATE_VERSION,
};
pub use key_store::{ArchiveKeyStore, ArchiveSpoolKey, MemoryKeyStore, OsKeyStore};
pub use migration::prepare_archive_spool;
pub use policy::{
    policy_from_denial_reason, ArchiveAuthorizedSource, ArchiveEnrollmentRequest,
    ArchiveHistoryChoice, ArchivePolicy, ArchivePolicyParseError, ArchivePolicyResponse,
    ArchiveSourceChoice, ConfirmedArchivePolicy,
};
pub use scan::{
    archive_source_session_id, archive_source_session_id_from_records, parse_jsonl_records,
    scan_snapshot_part, transcript_part_for, transcript_part_for_records,
};
pub use source_identity::{source_file_identity, ArchiveSourceIdentity};
pub use spool::{
    cleanup_obligation_exists, finish_terminal_cleanup, ArchiveSpool, BlockedArchiveRecord,
    PendingArchiveRequest, PendingCaptureAuthorization, PendingLoad, ARCHIVE_RECORD_POLICY_VERSION,
    ARCHIVE_SPOOL_CAP_BYTES, ARCHIVE_SPOOL_KEYRING_SERVICE,
};

/// Exact on-disk Archive Spool cap. Do not substitute a rounded gigabyte.
#[allow(dead_code)]
const _: () = assert!(ARCHIVE_SPOOL_CAP_BYTES == 2_147_483_648);
