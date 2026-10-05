// SPDX-License-Identifier: Apache-2.0
// Original Trace Flow code. Trace Flow owns the contract, IDs, pricing, redaction, and storage around
// this code.

//! Local quarantine for sync units the ingest Worker rejects on their own with a `400`.
//!
//! A `400` is deterministic for the same envelope, so re-sending a poisoned unit every cycle only
//! keeps the pass from ever completing (and the incremental watermark from ever moving). A quarantined
//! unit is skipped until its fingerprint changes (the transcript was edited or appended) or the parser
//! version changes, either of which can produce a different envelope worth trying again. Its cursor is
//! never advanced, so nothing is marked as accepted that the Worker did not accept.

use collector_contracts::AgentSource;
use rusqlite::{params, OptionalExtension};

use crate::cursor::{source_key, CursorStore, CursorStoreError};
use crate::sync_cycle::UnitCursor;

/// The stable local key and the content fingerprint of a unit. Files key on their path and
/// fingerprint on mtime + size (bit-exact mtime, so a fractional `mtimeMs` round-trips); Cursor
/// composers key on their id and fingerprint on the content their watermark records.
fn unit_identity(cursor: &UnitCursor) -> (String, String) {
    match cursor {
        UnitCursor::File(file) => (
            file.file_path.clone(),
            format!("file:{}:{}", file.mtime_ms.to_bits(), file.byte_offset),
        ),
        UnitCursor::Composer(composer) => (
            format!("composer:{}", composer.composer_id),
            format!(
                "composer:{}:{}:{}",
                composer.bubble_count,
                composer.max_created_at,
                composer.content_hash.as_deref().unwrap_or("")
            ),
        ),
    }
}

impl CursorStore {
    fn active_parser(&self) -> &str {
        self.active_parser_version.as_deref().unwrap_or("")
    }

    /// Record that `cursor`'s unit is rejected as-is under the active parser version.
    pub fn quarantine_unit(
        &self,
        source: AgentSource,
        cursor: &UnitCursor,
    ) -> Result<(), CursorStoreError> {
        let (key, fingerprint) = unit_identity(cursor);
        self.conn.execute(
            "INSERT INTO quarantined_units (org_id, source, unit_key, fingerprint, parser_version) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(org_id, source, unit_key) DO UPDATE SET \
                fingerprint = excluded.fingerprint, parser_version = excluded.parser_version",
            params![
                self.org_id,
                source_key(source),
                key,
                fingerprint,
                self.active_parser()
            ],
        )?;
        Ok(())
    }

    /// True while the unit's fingerprint and the parser version both match its quarantine record.
    pub fn is_quarantined(
        &self,
        source: AgentSource,
        cursor: &UnitCursor,
    ) -> Result<bool, CursorStoreError> {
        let (key, fingerprint) = unit_identity(cursor);
        let stored: Option<(String, String)> = self
            .conn
            .prepare_cached(
                "SELECT fingerprint, parser_version FROM quarantined_units \
                 WHERE org_id = ?1 AND source = ?2 AND unit_key = ?3",
            )?
            .query_row(params![self.org_id, source_key(source), key], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?;
        Ok(stored.is_some_and(|(stored_fingerprint, version)| {
            stored_fingerprint == fingerprint && version == self.active_parser()
        }))
    }

    /// Drop the unit's quarantine record once a later version of it is accepted.
    pub(crate) fn clear_quarantine(
        &self,
        source: AgentSource,
        cursor: &UnitCursor,
    ) -> Result<(), CursorStoreError> {
        let (key, _) = unit_identity(cursor);
        self.conn
            .prepare_cached(
                "DELETE FROM quarantined_units WHERE org_id = ?1 AND source = ?2 AND unit_key = ?3",
            )?
            .execute(params![self.org_id, source_key(source), key])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor::FileCursor;

    fn file(mtime_ms: f64, size: u64) -> UnitCursor {
        UnitCursor::File(FileCursor {
            file_path: "/t/a.jsonl".to_string(),
            mtime_ms,
            byte_offset: size,
            content_hash_head: "h".to_string(),
        })
    }

    #[test]
    fn quarantine_matches_only_the_same_file_state_and_parser_version() {
        let mut store = CursorStore::open_in_memory("org").unwrap();
        store.set_active_parser_version("0.3.0");
        let source = AgentSource::Claude;
        store.quarantine_unit(source, &file(10.5, 100)).unwrap();

        assert!(store.is_quarantined(source, &file(10.5, 100)).unwrap());
        assert!(!store.is_quarantined(source, &file(11.0, 100)).unwrap());
        assert!(!store.is_quarantined(source, &file(10.5, 101)).unwrap());
        assert!(!store
            .is_quarantined(AgentSource::Codex, &file(10.5, 100))
            .unwrap());

        store.set_active_parser_version("0.4.0");
        assert!(!store.is_quarantined(source, &file(10.5, 100)).unwrap());
    }

    #[test]
    fn clearing_releases_the_unit() {
        let store = CursorStore::open_in_memory("org").unwrap();
        let source = AgentSource::Claude;
        store.quarantine_unit(source, &file(1.0, 1)).unwrap();
        store.clear_quarantine(source, &file(2.0, 2)).unwrap();
        assert!(!store.is_quarantined(source, &file(1.0, 1)).unwrap());
    }

    #[test]
    fn quarantine_is_org_scoped() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("cursor.db");
        let a = CursorStore::open(&path, "org-a").unwrap();
        a.quarantine_unit(AgentSource::Claude, &file(1.0, 1))
            .unwrap();
        let b = CursorStore::open(&path, "org-b").unwrap();
        assert!(!b
            .is_quarantined(AgentSource::Claude, &file(1.0, 1))
            .unwrap());
    }
}
