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

use collector_contracts::envelope::AgentIngestFacts;
use collector_contracts::facts::{
    AgentCapabilitySnapshotFact, AgentFileEventFact, AgentMessageFact, AgentPullRequestLinkFact,
    AgentToolEventFact,
};
use collector_contracts::AgentSource;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

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
) WITHOUT ROWID;
-- The SQLite-source (Cursor) watermark. A Cursor sync unit is one *composer* (session) inside the
-- single `state.vscdb`, not a file, so its cursor can't be a `file_cursors` row: there is no
-- byte_offset or head-hash, and the change signal is the composer's bubble count + newest bubble
-- timestamp (the DB analog of size + mtime). Separate table so neither cursor shape carries the
-- other's empty columns; same `(org_id, source, …)` org-isolation and advance-only-after-2xx
-- discipline as `file_cursors`.
CREATE TABLE IF NOT EXISTS composer_cursors (
    org_id         TEXT    NOT NULL,
    source         TEXT    NOT NULL,
    composer_id    TEXT    NOT NULL,
    bubble_count   INTEGER NOT NULL,
    max_created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, source, composer_id)
) WITHOUT ROWID;
-- Stable fact-level send state. File/composer cursors say a local source unit was accepted; this table
-- says which logical facts inside that unit were already accepted, so a whole-file reparse can upload
-- only new or changed facts. The ingest Worker still owns canonical at-rest IDs; these identities
-- mirror its deterministic input parts for local filtering only.
CREATE TABLE IF NOT EXISTS fact_cursors (
    org_id       TEXT NOT NULL,
    source       TEXT NOT NULL,
    category     TEXT NOT NULL,
    fact_identity TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (org_id, source, category, fact_identity)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cursor_meta (
    org_id TEXT NOT NULL,
    key    TEXT NOT NULL,
    value  TEXT NOT NULL,
    PRIMARY KEY (org_id, key)
) WITHOUT ROWID;";

const META_REPLAY_BACKFILL_NEEDED: &str = "replay_backfill_needed";
const META_LEGACY_CURSOR_REPAIR_DONE: &str = "legacy_cursor_repair_done";

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

/// How far one Cursor composer (session) has been ingested. The two fields the reader compares to
/// decide whether a composer gained or changed bubbles since the last successful upload — the
/// SQLite-source analog of [`FileCursor`]'s size + mtime + head-hash.
#[derive(Debug, Clone, PartialEq)]
pub struct ComposerCursor {
    /// The `composerData:` id. Local-only join key; the upload uses it as the vendor session id.
    pub composer_id: String,
    /// Bubbles ingested so far. Catches an in-place bubble edit that keeps the newest timestamp
    /// fixed. Signed `INTEGER` (rusqlite `i64`) — a composer never has a negative count, but the
    /// column is shared with the timestamp's range discipline.
    pub bubble_count: i64,
    /// Newest bubble `createdAt` (epoch ms) ingested so far. Catches appended bubbles that leave
    /// the count unchanged (a re-send that replaced one bubble with another).
    pub max_created_at: i64,
}

/// One fact the collector has successfully uploaded, keyed by the same stable identity inputs the
/// ingest Worker later hashes into the at-rest `*_pk`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactCursor {
    pub category: &'static str,
    pub fact_identity: String,
    pub content_hash: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CursorStoreError {
    /// Wraps every SQLite failure, including a `byte_offset` past `i64::MAX` on write or a negative
    /// stored offset on read — rusqlite's `u64` mapping surfaces both as range errors here.
    #[error("cursor store sqlite error")]
    Sqlite(#[from] rusqlite::Error),
    #[error("cursor store serialization error")]
    Serialize(#[from] serde_json::Error),
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

    /// Repair legacy cursor DBs that have unit-level cursors but no fact-level send state. That shape
    /// can falsely skip local files after reconnecting or upgrading, so clear the unit cursors and ask
    /// the embedder to keep running the normal history window until a clean pass completes.
    pub fn repair_legacy_cursors_without_fact_state(&self) -> Result<bool, CursorStoreError> {
        if self
            .get_meta(META_LEGACY_CURSOR_REPAIR_DONE)?
            .as_deref()
            .is_some_and(|value| value == "1")
        {
            return Ok(false);
        }
        if self.needs_replay_backfill()? {
            return Ok(false);
        }
        let fact_count = self.count_rows("fact_cursors")?;
        let unit_count = self.count_rows("file_cursors")? + self.count_rows("composer_cursors")?;
        if fact_count > 0 || unit_count == 0 {
            return Ok(false);
        }

        self.conn.execute(
            "DELETE FROM file_cursors WHERE org_id = ?1",
            params![self.org_id],
        )?;
        self.conn.execute(
            "DELETE FROM composer_cursors WHERE org_id = ?1",
            params![self.org_id],
        )?;
        self.set_meta(META_REPLAY_BACKFILL_NEEDED, "1")?;
        Ok(true)
    }

    pub fn needs_replay_backfill(&self) -> Result<bool, CursorStoreError> {
        Ok(self
            .get_meta(META_REPLAY_BACKFILL_NEEDED)?
            .as_deref()
            .is_some_and(|value| value == "1"))
    }

    pub fn mark_replay_backfill_complete(&self) -> Result<(), CursorStoreError> {
        self.set_meta(META_LEGACY_CURSOR_REPAIR_DONE, "1")?;
        self.conn.execute(
            "DELETE FROM cursor_meta WHERE org_id = ?1 AND key = ?2",
            params![self.org_id, META_REPLAY_BACKFILL_NEEDED],
        )?;
        Ok(())
    }

    fn count_rows(&self, table: &str) -> Result<i64, CursorStoreError> {
        let sql = format!("SELECT COUNT(*) FROM {table} WHERE org_id = ?1");
        Ok(self
            .conn
            .query_row(&sql, params![self.org_id], |row| row.get(0))?)
    }

    fn get_meta(&self, key: &str) -> Result<Option<String>, CursorStoreError> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT value FROM cursor_meta WHERE org_id = ?1 AND key = ?2")?;
        Ok(stmt
            .query_row(params![self.org_id, key], |row| row.get(0))
            .optional()?)
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<(), CursorStoreError> {
        self.conn.execute(
            "INSERT INTO cursor_meta (org_id, key, value) VALUES (?1, ?2, ?3) \
             ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value",
            params![self.org_id, key, value],
        )?;
        Ok(())
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

    /// The cursor for one composer, or `None` if it has never been ingested under this org + source.
    pub fn get_composer(
        &self,
        source: AgentSource,
        composer_id: &str,
    ) -> Result<Option<ComposerCursor>, CursorStoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT bubble_count, max_created_at FROM composer_cursors \
             WHERE org_id = ?1 AND source = ?2 AND composer_id = ?3",
        )?;
        let cursor = stmt
            .query_row(
                params![self.org_id, source_key(source), composer_id],
                |row| {
                    Ok(ComposerCursor {
                        composer_id: composer_id.to_string(),
                        bubble_count: row.get(0)?,
                        max_created_at: row.get(1)?,
                    })
                },
            )
            .optional()?;
        Ok(cursor)
    }

    /// Every composer cursor for one source under this org, ordered by composer id. Seeds the
    /// reader's changed-check so it can decide per composer without a per-row DB round-trip.
    pub fn list_composers(
        &self,
        source: AgentSource,
    ) -> Result<Vec<ComposerCursor>, CursorStoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT composer_id, bubble_count, max_created_at FROM composer_cursors \
             WHERE org_id = ?1 AND source = ?2 ORDER BY composer_id",
        )?;
        let rows = stmt.query_map(params![self.org_id, source_key(source)], |row| {
            Ok(ComposerCursor {
                composer_id: row.get(0)?,
                bubble_count: row.get(1)?,
                max_created_at: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Commit a composer's progress. **Call only after a successful (2xx) ingest** of the envelope
    /// carrying that composer's facts. Upserts on `(org_id, source, composer_id)`.
    pub fn advance_composer(
        &self,
        source: AgentSource,
        cursor: &ComposerCursor,
    ) -> Result<(), CursorStoreError> {
        self.conn.execute(
            "INSERT INTO composer_cursors \
                (org_id, source, composer_id, bubble_count, max_created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(org_id, source, composer_id) DO UPDATE SET \
                bubble_count = excluded.bubble_count, \
                max_created_at = excluded.max_created_at",
            params![
                self.org_id,
                source_key(source),
                cursor.composer_id,
                cursor.bubble_count,
                cursor.max_created_at,
            ],
        )?;
        Ok(())
    }

    /// Drop facts whose latest accepted content hash is already recorded locally. The returned
    /// `FactCursor`s must be committed only after the envelope carrying those facts returns `2xx`.
    pub fn filter_unsent_facts(
        &self,
        source: AgentSource,
        facts: AgentIngestFacts,
    ) -> Result<(AgentIngestFacts, Vec<FactCursor>), CursorStoreError> {
        let mut sent = Vec::new();
        let messages = self.filter_category(source, facts.messages, message_cursor, &mut sent)?;
        let tool_events =
            self.filter_category(source, facts.tool_events, tool_event_cursor, &mut sent)?;
        let file_events =
            self.filter_category(source, facts.file_events, file_event_cursor, &mut sent)?;
        let capability_snapshots = self.filter_category(
            source,
            facts.capability_snapshots,
            capability_snapshot_cursor,
            &mut sent,
        )?;
        let pull_request_links = self.filter_category(
            source,
            facts.pull_request_links,
            pull_request_link_cursor,
            &mut sent,
        )?;

        Ok((
            AgentIngestFacts {
                messages,
                tool_events,
                file_events,
                capability_snapshots,
                pull_request_links,
            },
            sent,
        ))
    }

    fn filter_category<T>(
        &self,
        source: AgentSource,
        rows: Vec<T>,
        cursor: fn(AgentSource, &T) -> Result<FactCursor, CursorStoreError>,
        sent: &mut Vec<FactCursor>,
    ) -> Result<Vec<T>, CursorStoreError> {
        let mut kept = Vec::with_capacity(rows.len());
        for row in rows {
            let fact_cursor = cursor(source, &row)?;
            if self.is_fact_current(source, &fact_cursor)? {
                continue;
            }
            sent.push(fact_cursor);
            kept.push(row);
        }
        Ok(kept)
    }

    fn is_fact_current(
        &self,
        source: AgentSource,
        cursor: &FactCursor,
    ) -> Result<bool, CursorStoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT content_hash FROM fact_cursors \
             WHERE org_id = ?1 AND source = ?2 AND category = ?3 AND fact_identity = ?4",
        )?;
        let stored = stmt
            .query_row(
                params![
                    self.org_id,
                    source_key(source),
                    cursor.category,
                    cursor.fact_identity,
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(stored.as_deref() == Some(cursor.content_hash.as_str()))
    }

    /// Commit fact send state after the envelope carrying those facts was accepted.
    pub fn advance_facts(
        &self,
        source: AgentSource,
        cursors: &[FactCursor],
    ) -> Result<(), CursorStoreError> {
        let mut stmt = self.conn.prepare_cached(
            "INSERT INTO fact_cursors \
                (org_id, source, category, fact_identity, content_hash) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(org_id, source, category, fact_identity) DO UPDATE SET \
                content_hash = excluded.content_hash",
        )?;
        for cursor in cursors {
            stmt.execute(params![
                self.org_id,
                source_key(source),
                cursor.category,
                cursor.fact_identity,
                cursor.content_hash,
            ])?;
        }
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

fn message_cursor(
    source: AgentSource,
    fact: &AgentMessageFact,
) -> Result<FactCursor, CursorStoreError> {
    let message_identity = fact
        .vendor_message_id
        .clone()
        .unwrap_or_else(|| format!("turn:{}", fact.turn_index));
    Ok(FactCursor {
        category: "messages",
        fact_identity: identity([
            source_identity(source),
            fact.vendor_session_id.as_str(),
            message_identity.as_str(),
        ]),
        content_hash: content_hash(fact)?,
    })
}

fn tool_event_cursor(
    source: AgentSource,
    fact: &AgentToolEventFact,
) -> Result<FactCursor, CursorStoreError> {
    let tool_identity = fact.tool_use_id.clone().unwrap_or_else(|| {
        format!(
            "block:{}:{}",
            fact.vendor_message_id.as_deref().unwrap_or(""),
            fact.source_block_index
        )
    });
    Ok(FactCursor {
        category: "tool_events",
        fact_identity: identity([
            source_identity(source),
            fact.vendor_session_id.as_str(),
            tool_identity.as_str(),
        ]),
        content_hash: content_hash(fact)?,
    })
}

fn file_event_cursor(
    source: AgentSource,
    fact: &AgentFileEventFact,
) -> Result<FactCursor, CursorStoreError> {
    let operation = serde_json::to_string(&fact.operation)?;
    Ok(FactCursor {
        category: "file_events",
        fact_identity: identity([
            source_identity(source),
            fact.vendor_session_id.as_str(),
            fact.vendor_message_id.as_deref().unwrap_or(""),
            fact.normalized_repo_path.as_str(),
            operation.trim_matches('"'),
            &fact.source_block_index.to_string(),
        ]),
        content_hash: content_hash(fact)?,
    })
}

fn capability_snapshot_cursor(
    source: AgentSource,
    fact: &AgentCapabilitySnapshotFact,
) -> Result<FactCursor, CursorStoreError> {
    let snapshot_identity = fact
        .source_snapshot_id
        .clone()
        .unwrap_or_else(|| format!("turn:{}", fact.stable_turn_index));
    Ok(FactCursor {
        category: "capability_snapshots",
        fact_identity: identity([
            source_identity(source),
            fact.vendor_session_id.as_str(),
            snapshot_identity.as_str(),
        ]),
        content_hash: content_hash(fact)?,
    })
}

fn pull_request_link_cursor(
    source: AgentSource,
    fact: &AgentPullRequestLinkFact,
) -> Result<FactCursor, CursorStoreError> {
    let event_identity = fact
        .source_event_id
        .clone()
        .unwrap_or_else(|| format!("turn:{}", fact.stable_turn_index));
    Ok(FactCursor {
        category: "pull_request_links",
        fact_identity: identity([
            source_identity(source),
            fact.vendor_session_id.as_str(),
            event_identity.as_str(),
            fact.url.as_str(),
        ]),
        content_hash: content_hash(fact)?,
    })
}

fn source_identity(source: AgentSource) -> &'static str {
    match source {
        AgentSource::Claude => "claude",
        AgentSource::Codex => "codex",
        AgentSource::Cursor => "cursor",
    }
}

fn identity<'a>(parts: impl IntoIterator<Item = &'a str>) -> String {
    parts
        .into_iter()
        .map(|p| format!("{}:{p}", p.len()))
        .collect::<Vec<_>>()
        .join("|")
}

fn content_hash<T: serde::Serialize>(value: &T) -> Result<String, CursorStoreError> {
    let encoded = serde_json::to_vec(value)?;
    let digest = Sha256::digest(encoded);
    let mut out = String::with_capacity("sha256:".len() + digest.len() * 2);
    out.push_str("sha256:");
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    Ok(out)
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

    fn composer(id: &str, count: i64, max_created_at: i64) -> ComposerCursor {
        ComposerCursor {
            composer_id: id.to_string(),
            bubble_count: count,
            max_created_at,
        }
    }

    #[test]
    fn get_composer_is_none_before_any_advance() {
        let store = CursorStore::open_in_memory("org_1").unwrap();
        assert_eq!(
            store.get_composer(AgentSource::Cursor, "c-1").unwrap(),
            None
        );
    }

    #[test]
    fn advance_composer_then_get_round_trips() {
        let store = CursorStore::open_in_memory("org_1").unwrap();
        let c = composer("c-1", 10, 1_700_000_000_000);
        store.advance_composer(AgentSource::Cursor, &c).unwrap();
        assert_eq!(
            store.get_composer(AgentSource::Cursor, "c-1").unwrap(),
            Some(c)
        );
    }

    #[test]
    fn advance_composer_overwrites_the_prior_cursor() {
        // A composer that grew from 10 to 15 bubbles overwrites in place, never duplicates.
        let store = CursorStore::open_in_memory("org_1").unwrap();
        store
            .advance_composer(AgentSource::Cursor, &composer("c-1", 10, 1_000))
            .unwrap();
        let grown = composer("c-1", 15, 1_500);
        store.advance_composer(AgentSource::Cursor, &grown).unwrap();
        assert_eq!(
            store.get_composer(AgentSource::Cursor, "c-1").unwrap(),
            Some(grown)
        );
        assert_eq!(store.list_composers(AgentSource::Cursor).unwrap().len(), 1);
    }

    #[test]
    fn list_composers_is_ordered_and_org_isolated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cursors.db");
        {
            let store = CursorStore::open(&path, "org_a").unwrap();
            store
                .advance_composer(AgentSource::Cursor, &composer("c-2", 1, 2))
                .unwrap();
            store
                .advance_composer(AgentSource::Cursor, &composer("c-1", 1, 1))
                .unwrap();
            let ids: Vec<_> = store
                .list_composers(AgentSource::Cursor)
                .unwrap()
                .into_iter()
                .map(|c| c.composer_id)
                .collect();
            assert_eq!(ids, vec!["c-1", "c-2"]); // ordered by composer id
        }
        // A second org on the same DB sees none of org_a's composer cursors.
        let org_b = CursorStore::open(&path, "org_b").unwrap();
        assert_eq!(org_b.list_composers(AgentSource::Cursor).unwrap(), vec![]);
    }

    #[test]
    fn a_large_composer_watermark_round_trips() {
        // 123k+ bubbles and ms-epoch timestamps both stay well inside i64.
        let store = CursorStore::open_in_memory("org_1").unwrap();
        let big = composer("c-big", 123_790, 1_716_000_000_000);
        store.advance_composer(AgentSource::Cursor, &big).unwrap();
        assert_eq!(
            store.get_composer(AgentSource::Cursor, "c-big").unwrap(),
            Some(big)
        );
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

    #[test]
    fn repair_legacy_cursors_clears_unit_cursors_and_marks_replay() {
        let store = CursorStore::open_in_memory("org_1").unwrap();
        store
            .advance(AgentSource::Claude, &cursor("/a.jsonl", 10))
            .unwrap();
        store
            .advance_composer(AgentSource::Cursor, &composer("c-1", 2, 100))
            .unwrap();

        assert!(store.repair_legacy_cursors_without_fact_state().unwrap());
        assert_eq!(store.list(AgentSource::Claude).unwrap(), vec![]);
        assert_eq!(store.list_composers(AgentSource::Cursor).unwrap(), vec![]);
        assert!(store.needs_replay_backfill().unwrap());

        store
            .advance(AgentSource::Claude, &cursor("/empty.jsonl", 20))
            .unwrap();
        assert!(!store.repair_legacy_cursors_without_fact_state().unwrap());
        assert_eq!(store.list(AgentSource::Claude).unwrap().len(), 1);

        store.mark_replay_backfill_complete().unwrap();
        assert!(!store.needs_replay_backfill().unwrap());

        store
            .advance(AgentSource::Claude, &cursor("/empty-2.jsonl", 30))
            .unwrap();
        assert!(!store.repair_legacy_cursors_without_fact_state().unwrap());
        assert_eq!(store.list(AgentSource::Claude).unwrap().len(), 2);
    }

    #[test]
    fn repair_legacy_cursors_keeps_unit_cursors_when_fact_state_exists() {
        let store = CursorStore::open_in_memory("org_1").unwrap();
        let c = cursor("/a.jsonl", 10);
        store.advance(AgentSource::Claude, &c).unwrap();
        store
            .conn
            .execute(
                "INSERT INTO fact_cursors \
                    (org_id, source, category, fact_identity, content_hash) \
                 VALUES ('org_1', 'claude', 'messages', 'm1', 'sha256:1')",
                [],
            )
            .unwrap();

        assert!(!store.repair_legacy_cursors_without_fact_state().unwrap());
        assert_eq!(store.list(AgentSource::Claude).unwrap(), vec![c]);
        assert!(!store.needs_replay_backfill().unwrap());
    }
}
