// SPDX-License-Identifier: MIT
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
//! **Snapshot safety (ADR).** The live DB is never opened mutably and never checkpointed. We copy the
//! `state.vscdb` + `-wal` + `-shm` trio to a scratch dir and open the *copy* with `immutable=1&mode=ro`,
//! which tells SQLite the file will not change under it (no locking, no `-wal` writeback). Copying the
//! WAL/SHM alongside the main DB keeps any un-checkpointed pages, so the snapshot is internally
//! consistent. The scratch copy is deleted when the [`CursorSnapshot`] drops.
//!
//! **`GLOB`, never `LIKE` (ADR).** `LIKE` is case-insensitive by default, which disables the `key` index
//! and forces a full multi-GB scan. Every key scan here is a `GLOB` prefix (`composerData:*`,
//! `bubbleId:<id>:*`) so the index is used; the composer id is GLOB-escaped before interpolation.
//!
//! **Whole-composer read, delta fact send.** A composer is changed iff its bubble count or newest
//! bubble timestamp advanced past the stored watermark. A changed composer is re-assembled in full so
//! session-level parsing stays correct; the sync cycle sends only new or changed fact hashes, and the
//! server-side fact ledger blocks repeat physical Tinybird inserts.

use std::fs;
use std::path::{Path, PathBuf};

use collector_contracts::AgentSource;
use collector_parser::cursor_session::{cursor_repo_hint, cursor_session_fields};
use collector_parser::session_context::SessionContext;
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::cursor::{ComposerCursor, CursorStore, CursorStoreError};
use crate::git_remote::normalize_git_remote;
use crate::import::ImportWindow;
use crate::sync_cycle::{SyncUnit, UnitCursor};

/// A failure reading a Cursor `state.vscdb`: copying/opening the snapshot (`Io`), querying the SQLite
/// store (`Sqlite`), or persisting/loading the per-composer watermark (`Store`). A malformed or skippable
/// bubble is never an error — only an unusable DB or a broken cursor store is.
#[derive(Debug, thiserror::Error)]
pub enum CursorReadError {
    #[error("cursor snapshot io error")]
    Io(#[from] std::io::Error),
    #[error("cursor snapshot sqlite error")]
    Sqlite(#[from] rusqlite::Error),
    #[error("cursor cursor-store error")]
    Store(#[from] CursorStoreError),
}

/// A read-only, point-in-time snapshot of a Cursor `state.vscdb`. Owns a private temp directory holding
/// the copied db (+ `-wal`/`-shm` when present), opened `immutable`; the directory is removed on drop.
pub struct CursorSnapshot {
    conn: Connection,
    /// The private scratch dir holding the copy, auto-removed on drop. `None` for an in-memory test conn.
    /// Held only for its `Drop`; the snapshot outlives the live DB even if it rotates underneath.
    _scratch: Option<tempfile::TempDir>,
}

impl CursorSnapshot {
    /// Copy the live DB trio into a fresh private subdir of `scratch_dir` and open the copy read-only +
    /// immutable. The private subdir means the copy can never collide with the source (even if
    /// `scratch_dir` is the DB's own directory). `scratch_dir` must exist and have room for the DB (it
    /// can be multi-GB).
    pub fn open(live_db: &Path, scratch_dir: &Path) -> Result<Self, CursorReadError> {
        let file_name = live_db
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("state.vscdb");
        // A unique subdir per snapshot: isolates the copy from the source and from a concurrent pass, and
        // its `Drop` removes the whole trio at once.
        let scratch = tempfile::Builder::new()
            .prefix("trace-flow-cursor-")
            .tempdir_in(scratch_dir)?;

        // Copy the main DB plus its sidecars when they exist (a cleanly-closed DB has none). Order does
        // not matter; SQLite reconstructs consistency from the trio at open.
        let copied_main = scratch.path().join(file_name);
        fs::copy(live_db, &copied_main)?;
        for suffix in ["-wal", "-shm"] {
            let sidecar = sibling(live_db, suffix);
            if sidecar.exists() {
                fs::copy(
                    &sidecar,
                    scratch.path().join(format!("{file_name}{suffix}")),
                )?;
            }
        }

        // `immutable=1` => SQLite assumes the file never changes: no locks, no `-wal` writeback. `mode=ro`
        // is belt-and-suspenders so an accidental write errors instead of mutating the snapshot.
        // Percent-encode the URI-significant characters so a path containing `%`, `?`, or `#` (SQLite
        // decodes the URI path and truncates at `?`/`#`) doesn't open the wrong file or fail. Encode
        // `%` first to avoid double-encoding the escapes we introduce.
        let encoded_path = copied_main
            .display()
            .to_string()
            .replace('%', "%25")
            .replace('?', "%3f")
            .replace('#', "%23");
        let uri = format!("file:{encoded_path}?immutable=1&mode=ro");
        let conn = Connection::open_with_flags(
            uri,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )?;
        Ok(Self {
            conn,
            _scratch: Some(scratch),
        })
    }

    #[cfg(test)]
    fn from_conn(conn: Connection) -> Self {
        Self {
            conn,
            _scratch: None,
        }
    }
}

/// `<path><suffix>` as a sibling path (e.g. `state.vscdb` + `-wal` => `state.vscdb-wal`).
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
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

/// List every composer in the snapshot via an index-using `GLOB 'composerData:*'` prefix scan.
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

    let mut composers = Vec::new();
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
        composers.push(ComposerRow {
            composer_id,
            model_name,
            created_at_ms,
        });
    }
    Ok(composers)
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

/// The change watermark for an assembled composer: bubble count + newest bubble `createdAt` (epoch ms).
/// Both are needed — count catches an in-place bubble edit; max-createdAt catches an append that left the
/// count unchanged. Mirrors the JSONL size+mtime+head-hash triple for a DB-backed session.
fn watermark(composer_id: &str, bubbles: &[Value]) -> ComposerCursor {
    ComposerCursor {
        composer_id: composer_id.to_string(),
        bubble_count: bubbles.len() as i64,
        max_created_at: max_bubble_created_at(bubbles).unwrap_or(0),
    }
}

/// Whether `next` is new or advanced past the `stored` watermark: never ingested, a changed bubble count,
/// or a newer bubble. A composer whose watermark is unchanged is skipped (its facts are already landed).
fn is_changed(stored: Option<&ComposerCursor>, next: &ComposerCursor) -> bool {
    match stored {
        None => true,
        Some(prev) => {
            prev.bubble_count != next.bubble_count || next.max_created_at > prev.max_created_at
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

/// Discover changed composers in the snapshot and assemble each into a [`SyncUnit`]. A composer is skipped
/// when its most-recent activity is outside `window` or its watermark is unchanged since the last
/// successful ingest. Sync (no async): the reader does no git shell-out — Cursor repo attribution comes
/// from inside the bubbles. The session-grain model rides each record as `__model` (the emitters read it
/// there), so `SessionContext` carries no model field.
///
/// # Errors
/// [`CursorReadError`]: `Io` if the snapshot copy fails, `Sqlite` if a snapshot query fails, `Store` if
/// loading a composer's stored watermark fails. A malformed bubble within a composer is skipped, not an
/// error.
pub fn assemble_cursor_units(
    live_db: &Path,
    scratch_dir: &Path,
    store: &CursorStore,
    window: ImportWindow,
) -> Result<Vec<SyncUnit>, CursorReadError> {
    let snap = CursorSnapshot::open(live_db, scratch_dir)?;
    let mut units = Vec::new();
    for composer in list_composers(&snap)? {
        let records = read_bubbles(&snap, &composer)?;
        // Window filter on the session's most-recent activity (start or newest bubble), so a long-lived
        // session that started before the window but is still active stays in scope.
        if !in_window(
            window,
            composer.created_at_ms,
            max_bubble_created_at(&records),
        ) {
            continue;
        }
        let stored = store.get_composer(AgentSource::Cursor, &composer.composer_id)?;
        let next = watermark(&composer.composer_id, &records);
        if !is_changed(stored.as_ref(), &next) {
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

    /// An in-memory `cursorDiskKV` fixture — no 3.8 GB file, no snapshot copy. Reader functions run
    /// against this through `CursorSnapshot::from_conn`.
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
        let w = watermark("c1", &bubbles);
        assert_eq!(w.bubble_count, 2);
        assert_eq!(w.max_created_at, 1_900_000_000_000);
    }

    #[test]
    fn change_detection_is_count_or_max_created_at() {
        let base = ComposerCursor {
            composer_id: "c1".to_string(),
            bubble_count: 10,
            max_created_at: 1_000,
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
        // Never ingested.
        assert!(is_changed(None, &base));
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
        // Materialize the in-memory fixture to a real file so assemble_cursor_units' snapshot copy works.
        write_db(&db_path, &snap_rows);

        let store = CursorStore::open_in_memory("org").unwrap();
        let units = assemble_cursor_units(&db_path, dir.path(), &store, open_window()).unwrap();
        assert_eq!(units.len(), 1);
        let UnitCursor::Composer(cursor) = &units[0].next_cursor else {
            panic!("cursor source assembles a composer cursor");
        };
        assert_eq!(cursor.composer_id, "c1");
        assert_eq!(cursor.bubble_count, 2);
        assert_eq!(units[0].records.len(), 2);

        // Advance the watermark and re-run: the unchanged composer is now skipped.
        store.advance_composer(AgentSource::Cursor, cursor).unwrap();
        let again = assemble_cursor_units(&db_path, dir.path(), &store, open_window()).unwrap();
        assert!(again.is_empty());
    }

    /// Write a `cursorDiskKV` DB to a real file (assemble_cursor_units snapshots a file, not an in-memory
    /// conn), so the file-copy + immutable-open path is exercised end to end. The connection is closed
    /// (dropped) before returning so all pages are flushed into the main file and the snapshot copy sees
    /// them — a still-open writer could leave rows only in the `-wal`.
    fn write_db(path: &Path, rows: &[(String, Value)]) {
        let conn = Connection::open(path).unwrap();
        // DELETE journal mode keeps everything in the single main file (no separate `-wal` to copy),
        // matching the simplest snapshot case; the real DB's WAL trio is covered by CursorSnapshot::open.
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
}
