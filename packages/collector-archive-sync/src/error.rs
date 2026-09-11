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
    #[error("archive source record exceeds the supported upload limit")]
    RecordTooLarge {
        source_record_identity: String,
        record_size_bytes: u64,
        limit_bytes: u64,
    },
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
            Self::RecordTooLarge { .. } => "archive_record_too_large",
            Self::Io(_) => "archive_io",
            Self::Crypto => "archive_crypto",
            Self::Scan(collector_archive::JsonlError::HistoricalPrefixChanged) => {
                "archive_historical_prefix_changed"
            }
            Self::Scan(collector_archive::JsonlError::HistoricalPrefixShortened) => {
                "archive_historical_prefix_shortened"
            }
            Self::Scan(_) => "archive_scan",
            Self::Archive(_) => "archive_contract",
            Self::Json(_) => "archive_state",
        }
    }
}

#[cfg(test)]
mod tests {
    use collector_archive::JsonlError;

    use super::ArchiveSyncError;

    #[test]
    fn historical_prefix_failures_have_actionable_classes() {
        assert_eq!(
            ArchiveSyncError::Scan(JsonlError::HistoricalPrefixChanged).class(),
            "archive_historical_prefix_changed"
        );
        assert_eq!(
            ArchiveSyncError::Scan(JsonlError::HistoricalPrefixShortened).class(),
            "archive_historical_prefix_shortened"
        );
    }
}

#[derive(Debug, Error)]
pub enum ArchiveClientError {
    #[error("unauthorized: {reason}")]
    Unauthorized { reason: String },
    #[error("forbidden: {reason}")]
    Forbidden { reason: String },
    #[error("invalid archive upload")]
    InvalidUpload { reason: String },
    #[error("archive enrollment request is invalid")]
    InvalidEnrollmentRequest,
    #[error("archive history choice conflicts with existing consent")]
    ConsentConflict,
    #[error("archive upload too large")]
    UploadTooLarge { reason: String },
    #[error("archive upload rejected")]
    UploadRejected { status: u16, reason: String },
    #[error("archive unavailable")]
    Unavailable { reason: String },
    #[error("invalid archive acknowledgement")]
    InvalidAcknowledgement,
    #[error("invalid archive policy")]
    InvalidPolicy,
    #[error("transport error")]
    Transport(#[from] anyhow::Error),
}

impl ArchiveClientError {
    pub fn class(&self) -> &'static str {
        match self {
            Self::Unauthorized { .. } => "unauthorized",
            Self::Forbidden { .. } => "forbidden",
            Self::InvalidUpload { reason }
                if reason == "unsupported_archive_upload_wire_version" =>
            {
                "archive_wire_unsupported"
            }
            Self::InvalidUpload { reason } if reason == "archive_element_exceeds_chunk_limit" => {
                "archive_record_too_large"
            }
            Self::InvalidUpload { .. } => "invalid_upload",
            Self::InvalidEnrollmentRequest => "invalid_request",
            Self::ConsentConflict => "consent_conflict",
            Self::UploadTooLarge { reason } if reason == "archive_element_exceeds_chunk_limit" => {
                "archive_record_too_large"
            }
            Self::UploadTooLarge { .. } => "upload_too_large",
            Self::UploadRejected { .. } => "upload_rejected",
            Self::Unavailable { .. } => "archive_unavailable",
            Self::InvalidAcknowledgement => "invalid_acknowledgement",
            Self::InvalidPolicy => "invalid_policy",
            Self::Transport(_) => "transport",
        }
    }

    pub fn denial_reason(&self) -> Option<&str> {
        match self {
            Self::Unauthorized { reason } | Self::Forbidden { reason } => Some(reason.as_str()),
            _ => None,
        }
    }

    pub fn http_status(&self) -> Option<u16> {
        match self {
            Self::Unauthorized { .. } => Some(401),
            Self::Forbidden { .. } => Some(403),
            Self::InvalidUpload { .. } | Self::InvalidEnrollmentRequest => Some(400),
            Self::ConsentConflict => Some(409),
            Self::UploadTooLarge { .. } => Some(413),
            Self::Unavailable { .. } => Some(503),
            Self::UploadRejected { status, .. } => Some(*status),
            Self::InvalidAcknowledgement | Self::InvalidPolicy | Self::Transport(_) => None,
        }
    }

    pub fn safe_reason(&self) -> Option<&str> {
        match self {
            Self::Unauthorized { reason }
            | Self::Forbidden { reason }
            | Self::InvalidUpload { reason }
            | Self::UploadTooLarge { reason }
            | Self::UploadRejected { reason, .. }
            | Self::Unavailable { reason } => Some(reason),
            _ => None,
        }
    }
}
