// SPDX-License-Identifier: Apache-2.0
// Trace Flow Desktop: local Archive enrollment + spool observation (TRA-222).

use anyhow::{Context, Result};
use std::path::Path;

use collector_archive_sync::{
    finish_terminal_cleanup, ArchiveEnrollmentRecord, ArchiveKeyStore, ArchivePolicy,
    ArchiveSourceConsentRecord, OsKeyStore, ARCHIVE_SPOOL_CAP_BYTES,
};

use crate::archive_control::ArchiveSourceConsent;
use crate::archive_flow::{ArchiveHistoryChoice, ArchiveSubmitResult};
use crate::connection::Paths;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalArchiveStatus {
    pub policy: ArchivePolicy,
    pub enrollment_id: Option<String>,
    pub activation_id: Option<String>,
    pub contribution_id: Option<String>,
    pub authorized_sources: Vec<ArchiveSourceConsentRecord>,
    pub spool_bytes: u64,
    pub spool_cap_bytes: u64,
    pub load_error: Option<String>,
}

pub fn local_archive_status(paths: &Paths, org_id: &str) -> LocalArchiveStatus {
    let enrollment_path = paths.archive_enrollment_file(org_id);
    let spool_dir = paths.archive_spool_dir(org_id);
    match ArchiveEnrollmentRecord::load_record(&enrollment_path) {
        Ok(record) => {
            let policy = record.policy().unwrap_or(ArchivePolicy::Inactive);
            let spool_bytes = dir_bytes(&spool_dir);
            LocalArchiveStatus {
                policy,
                enrollment_id: record.enrollment_id,
                activation_id: record.activation_id,
                contribution_id: record.contribution_id,
                authorized_sources: record.authorized_sources,
                spool_bytes,
                spool_cap_bytes: ARCHIVE_SPOOL_CAP_BYTES,
                load_error: None,
            }
        }
        Err(err) => LocalArchiveStatus {
            policy: ArchivePolicy::Inactive,
            enrollment_id: None,
            activation_id: None,
            contribution_id: None,
            authorized_sources: Vec::new(),
            spool_bytes: 0,
            spool_cap_bytes: ARCHIVE_SPOOL_CAP_BYTES,
            load_error: Some(err.to_string()),
        },
    }
}

pub fn persist_enrollment(
    paths: &Paths,
    org_id: &str,
    result: &ArchiveSubmitResult,
    sources: &[ArchiveSourceConsent],
) -> Result<()> {
    paths.ensure()?;
    let record = ArchiveEnrollmentRecord::with_consent(
        ArchivePolicy::Enrolled,
        result.enrollment_id.clone(),
        result.activation_id.clone(),
        result.contribution_id.clone(),
        sources
            .iter()
            .map(|source| ArchiveSourceConsentRecord {
                source: source.source.clone(),
                history_choice: source.history_choice.as_str().to_string(),
            })
            .collect(),
    );
    ArchiveEnrollmentRecord::save_record(&paths.archive_enrollment_file(org_id), &record)
        .context("persist archive enrollment")
}

pub fn persist_unenrolled_cleanup(
    paths: &Paths,
    org_id: &str,
    key_store: Option<&dyn ArchiveKeyStore>,
) -> Result<()> {
    paths.ensure()?;
    let enrollment_path = paths.archive_enrollment_file(org_id);
    let spool_dir = paths.archive_spool_dir(org_id);
    match key_store {
        Some(keys) => finish_terminal_cleanup(&spool_dir, org_id, keys, Some(&enrollment_path))
            .context("purge unacknowledged archive spool")?,
        None => {
            let keys = OsKeyStore;
            finish_terminal_cleanup(&spool_dir, org_id, &keys, Some(&enrollment_path))
                .context("purge unacknowledged archive spool")?;
        }
    }
    Ok(())
}

fn dir_bytes(root: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            total = total.saturating_add(dir_bytes(&path));
        } else if let Ok(meta) = entry.metadata() {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

pub fn source_consents(history: ArchiveHistoryChoice) -> Vec<ArchiveSourceConsent> {
    crate::archive_flow::consent_sources(history)
        .into_iter()
        .map(|(source, history_choice)| ArchiveSourceConsent {
            source,
            history_choice,
        })
        .collect()
}
