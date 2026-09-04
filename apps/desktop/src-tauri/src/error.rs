// SPDX-License-Identifier: Apache-2.0
// Trace Flow Desktop: error type. Adapted from otto-desktop's error.rs.

#[derive(Debug, thiserror::Error)]
pub enum DesktopError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl From<anyhow::Error> for DesktopError {
    fn from(err: anyhow::Error) -> Self {
        DesktopError::Message(format!("{err:#}"))
    }
}

impl serde::Serialize for DesktopError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, DesktopError>;
