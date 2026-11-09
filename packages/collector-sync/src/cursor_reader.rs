// SPDX-License-Identifier: Apache-2.0
// Original Trace Flow code (otto read Cursor's legacy `~/.cursor/projects` JSONL; this targets the
// current `state.vscdb` SQLite store). The SQLite-source analog of `discovery` + `assemble_units`: it
// snapshots the DB read-only, GLOB-scans composers + bubbles, and assembles one `SyncUnit` per composer
// for the same drive loop the JSONL path feeds. Trace Flow owns the contract, IDs, pricing, redaction,
// and storage around this code.

//! Cursor `state.vscdb` reader: discovery + assembly for the SQLite source.
//!
//! Cursor is one multi-GB SQLite DB, not a `.jsonl` corpus, so it can't ride the file walker. This module
//! is its adapter: [`assemble_cursor_units`] snapshots the live DB read-only, lists every `composerData:`
//! session, decides which changed since their stored [`ComposerCursor`], and assembles each into the same
//! [`SyncUnit`] the drive loop POSTs — so `run_sync_cycle` (batching, POST, advance-only-after-2xx) is
//! reused unchanged. The unit's `next_cursor` is a [`UnitCursor::Composer`] watermark, not a file cursor.
//!
//! **Snapshot safety (ADR).** The live DB is opened read-only and every query runs inside one read
//! transaction, so the pass sees a single committed state, including committed WAL frames, and never
//! writes, checkpoints, or copies the database or its WAL. Materializing a copy instead
//! (`VACUUM INTO`) rewrote the whole multi-GB DB every cycle, most of it `agentKv:` rows this reader
//! never selects.
//!
//! **`GLOB`, never `LIKE` (ADR).** `LIKE` is case-insensitive by default, which disables the `key` index
//! and forces a full multi-GB scan. Every key scan here is a `GLOB` prefix (`composerData:*`,
//! `bubbleId:<id>:*`) so the index is used; the composer id is GLOB-escaped before interpolation.
//!
//! **Whole-composer read, delta fact send.** A deterministic hash of normalized bubble content detects
//! composer changes, including edits that retain their count and timestamps. A changed composer is
//! re-assembled in full so session-level parsing stays correct; the sync cycle sends only new or changed
//! fact hashes, and the server-side fact ledger blocks repeat physical Tinybird inserts.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use collector_contracts::AgentSource;
use collector_parser::cursor_session::{cursor_repo_hint, cursor_session_fields};
use collector_parser::session_context::SessionContext;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

use crate::cursor::{content_hash, ComposerCursor, CursorStore, CursorStoreError};
use crate::git_remote::normalize_git_remote;
use crate::import::ImportWindow;
use crate::sync_cycle::{SyncUnit, UnitCursor};

/// A failure reading a Cursor `state.vscdb`: opening or querying it (`Sqlite`), or persisting/loading the
/// per-composer watermark (`Store`). A malformed or skippable bubble is never an error; only an unusable
/// DB or a broken cursor store is.
#[derive(Debug, thiserror::Error)]
pub enum CursorReadError {
    #[error("cursor snapshot sqlite error")]
    Sqlite(#[from] rusqlite::Error),
    #[error("cursor cursor-store error")]
    Store(#[from] CursorStoreError),
}

/// Opening the snapshot can briefly contend with Cursor for a lock, such as during WAL recovery or a
/// checkpoint that restarts the log. Wait it out instead of failing the whole sync pass.
const LIVE_DB_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// A read-only, point-in-time view of a live Cursor `state.vscdb`. The connection holds one read
/// transaction from [`open`](Self::open) until drop, so every query sees the same committed state.
/// Cursor keeps its store in WAL mode, where an open reader never blocks its commits but does keep
/// checkpoints from recycling the log, so drop the snapshot before any upload or other slow work.
pub struct CursorSnapshot {
    conn: Connection,
}

impl CursorSnapshot {
    /// Open the live DB read-only and pin its current committed state for this pass.
    pub fn open(live_db: &Path) -> Result<Self, CursorReadError> {
        let conn = Connection::open_with_flags(live_db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        conn.busy_timeout(LIVE_DB_BUSY_TIMEOUT)?;
        // A deferred transaction pins its snapshot at the first read, so read once here.
        conn.execute_batch("BEGIN")?;
        conn.query_row("SELECT count(*) FROM sqlite_schema", [], |_| Ok(()))?;
        Ok(Self { conn })
    }

    #[cfg(test)]
    fn from_conn(conn: Connection) -> Self {
        Self { conn }
    }
}

/// The live DB's on-disk state: size and modification time of the main file and its WAL. Every commit
/// rewrites one of them, so an unchanged state means Cursor committed nothing in between.
///
/// # Errors
/// The I/O error if either file cannot be stat'ed. A missing WAL is a valid state, not an error.
pub fn cursor_db_state(live_db: &Path) -> std::io::Result<String> {
    let mut wal = live_db.as_os_str().to_os_string();
    wal.push("-wal");
    let wal_state = match file_state(Path::new(&wal)) {
        Ok(state) => state,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => "none".to_string(),
        Err(err) => return Err(err),
    };
    Ok(format!("main {} wal {wal_state}", file_state(live_db)?))
}

fn file_state(path: &Path) -> std::io::Result<String> {
    let meta = std::fs::metadata(path)?;
    let modified = meta
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    Ok(format!("{}@{}", meta.len(), modified.as_nanos()))
}

/// One composer's session header, from a `composerData:<id>` row.
#[derive(Debug, Clone, PartialEq)]
pub struct ComposerRow {
    pub composer_id: String,
    /// Raw `modelConfig.modelName` (server normalizes/prices); `None` when the composer named none.
    pub model_name: Option<String>,
    /// `createdAt` (epoch ms) — the session start instant, when present.
    pub created_at_ms: Option<i64>,
}

/// Escape GLOB metacharacters (`* ? [`) in a literal so an id that happens to contain one does not widen
/// the prefix scan to a multi-GB read. GLOB's only bracket escape is a character class, so each metachar
/// is wrapped in `[...]` (a one-character class that matches itself).
fn glob_escape(literal: &str) -> String {
    let mut out = String::with_capacity(literal.len());
    for ch in literal.chars() {
        match ch {
            '*' | '?' | '[' => {
                out.push('[');
                out.push(ch);
                out.push(']');
            }
            other => out.push(other),
        }
    }
    out
}

/// Read a `cursorDiskKV.value` cell as raw bytes regardless of its SQLite storage class. The column is
/// declared `BLOB`, but SQLite is dynamically typed and Cursor has written both BLOB and TEXT values over
/// time, so a fixed `get::<Vec<u8>>` (BLOB-only) or `get::<String>` (TEXT-only) errors on the other. We
/// take the dynamic `rusqlite::types::Value` and accept Blob/Text (UTF-8 bytes), mapping anything else to
/// empty so a stray NULL/number degrades to a skipped row rather than failing the whole scan.
fn value_bytes(row: &rusqlite::Row, idx: usize) -> rusqlite::Result<Vec<u8>> {
    use rusqlite::types::ValueRef;
    Ok(match row.get_ref(idx)? {
        ValueRef::Blob(b) => b.to_vec(),
        ValueRef::Text(t) => t.to_vec(),
        _ => Vec::new(),
    })
}

/// Parse a value cell's bytes as JSON, or `Null` when empty / not valid JSON.
fn value_json(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or(Value::Null)
}

/// List every composer represented by either a header or retained bubbles. Headerless composers keep
/// their real key-derived id and carry no invented model or start timestamp.
///
/// # Errors
/// [`CursorReadError::Sqlite`] if the prepared statement or row read fails. A row with an unreadable
/// value is skipped, not an error.
pub fn list_composers(snap: &CursorSnapshot) -> Result<Vec<ComposerRow>, CursorReadError> {
    let mut stmt = snap
        .conn
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key GLOB 'composerData:*'")?;
    let rows = stmt.query_map([], |row| {
        let key: String = row.get(0)?;
        let value = value_bytes(row, 1)?;
        Ok((key, value))
    })?;

    let mut composers = BTreeMap::new();
    for row in rows {
        let (key, value) = row?;
        // The id is the key suffix; the value JSON repeats it as `composerId`, but the key is canonical.
        let composer_id = key
            .strip_prefix("composerData:")
            .unwrap_or(&key)
            .to_string();
        let parsed: Value = value_json(&value);
        let model_name = parsed
            .get("modelConfig")
            .and_then(|m| m.get("modelName"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let created_at_ms = parsed.get("createdAt").and_then(Value::as_i64);
        composers.insert(
            composer_id.clone(),
            ComposerRow {
                composer_id,
                model_name,
                created_at_ms,
            },
        );
    }

    let mut bubble_keys = snap
        .conn
        .prepare("SELECT key FROM cursorDiskKV WHERE key GLOB 'bubbleId:*'")?;
    let rows = bubble_keys.query_map([], |row| row.get::<_, String>(0))?;
    for row in rows {
        let key = row?;
        let Some((composer_id, _bubble_id)) = key
            .strip_prefix("bubbleId:")
            .and_then(|suffix| suffix.split_once(':'))
        else {
            continue;
        };
        if composer_id.is_empty() {
            continue;
        }
        composers
            .entry(composer_id.to_string())
            .or_insert_with(|| ComposerRow {
                composer_id: composer_id.to_string(),
                model_name: None,
                created_at_ms: None,
            });
    }
    Ok(composers.into_values().collect())
}

/// Read every bubble for one composer, ordered by `(createdAt, bubbleId)`, normalized into the records
/// the Cursor emitters consume: the raw bubble Value with the session's `__composer_id` and `__model`
/// stamped on (the bubble body carries neither — the key holds the id, the composer holds the model).
fn read_bubbles(
    snap: &CursorSnapshot,
    composer: &ComposerRow,
) -> Result<Vec<Value>, CursorReadError> {
    let pattern = format!("bubbleId:{}:*", glob_escape(&composer.composer_id));
    let mut stmt = snap
        .conn
        .prepare("SELECT value FROM cursorDiskKV WHERE key GLOB ?1")?;
    let rows = stmt.query_map([&pattern], |row| value_bytes(row, 0))?;

    let mut bubbles: Vec<Value> = Vec::new();
    for row in rows {
        let value = row?;
        let mut bubble = value_json(&value);
        if bubble.is_null() {
            continue; // a NULL or malformed bubble is skipped, not fatal — the rest still syncs
        }
        if let Value::Object(map) = &mut bubble {
            map.insert("__composer_id".to_string(), json!(composer.composer_id));
            map.insert("__model".to_string(), json!(composer.model_name));
            if let Some(started) = composer.created_at_ms {
                map.insert("__started_at".to_string(), json!(started));
            }
            bubbles.push(bubble);
        }
    }

    fn bubble_id(v: &Value) -> &str {
        v.get("bubbleId")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }
    bubbles.sort_by(|a, b| {
        bubble_created_at_ms(a)
            .unwrap_or(i64::MIN)
            .cmp(&bubble_created_at_ms(b).unwrap_or(i64::MIN))
            .then_with(|| bubble_id(a).cmp(bubble_id(b)))
    });
    Ok(bubbles)
}

/// A bubble's `createdAt` as epoch ms, from either the ISO-8601 string Cursor writes today or a numeric
/// epoch (defensive against a future shape change). `None` when the bubble has no parseable timestamp.
fn bubble_created_at_ms(bubble: &Value) -> Option<i64> {
    let created = bubble.get("createdAt")?;
    created
        .as_str()
        .and_then(collector_parser::timestamp::rfc3339_to_epoch_ms)
        .or_else(|| created.as_i64())
}

/// The newest bubble `createdAt` (epoch ms) in a composer, or `None` for an empty/timestamp-less session.
fn max_bubble_created_at(bubbles: &[Value]) -> Option<i64> {
    bubbles.iter().filter_map(bubble_created_at_ms).max()
}

/// The change watermark for an assembled composer. Hash the ordered normalized bubbles after header
/// metadata injection so content edits and header changes are visible even when count and timestamps stay
/// fixed. Count and newest timestamp remain useful diagnostics and legacy change signals.
fn watermark(composer_id: &str, bubbles: &[Value]) -> Result<ComposerCursor, CursorStoreError> {
    Ok(ComposerCursor {
        composer_id: composer_id.to_string(),
        bubble_count: bubbles.len() as i64,
        max_created_at: max_bubble_created_at(bubbles).unwrap_or(0),
        content_hash: Some(content_hash(&bubbles)?),
    })
}

/// Whether `next` is new or differs from the stored watermark. A legacy cursor with no hash is always
/// changed so its first hash-aware pass reparses instead of trusting incomplete count/timestamp signals.
fn is_changed(stored: Option<&ComposerCursor>, next: &ComposerCursor) -> bool {
    match stored {
        None => true,
        Some(prev) => {
            prev.content_hash.is_none()
                || prev.content_hash != next.content_hash
                || prev.bubble_count != next.bubble_count
                || next.max_created_at != prev.max_created_at
        }
    }
}

/// Build the [`SessionContext`] every Cursor fact carries. Repo attribution is best-effort from the file
/// paths the session touched (no Cursor session `cwd`): the common prefix becomes the `relativize` anchor
/// and, when it parses as one, a normalized git remote. An empty anchor leaves every path collapsing to
/// `outside_repo` — the safe default that keeps a home dir/username out of a fact.
fn build_cursor_context(records: &[Value]) -> SessionContext {
    let fields = cursor_session_fields(records);
    let repo_root = cursor_repo_hint(records).unwrap_or_default();
    // The hint is a local filesystem path, not a git URL; treat its basename as the coarse repo label and
    // leave `normalized_git_remote` empty unless the path itself canonicalizes to a remote form.
    let normalized_git_remote = normalize_git_remote(&repo_root);
    let repo_path_fallback = basename(&repo_root).to_string();
    SessionContext {
        parent_vendor_session_id: String::new(),
        vendor_session_id: fields.vendor_session_id,
        // Resolved server-side from the connected credential; the headless collector has none.
        agent_id: String::new(),
        normalized_git_remote,
        repo_path_fallback,
        // Cursor records no branch at the session grain.
        git_branch: String::new(),
        git_head_sha: String::new(),
        vendor_started_at: fields.vendor_started_at,
        // Cursor sessions are single-agent.
        agent_depth: 0,
        repo_root,
    }
}

/// The last path component of `path`, or `""` (mirrors the JSONL `build_session_context` basename).
fn basename(path: &str) -> &str {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
}

/// Whether a session with these timestamps falls in `window`. Keyed on the session's most-recent
/// activity — the newer of its start and its newest bubble — not just its start. The JSONL sources filter
/// on file `mtime` (which advances on every edit), so a long-running session that *started* before the
/// window but is *still active* today must stay in scope; keying only on `createdAt` (start) would skip
/// it forever. A session with no timestamp at all is admitted (we can't prove it is out of window, and
/// dropping it would silently lose data).
fn in_window(window: ImportWindow, session_start: Option<i64>, max_bubble: Option<i64>) -> bool {
    match session_start.into_iter().chain(max_bubble).max() {
        Some(latest) => window.includes(latest as f64),
        None => true,
    }
}

/// Discover changed composers in the snapshot and assemble each into a [`SyncUnit`]. Previously unseen
/// composers must fall inside `window`. Known composers compare their hash regardless of `createdAt`,
/// which is a creation timestamp rather than a modification timestamp. Replay additionally selects known,
/// unchanged composers inside the requested window. Sync (no async): the reader does no git shell-out.
///
/// # Errors
/// [`CursorReadError`]: `Sqlite` if opening the snapshot or a query fails, `Store` if loading a
/// composer's stored watermark fails. A malformed bubble within a composer is skipped, not an error.
pub fn assemble_cursor_units(
    live_db: &Path,
    store: &CursorStore,
    window: ImportWindow,
    replay: bool,
) -> Result<Vec<SyncUnit>, CursorReadError> {
    let snap = CursorSnapshot::open(live_db)?;
    let mut units = Vec::new();
    for composer in list_composers(&snap)? {
        let records = read_bubbles(&snap, &composer)?;
        let in_window = in_window(
            window,
            composer.created_at_ms,
            max_bubble_created_at(&records),
        );
        let stored = store.get_composer(AgentSource::Cursor, &composer.composer_id)?;
        let next = watermark(&composer.composer_id, &records)?;
        let selected = match stored.as_ref() {
            None => in_window,
            Some(_) => is_changed(stored.as_ref(), &next) || (replay && in_window),
        };
        if !selected {
            continue;
        }
        let ctx = build_cursor_context(&records);
        units.push(SyncUnit {
            records,
            ctx,
            next_cursor: UnitCursor::Composer(next),
        });
    }
    Ok(units)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    /// An in-memory `cursorDiskKV` fixture.
    /// The real `cursorDiskKV` schema (`key TEXT UNIQUE …, value BLOB`); the `UNIQUE` index is what the
    /// GLOB prefix scan rides, so the fixture must carry it for the index-plan canary to be meaningful.
    const CREATE_KV: &str =
        "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB); \
         CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);";

    fn fixture(rows: &[(String, Value)]) -> CursorSnapshot {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_KV).unwrap();
        for (key, value) in rows {
            conn.execute(
                "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
                rusqlite::params![key, value.to_string()],
            )
            .unwrap();
        }
        CursorSnapshot::from_conn(conn)
    }

    fn composer_row(id: &str, model: &str, created_at: i64) -> (String, Value) {
        (
            format!("composerData:{id}"),
            json!({ "composerId": id, "modelConfig": { "modelName": model }, "createdAt": created_at }),
        )
    }

    fn bubble_row(composer: &str, bubble: &str, btype: i64, created_at: &str) -> (String, Value) {
        (
            format!("bubbleId:{composer}:{bubble}"),
            json!({ "bubbleId": bubble, "type": btype, "createdAt": created_at }),
        )
    }

    fn open_window() -> ImportWindow {
        ImportWindow::first_incremental(24 * 60 * 60 * 1000) // cutoff = 0, admits everything
    }

    #[test]
    fn glob_escape_wraps_metacharacters() {
        assert_eq!(glob_escape("a*b?c[d"), "a[*]b[?]c[[]d");
        assert_eq!(glob_escape("normal-uuid"), "normal-uuid");
    }

    #[test]
    fn the_bubble_query_uses_glob_and_the_key_index_never_like() {
        // The index-plan canary: a `GLOB` prefix must use the key index, not a full table scan. `LIKE`
        // here would be case-insensitive and force a SCAN over the whole multi-GB table.
        let snap = fixture(&[
            composer_row("c1", "gpt-5.2", 1_000),
            bubble_row("c1", "b1", 2, "2026-05-25T00:00:00.000Z"),
        ]);
        let plan: Vec<String> = snap
            .conn
            .prepare(
                "EXPLAIN QUERY PLAN SELECT value FROM cursorDiskKV WHERE key GLOB 'bubbleId:c1:*'",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let detail = plan.join(" ");
        // SQLite reports an index/prefix scan as SEARCH (vs SCAN for a full table read).
        assert!(detail.contains("SEARCH"), "plan was: {detail}");
        assert!(!detail.contains("SCAN cursorDiskKV"), "plan was: {detail}");
    }

    #[test]
    fn list_composers_reads_id_model_and_created_at() {
        let snap = fixture(&[
            composer_row("c1", "gpt-5.2-codex-high", 1_700_000_000_000),
            composer_row("c2", "default", 1_700_000_001_000),
        ]);
        let mut composers = list_composers(&snap).unwrap();
        composers.sort_by(|a, b| a.composer_id.cmp(&b.composer_id));
        assert_eq!(composers.len(), 2);
        assert_eq!(composers[0].composer_id, "c1");
        assert_eq!(
            composers[0].model_name.as_deref(),
            Some("gpt-5.2-codex-high")
        );
        assert_eq!(composers[0].created_at_ms, Some(1_700_000_000_000));
        assert_eq!(composers[1].model_name.as_deref(), Some("default"));
    }

    #[test]
    fn list_composers_retains_headerless_bubble_sessions_without_inventing_metadata() {
        let snap = fixture(&[bubble_row(
            "headerless",
            "b1",
            2,
            "2026-05-25T22:00:00.000Z",
        )]);
        let composers = list_composers(&snap).unwrap();
        assert_eq!(
            composers,
            vec![ComposerRow {
                composer_id: "headerless".to_string(),
                model_name: None,
                created_at_ms: None,
            }]
        );
        let records = read_bubbles(&snap, &composers[0]).unwrap();
        assert_eq!(records[0]["__composer_id"], json!("headerless"));
        assert!(records[0]["__model"].is_null());
        assert!(records[0].get("__started_at").is_none());
        let ctx = build_cursor_context(&records);
        assert_eq!(ctx.vendor_session_id, "headerless");
        assert_eq!(ctx.vendor_started_at, None);
        assert!(ctx.repo_root.is_empty());
    }

    /// A live WAL-mode DB whose rows exist only in the un-checkpointed WAL, with its writer still open.
    fn wal_only_db(dir: &Path) -> (std::path::PathBuf, Connection) {
        let db_path = dir.join("state.vscdb");
        let schema = Connection::open(&db_path).unwrap();
        schema.execute_batch(CREATE_KV).unwrap();
        schema.close().unwrap();

        let writer = Connection::open(&db_path).unwrap();
        writer.pragma_update(None, "journal_mode", "WAL").unwrap();
        writer.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        let main_before_insert = fs::read(&db_path).unwrap();
        for (key, value) in [
            composer_row("wal-composer", "gpt-5.2", 1_700_000_000_000),
            bubble_row("wal-composer", "wal-bubble", 2, "2026-05-25T22:00:00.000Z"),
        ] {
            insert_row(&writer, &key, &value);
        }
        assert_eq!(fs::read(&db_path).unwrap(), main_before_insert);
        (db_path, writer)
    }

    fn insert_row(conn: &Connection, key: &str, value: &Value) {
        conn.execute(
            "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value.to_string()],
        )
        .unwrap();
    }

    fn dir_contents(dir: &Path) -> BTreeMap<String, Vec<u8>> {
        fs::read_dir(dir)
            .unwrap()
            .map(|entry| {
                let path = entry.unwrap().path();
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                (name, fs::read(&path).unwrap())
            })
            .collect()
    }

    #[test]
    fn snapshot_includes_committed_wal_rows_without_mutating_the_source() {
        let source_dir = tempfile::tempdir().unwrap();
        let (db_path, writer) = wal_only_db(source_dir.path());

        let wal_path = db_path.with_file_name("state.vscdb-wal");
        let main_before_snapshot = fs::read(&db_path).unwrap();
        let wal_before_snapshot = fs::read(&wal_path).unwrap();
        assert!(!wal_before_snapshot.is_empty());

        let snapshot = CursorSnapshot::open(&db_path).unwrap();
        let composers = list_composers(&snapshot).unwrap();
        assert_eq!(composers.len(), 1);
        assert_eq!(composers[0].composer_id, "wal-composer");
        let bubbles = read_bubbles(&snapshot, &composers[0]).unwrap();
        assert_eq!(bubbles.len(), 1);
        assert_eq!(bubbles[0]["bubbleId"], json!("wal-bubble"));

        assert_eq!(fs::read(&db_path).unwrap(), main_before_snapshot);
        assert_eq!(fs::read(&wal_path).unwrap(), wal_before_snapshot);
        let source_rows: i64 = writer
            .query_row("SELECT COUNT(*) FROM cursorDiskKV", [], |row| row.get(0))
            .unwrap();
        assert_eq!(source_rows, 2);
    }

    #[test]
    fn a_commit_after_the_snapshot_opens_is_invisible_until_the_next_pass() {
        let source_dir = tempfile::tempdir().unwrap();
        let (db_path, writer) = wal_only_db(source_dir.path());

        let snapshot = CursorSnapshot::open(&db_path).unwrap();
        let (late_key, late_value) = composer_row("late-composer", "gpt-5.2", 1_700_000_001_000);
        insert_row(&writer, &late_key, &late_value);

        let ids = |snap: &CursorSnapshot| -> Vec<String> {
            list_composers(snap)
                .unwrap()
                .into_iter()
                .map(|c| c.composer_id)
                .collect()
        };
        assert_eq!(ids(&snapshot), vec!["wal-composer"]);
        drop(snapshot);
        assert_eq!(
            ids(&CursorSnapshot::open(&db_path).unwrap()),
            vec!["late-composer", "wal-composer"]
        );
    }

    #[test]
    fn a_wal_only_commit_changes_the_db_state_though_the_main_file_does_not() {
        let source_dir = tempfile::tempdir().unwrap();
        let (db_path, writer) = wal_only_db(source_dir.path());
        let main_before = fs::read(&db_path).unwrap();
        let before = cursor_db_state(&db_path).unwrap();

        let (key, value) = composer_row("late-composer", "gpt-5.2", 1_700_000_001_000);
        insert_row(&writer, &key, &value);

        assert_eq!(fs::read(&db_path).unwrap(), main_before);
        assert_ne!(cursor_db_state(&db_path).unwrap(), before);
    }

    #[test]
    fn a_wal_db_cursor_closed_cleanly_is_still_readable() {
        let source_dir = tempfile::tempdir().unwrap();
        let (db_path, writer) = wal_only_db(source_dir.path());
        writer.close().unwrap();
        assert!(!db_path.with_file_name("state.vscdb-wal").exists());

        let snapshot = CursorSnapshot::open(&db_path).unwrap();
        assert_eq!(list_composers(&snapshot).unwrap().len(), 1);
    }

    #[test]
    fn a_rollback_journal_snapshot_writes_no_files_and_releases_cursor_on_drop() {
        let source_dir = tempfile::tempdir().unwrap();
        let db_path = source_dir.path().join("state.vscdb");
        write_db(
            &db_path,
            &[
                composer_row("c1", "gpt-5.2", 1_000),
                bubble_row("c1", "b1", 2, "2026-05-25T22:00:00.000Z"),
            ],
        );
        let before = dir_contents(source_dir.path());

        let snapshot = CursorSnapshot::open(&db_path).unwrap();
        let composers = list_composers(&snapshot).unwrap();
        assert_eq!(read_bubbles(&snapshot, &composers[0]).unwrap().len(), 1);
        assert_eq!(dir_contents(source_dir.path()), before);
        drop(snapshot);

        let (key, value) = composer_row("c2", "gpt-5.2", 2_000);
        insert_row(&Connection::open(&db_path).unwrap(), &key, &value);
    }

    #[test]
    fn read_bubbles_groups_by_composer_orders_by_created_at_and_stamps_session_fields() {
        let snap = fixture(&[
            composer_row("c1", "gpt-5.2", 1_000),
            bubble_row("c1", "b-late", 2, "2026-05-25T23:00:00.000Z"),
            bubble_row("c1", "b-early", 1, "2026-05-25T22:00:00.000Z"),
            // A different composer's bubble must not leak into c1's records.
            bubble_row("c2", "x", 2, "2026-05-25T22:30:00.000Z"),
        ]);
        let composer = ComposerRow {
            composer_id: "c1".to_string(),
            model_name: Some("gpt-5.2".to_string()),
            created_at_ms: Some(1_000),
        };
        let bubbles = read_bubbles(&snap, &composer).unwrap();
        assert_eq!(bubbles.len(), 2);
        // Ordered by createdAt: the 22:00 bubble first.
        assert_eq!(bubbles[0]["bubbleId"], json!("b-early"));
        assert_eq!(bubbles[1]["bubbleId"], json!("b-late"));
        // Reader-injected session fields are on every record.
        assert_eq!(bubbles[0]["__composer_id"], json!("c1"));
        assert_eq!(bubbles[0]["__model"], json!("gpt-5.2"));
        assert_eq!(bubbles[0]["__started_at"], json!(1_000));
    }

    #[test]
    fn read_bubbles_orders_numeric_epoch_created_at_chronologically() {
        // Defends the numeric-epoch shape `bubble_created_at_ms` already supports: a string-only sort key
        // would collapse every numeric `createdAt` to "" and fall back to bubbleId order, misordering turns.
        let numeric = |bubble: &str, created_at: i64| {
            (
                format!("bubbleId:c1:{bubble}"),
                json!({ "bubbleId": bubble, "type": 2, "createdAt": created_at }),
            )
        };
        let snap = fixture(&[
            composer_row("c1", "gpt-5.2", 1_000),
            // Insert out of order, with bubbleIds whose lexical order is the REVERSE of chronological.
            numeric("z-late", 1_700_000_002_000),
            numeric("a-early", 1_700_000_000_000),
            numeric("m-mid", 1_700_000_001_000),
        ]);
        let composer = ComposerRow {
            composer_id: "c1".to_string(),
            model_name: Some("gpt-5.2".to_string()),
            created_at_ms: Some(1_000),
        };
        let bubbles = read_bubbles(&snap, &composer).unwrap();
        let ids: Vec<&str> = bubbles
            .iter()
            .map(|b| b["bubbleId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["a-early", "m-mid", "z-late"]);
    }

    #[test]
    fn a_composer_with_no_bubbles_yields_empty_records() {
        let snap = fixture(&[composer_row("c1", "gpt-5.2", 1_000)]);
        let composer = ComposerRow {
            composer_id: "c1".to_string(),
            model_name: Some("gpt-5.2".to_string()),
            created_at_ms: Some(1_000),
        };
        assert!(read_bubbles(&snap, &composer).unwrap().is_empty());
    }

    #[test]
    fn in_window_keys_on_most_recent_activity_not_just_session_start() {
        // Window admits the last 24h ending at T. A session that STARTED 48h ago but whose newest bubble
        // is 1h ago is still active and must stay in scope — keying on start alone would skip it forever.
        const T: i64 = 1_779_840_000_000;
        const DAY: i64 = 24 * 60 * 60 * 1000;
        let window = ImportWindow::first_incremental(T); // cutoff = T - 24h
        let started_48h_ago = T - 2 * DAY;
        let bubble_1h_ago = T - 60 * 60 * 1000;
        assert!(in_window(
            window,
            Some(started_48h_ago),
            Some(bubble_1h_ago)
        ));
        // A session that both started and last spoke >24h ago is out of window.
        assert!(!in_window(window, Some(started_48h_ago), Some(T - 2 * DAY)));
        // No timestamps at all → admitted (can't prove it's out, dropping would lose data).
        assert!(in_window(window, None, None));
    }

    #[test]
    fn watermark_accepts_a_numeric_created_at() {
        // Defensive: today Cursor writes ISO strings, but a numeric epoch must not silently zero the
        // append-detection watermark.
        let bubbles = [
            json!({ "bubbleId": "b1", "createdAt": "2026-05-25T22:00:00.000Z" }),
            json!({ "bubbleId": "b2", "createdAt": 1_900_000_000_000i64 }),
        ];
        let w = watermark("c1", &bubbles).unwrap();
        assert_eq!(w.bubble_count, 2);
        assert_eq!(w.max_created_at, 1_900_000_000_000);
        assert!(w.content_hash.as_deref().unwrap().starts_with("sha256:"));
    }

    #[test]
    fn change_detection_includes_content_hash_and_forces_legacy_reparse() {
        let base = ComposerCursor {
            composer_id: "c1".to_string(),
            bubble_count: 10,
            max_created_at: 1_000,
            content_hash: Some("sha256:base".to_string()),
        };
        // Unchanged: same count and max.
        assert!(!is_changed(Some(&base), &base));
        // More bubbles.
        let grown = ComposerCursor {
            bubble_count: 12,
            ..base.clone()
        };
        assert!(is_changed(Some(&base), &grown));
        // Same count, newer bubble (an edit replaced one).
        let newer = ComposerCursor {
            max_created_at: 2_000,
            ..base.clone()
        };
        assert!(is_changed(Some(&base), &newer));
        // Same count and timestamp, edited content.
        let edited = ComposerCursor {
            content_hash: Some("sha256:edited".to_string()),
            ..base.clone()
        };
        assert!(is_changed(Some(&base), &edited));
        // Pre-migration cursors cannot prove content equality.
        let legacy = ComposerCursor {
            content_hash: None,
            ..base.clone()
        };
        assert!(is_changed(Some(&legacy), &base));
        // Never ingested.
        assert!(is_changed(None, &base));
    }

    #[test]
    fn watermark_hash_includes_injected_header_metadata() {
        let first = [json!({
            "bubbleId": "b1",
            "type": 2,
            "createdAt": "2026-05-25T22:00:00.000Z",
            "text": "same",
            "__composer_id": "c1",
            "__model": "model-a",
            "__started_at": 1_000
        })];
        let changed_header = [json!({
            "bubbleId": "b1",
            "type": 2,
            "createdAt": "2026-05-25T22:00:00.000Z",
            "text": "same",
            "__composer_id": "c1",
            "__model": "model-b",
            "__started_at": 1_000
        })];
        assert_ne!(
            watermark("c1", &first).unwrap().content_hash,
            watermark("c1", &changed_header).unwrap().content_hash
        );
    }

    #[test]
    fn assemble_skips_unchanged_and_emits_changed_composers() {
        let snap_rows = vec![
            composer_row("c1", "gpt-5.2", 1_700_000_000_000),
            bubble_row("c1", "b1", 1, "2026-05-25T22:00:00.000Z"),
            bubble_row("c1", "b2", 2, "2026-05-25T23:00:00.000Z"),
        ];
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("state.vscdb");
        // Materialize the fixture so assemble_cursor_units exercises the real snapshot path.
        write_db(&db_path, &snap_rows);

        let store = CursorStore::open_in_memory("org").unwrap();
        let units = assemble_cursor_units(&db_path, &store, open_window(), false).unwrap();
        assert_eq!(units.len(), 1);
        let UnitCursor::Composer(cursor) = &units[0].next_cursor else {
            panic!("cursor source assembles a composer cursor");
        };
        assert_eq!(cursor.composer_id, "c1");
        assert_eq!(cursor.bubble_count, 2);
        assert_eq!(units[0].records.len(), 2);

        // Advance the watermark and re-run: the unchanged composer is now skipped.
        store.advance_composer(AgentSource::Cursor, cursor).unwrap();
        let again = assemble_cursor_units(&db_path, &store, open_window(), false).unwrap();
        assert!(again.is_empty());

        let replayed = assemble_cursor_units(&db_path, &store, open_window(), true).unwrap();
        assert_eq!(replayed.len(), 1);
    }

    #[test]
    fn known_same_count_edits_bypass_the_creation_window_but_unknown_old_sessions_do_not() {
        let old = "2026-05-25T22:00:00.000Z";
        let rows = vec![
            composer_row("known", "gpt-5.2", 1_700_000_000_000),
            (
                "bubbleId:known:b1".to_string(),
                json!({ "bubbleId": "b1", "type": 2, "createdAt": old, "text": "before" }),
            ),
        ];
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("state.vscdb");
        write_db(&db_path, &rows);
        let store = CursorStore::open_in_memory("org").unwrap();
        let initial = assemble_cursor_units(&db_path, &store, open_window(), false)
            .unwrap()
            .pop()
            .unwrap();
        let UnitCursor::Composer(initial_cursor) = initial.next_cursor else {
            panic!("cursor source assembles a composer cursor");
        };
        store
            .advance_composer(AgentSource::Cursor, &initial_cursor)
            .unwrap();

        replace_row(
            &db_path,
            "bubbleId:known:b1",
            json!({ "bubbleId": "b1", "type": 2, "createdAt": old, "text": "after" }),
        );
        replace_row(
            &db_path,
            "composerData:unknown",
            json!({ "composerId": "unknown", "createdAt": 1_700_000_000_000i64 }),
        );
        replace_row(
            &db_path,
            "bubbleId:unknown:b1",
            json!({ "bubbleId": "b1", "type": 2, "createdAt": old, "text": "old" }),
        );

        let recent_window = ImportWindow::first_incremental(9_000_000_000_000);
        let selected = assemble_cursor_units(&db_path, &store, recent_window, false).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].ctx.vendor_session_id, "known");
        let UnitCursor::Composer(next) = &selected[0].next_cursor else {
            panic!("cursor source assembles a composer cursor");
        };
        assert_eq!(next.bubble_count, initial_cursor.bubble_count);
        assert_eq!(next.max_created_at, initial_cursor.max_created_at);
        assert_ne!(next.content_hash, initial_cursor.content_hash);
    }

    #[test]
    fn legacy_hashless_known_composer_reparses_outside_the_creation_window() {
        let rows = vec![
            composer_row("legacy", "gpt-5.2", 1_700_000_000_000),
            bubble_row("legacy", "b1", 2, "2026-05-25T22:00:00.000Z"),
        ];
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("state.vscdb");
        write_db(&db_path, &rows);
        let store = CursorStore::open_in_memory("org").unwrap();
        store
            .advance_composer(
                AgentSource::Cursor,
                &ComposerCursor {
                    composer_id: "legacy".to_string(),
                    bubble_count: 1,
                    max_created_at: collector_parser::timestamp::rfc3339_to_epoch_ms(
                        "2026-05-25T22:00:00.000Z",
                    )
                    .unwrap(),
                    content_hash: None,
                },
            )
            .unwrap();

        let units = assemble_cursor_units(
            &db_path,
            &store,
            ImportWindow::first_incremental(9_000_000_000_000),
            false,
        )
        .unwrap();
        assert_eq!(units.len(), 1);
    }

    /// Write a `cursorDiskKV` DB to a real file so assembly opens a live DB end to end. The WAL cases
    /// separately keep a writer open through the snapshot.
    fn write_db(path: &Path, rows: &[(String, Value)]) {
        let conn = Connection::open(path).unwrap();
        // DELETE journal mode keeps this fixture simple; the WAL-only case is covered above.
        conn.pragma_update(None, "journal_mode", "DELETE").unwrap();
        conn.execute_batch(CREATE_KV).unwrap();
        for (key, value) in rows {
            conn.execute(
                "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
                rusqlite::params![key, value.to_string()],
            )
            .unwrap();
        }
        conn.close().unwrap();
    }

    fn replace_row(path: &Path, key: &str, value: Value) {
        let conn = Connection::open(path).unwrap();
        conn.execute(
            "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value.to_string()],
        )
        .unwrap();
        conn.close().unwrap();
    }
}
