use thiserror::Error;

pub type ArchiveSyncResult<T> = Result<T, ArchiveSyncError>;

#[derive(Debug, Error)]
pub enum ArchiveSyncError {
    #[error("archive spool is at capacity")]
    CapacityExceeded,
    #[error("archive spool is corrupt")]
    Corrupt,
    #[error("unsupported archive source")]
    UnsupportedSource,
    #[error("archive session is invalid")]
    InvalidSession,
    #[error("archive enrollment status is invalid")]
    InvalidEnrollment,
    #[error("archive key is unavailable")]
    KeyUnavailable,
    #[error("archive acknowledgement does not match the pending request")]
    AcknowledgementMismatch,
    #[error("archive upload is too large")]
    UploadTooLarge,
    #[error("archive I/O failed")]
    Io(#[from] std::io::Error),
    #[error("archive crypto failed")]
    Crypto,
    #[error(transparent)]
    Scan(#[from] collector_archive::JsonlError),
    #[error(transparent)]
    Archive(#[from] collector_archive::ArchiveError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl ArchiveSyncError {
    pub fn class(&self) -> &'static str {
        match self {
            Self::CapacityExceeded => "archive_spool_full",
            Self::Corrupt => "archive_spool_corrupt",
            Self::UnsupportedSource => "unsupported_archive_source",
            Self::InvalidSession => "invalid_archive_session",
            Self::InvalidEnrollment => "archive_enrollment_invalid",
            Self::KeyUnavailable => "archive_key_unavailable",
            Self::AcknowledgementMismatch => "archive_ack_mismatch",
            Self::UploadTooLarge => "upload_too_large",
            Self::Io(_) => "archive_io",
            Self::Crypto => "archive_crypto",
            Self::Scan(_) => "archive_scan",
            Self::Archive(_) => "archive_contract",
            Self::Json(_) => "archive_state",
        }
    }
}

#[derive(Debug, Error)]
pub enum ArchiveClientError {
    #[error("unauthorized: {reason}")]
    Unauthorized { reason: String },
    #[error("forbidden: {reason}")]
    Forbidden { reason: String },
    #[error("invalid archive upload")]
    InvalidUpload,
    #[error("archive upload too large")]
    UploadTooLarge,
    #[error("archive upload rejected")]
    UploadRejected { reason: String },
    #[error("archive unavailable")]
    Unavailable { reason: String },
    #[error("invalid archive acknowledgement")]
    InvalidAcknowledgement,
    #[error("transport error")]
    Transport(#[from] anyhow::Error),
}

impl ArchiveClientError {
    pub fn class(&self) -> &'static str {
        match self {
            Self::Unauthorized { .. } => "unauthorized",
            Self::Forbidden { .. } => "forbidden",
            Self::InvalidUpload => "invalid_upload",
            Self::UploadTooLarge => "upload_too_large",
            Self::UploadRejected { .. } => "upload_rejected",
            Self::Unavailable { .. } => "archive_unavailable",
            Self::InvalidAcknowledgement => "invalid_acknowledgement",
            Self::Transport(_) => "transport",
        }
    }

    pub fn denial_reason(&self) -> Option<&str> {
        match self {
            Self::Unauthorized { reason } | Self::Forbidden { reason } => Some(reason.as_str()),
            _ => None,
        }
    }
}
