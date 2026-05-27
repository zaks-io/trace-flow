// SPDX-License-Identifier: MIT
// The cursor *record* (file path + mtime + byte offset + head hash) and the advance-only-after-a-
// successful-upload discipline are adapted from otto-sync's `CompletedFileCursor` (engine.rs,
// ~/src/otto, 2026-05-25). The SQLite persistence here is new Trace Flow code, not vendored: otto
// kept cursors server-side (it POSTed that record and read it back from the sync-start response),
// whereas Trace Flow Desktop keeps durable resumable cursor state in a local SQLite database (ADR
// "Local state"). Trace Flow owns the contract, IDs, pricing, redaction, and storage around this
// code.

//! The Collector's durable **per-source file cursor** store.
//!
//! A [`FileCursor`] records how far a single transcript file has been ingested: its `mtime_ms`,
//! `byte_offset`, and a `content_hash_head` the discovery pass compares against to skip unchanged
//! files. [`CursorStore`] persists those rows in SQLite, keyed by `(org_id, source, file_path)`.
//!
//! **Advance only after a 2xx.** [`CursorStore::advance`] is the post-success commit point: the POST
//! loop (a later 3b leaf) calls it only after the ingest Worker returns `Ok`. On failure it simply
//! does not advance, so the file is re-read next pass and server-side dedupe absorbs the repeat — the
//! store is resumable state, never a durable upload queue (ADR "SQLite is not a durable upload
//! queue").
//!
//! **Org isolation.** A store binds one `org_id` and every row carries it, so cursors are never
//! silently reused across Organizations (ADR "one active Organization in v1"); reconnecting to a
//! different org opens a store under that org_id and sees only its own rows. Absolute local paths may
//! live here for local-only lookup — they are never uploaded. Last-sync timestamps, Source
//! enablement, and job status are separate local state for later leaves.

use std::path::Path;

use collector_contracts::AgentSource;
use rusqlite::{params, Connection, OptionalExtension};

// WAL + `synchronous=NORMAL` is the standard durable-desktop pairing: readers never block the
// writer, and a crash can lose at most the last committed advance — harmless here, because a lost
// advance just re-reads the file next pass and server-side dedupe absorbs the repeat. On an
// in-memory DB SQLite ignores the journal pragma, so the same setup serves tests.
// `WITHOUT ROWID`: the composite PK is the only access path and no rowid is ever used, so folding
// the row into the PK b-tree drops a redundant index.
const MIGRATION: &str = "PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS file_cursors (
    org_id            TEXT    NOT NULL,
    source            TEXT    NOT NULL,
    file_path         TEXT    NOT NULL,
    mtime_ms          REAL    NOT NULL,
    byte_offset       INTEGER NOT NULL,
    content_hash_head TEXT    NOT NULL,
    PRIMARY KEY (org_id, source, file_path)
) WITHOUT ROWID;";

/// How far one transcript file has been ingested. The four fields the discovery pass needs to decide
/// whether a file is unchanged since the last successful upload.
#[derive(Debug, Clone, PartialEq)]
pub struct FileCursor {
    /// Absolute local path. Local-only — never uploaded (uploaded facts use IDs / redacted paths).
    pub file_path: String,
    /// Filesystem modified time in milliseconds. `f64` (not integer ms) because OS `mtimeMs` is
    /// genuinely fractional, and the discovery pass uses it as a coarse `>` fast-path before the
    /// head hash — truncating to integer ms would make every re-stat compare greater and defeat
    /// that skip. ms epochs stay below `2^53` (exact in `f64`) until ~year 2255, and no `==` is run.
    pub mtime_ms: f64,
    /// Bytes ingested so far. Stored in SQLite's signed `INTEGER`; rusqlite's `u64` mapping rejects
    /// a value past `i64::MAX` on write and a negative stored value on read, so a bad offset errors
    /// rather than silently wrapping.
    pub byte_offset: u64,
    /// Hash of the file's leading bytes, compared to detect in-place rewrites the size/mtime miss.
    pub content_hash_head: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CursorStoreError {
    /// Wraps every SQLite failure, including a `byte_offset` past `i64::MAX` on write or a negative
    /// stored offset on read — rusqlite's `u64` mapping surfaces both as range errors here.
    #[error("cursor store sqlite error")]
    Sqlite(#[from] rusqlite::Error),
}

/// Durable cursor store for one Organization. Open with [`CursorStore::open`] (or
/// [`CursorStore::open_in_memory`] for tests); read with [`get`](Self::get) / [`list`](Self::list)
/// and commit progress with [`advance`](Self::advance).
pub struct CursorStore {
    conn: Connection,
    org_id: String,
}

impl CursorStore {
    /// Open (creating if absent) the cursor DB at `path`, scoped to `org_id`.
    pub fn open(
        path: impl AsRef<Path>,
        org_id: impl Into<String>,
    ) -> Result<Self, CursorStoreError> {
        Self::init(Connection::open(path)?, org_id.into())
    }

    /// An ephemeral in-memory store. Used by tests and any embedder that wants a throwaway namespace.
    pub fn open_in_memory(org_id: impl Into<String>) -> Result<Self, CursorStoreError> {
        Self::init(Connection::open_in_memory()?, org_id.into())
    }

    fn init(conn: Connection, org_id: String) -> Result<Self, CursorStoreError> {
        conn.execute_batch(MIGRATION)?;
        Ok(Self { conn, org_id })
    }

    /// The cursor for one file, or `None` if it has never been ingested under this org + source.
    pub fn get(
        &self,
        source: AgentSource,
        file_path: &str,
    ) -> Result<Option<FileCursor>, CursorStoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT mtime_ms, byte_offset, content_hash_head FROM file_cursors \
             WHERE org_id = ?1 AND source = ?2 AND file_path = ?3",
        )?;
        let cursor = stmt
            .query_row(params![self.org_id, source_key(source), file_path], |row| {
                Ok(FileCursor {
                    file_path: file_path.to_string(),
                    mtime_ms: row.get(0)?,
                    byte_offset: row.get(1)?,
                    content_hash_head: row.get(2)?,
                })
            })
            .optional()?;
        Ok(cursor)
    }

    /// Every cursor for one source under this org, ordered by path. Seeds the discovery skip check.
    pub fn list(&self, source: AgentSource) -> Result<Vec<FileCursor>, CursorStoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT file_path, mtime_ms, byte_offset, content_hash_head FROM file_cursors \
             WHERE org_id = ?1 AND source = ?2 ORDER BY file_path",
        )?;
        let rows = stmt.query_map(params![self.org_id, source_key(source)], |row| {
            Ok(FileCursor {
                file_path: row.get(0)?,
                mtime_ms: row.get(1)?,
                byte_offset: row.get(2)?,
                content_hash_head: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Commit a file's progress. **Call only after a successful (2xx) ingest** — this is the point at
    /// which the cursor moves forward. Upserts on `(org_id, source, file_path)`.
    pub fn advance(
        &self,
        source: AgentSource,
        cursor: &FileCursor,
    ) -> Result<(), CursorStoreError> {
        self.conn.execute(
            "INSERT INTO file_cursors \
                (org_id, source, file_path, mtime_ms, byte_offset, content_hash_head) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(org_id, source, file_path) DO UPDATE SET \
                mtime_ms = excluded.mtime_ms, \
                byte_offset = excluded.byte_offset, \
                content_hash_head = excluded.content_hash_head",
            params![
                self.org_id,
                source_key(source),
                cursor.file_path,
                cursor.mtime_ms,
                cursor.byte_offset,
                cursor.content_hash_head,
            ],
        )?;
        Ok(())
    }
}

/// The source's internal DB key. It is a *persisted* key, deliberately decoupled from the serde wire
/// form — a future wire rename must not silently re-key and orphan stored rows. The exhaustive match
/// forces a fixed key to be chosen for any new source.
fn source_key(source: AgentSource) -> &'static str {
    match source {
        AgentSource::Claude => "claude",
        AgentSource::Codex => "codex",
        AgentSource::Cursor => "cursor",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cursor(path: &str, offset: u64) -> FileCursor {
        FileCursor {
            file_path: path.to_string(),
            mtime_ms: 1_716_000_000_000.0,
            byte_offset: offset,
            content_hash_head: format!("sha256:{offset}"),
        }
    }

    #[test]
    fn get_is_none_before_any_advance() {
        let store = CursorStore::open_in_memory("org_1").unwrap();
        assert_eq!(store.get(AgentSource::Claude, "/a.jsonl").unwrap(), None);
    }

    #[test]
    fn advance_then_get_round_trips() {
        let store = CursorStore::open_in_memory("org_1").unwrap();
        let c = cursor("/a.jsonl", 4096);
        store.advance(AgentSource::Claude, &c).unwrap();
        assert_eq!(store.get(AgentSource::Claude, "/a.jsonl").unwrap(), Some(c));
    }

    #[test]
    fn advance_overwrites_the_prior_cursor() {
        let store = CursorStore::open_in_memory("org_1").unwrap();
        store
            .advance(AgentSource::Codex, &cursor("/a.jsonl", 10))
            .unwrap();
        let newer = cursor("/a.jsonl", 9001);
        store.advance(AgentSource::Codex, &newer).unwrap();
        assert_eq!(
            store.get(AgentSource::Codex, "/a.jsonl").unwrap(),
            Some(newer)
        );
        assert_eq!(store.list(AgentSource::Codex).unwrap().len(), 1);
    }

    #[test]
    fn list_returns_only_the_requested_source() {
        let store = CursorStore::open_in_memory("org_1").unwrap();
        store
            .advance(AgentSource::Claude, &cursor("/c.jsonl", 1))
            .unwrap();
        store
            .advance(AgentSource::Claude, &cursor("/a.jsonl", 2))
            .unwrap();
        store
            .advance(AgentSource::Codex, &cursor("/b.jsonl", 3))
            .unwrap();
        let claude: Vec<_> = store
            .list(AgentSource::Claude)
            .unwrap()
            .into_iter()
            .map(|c| c.file_path)
            .collect();
        assert_eq!(claude, vec!["/a.jsonl", "/c.jsonl"]); // ordered by path
        assert_eq!(store.list(AgentSource::Cursor).unwrap(), vec![]);
    }

    #[test]
    fn a_large_byte_offset_round_trips() {
        // Past i32::MAX: the 3.5 GB Cursor store is a real corpus size, so the i64 column matters.
        let store = CursorStore::open_in_memory("org_1").unwrap();
        let big = cursor("/big.vscdb", 5_000_000_000);
        store.advance(AgentSource::Cursor, &big).unwrap();
        assert_eq!(
            store.get(AgentSource::Cursor, "/big.vscdb").unwrap(),
            Some(big)
        );
    }

    #[test]
    fn an_overflowing_offset_is_rejected_on_write_not_wrapped() {
        // > i64::MAX has no signed-INTEGER representation; rusqlite's u64 mapping errors on write.
        let store = CursorStore::open_in_memory("org_1").unwrap();
        let bogus = cursor("/x.jsonl", u64::MAX);
        assert!(store.advance(AgentSource::Claude, &bogus).is_err());
    }

    #[test]
    fn a_negative_stored_offset_is_rejected_on_read_not_wrapped() {
        // A corrupt / hand-edited negative offset must surface an error, not wrap to a huge u64.
        let store = CursorStore::open_in_memory("org_1").unwrap();
        store
            .conn
            .execute(
                "INSERT INTO file_cursors \
                    (org_id, source, file_path, mtime_ms, byte_offset, content_hash_head) \
                 VALUES ('org_1', 'claude', '/bad.jsonl', 0.0, -1, '')",
                [],
            )
            .unwrap();
        assert!(store.get(AgentSource::Claude, "/bad.jsonl").is_err());
    }

    #[test]
    fn cursors_are_isolated_per_org() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cursors.db");
        CursorStore::open(&path, "org_a")
            .unwrap()
            .advance(AgentSource::Claude, &cursor("/a.jsonl", 7))
            .unwrap();
        // A second org on the same file sees nothing of org_a's cursors.
        let org_b = CursorStore::open(&path, "org_b").unwrap();
        assert_eq!(org_b.get(AgentSource::Claude, "/a.jsonl").unwrap(), None);
        assert_eq!(org_b.list(AgentSource::Claude).unwrap(), vec![]);
    }

    #[test]
    fn cursors_persist_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cursors.db");
        let c = cursor("/a.jsonl", 2048);
        {
            let store = CursorStore::open(&path, "org_1").unwrap();
            store.advance(AgentSource::Claude, &c).unwrap();
        }
        let reopened = CursorStore::open(&path, "org_1").unwrap();
        assert_eq!(
            reopened.get(AgentSource::Claude, "/a.jsonl").unwrap(),
            Some(c)
        );
    }
}
