// SPDX-License-Identifier: MIT
// Adapted from otto-sync's `files.rs` (the `walk_files` / `mtime_to_ms` / oldest-first sort) and the
// change-detection half of `engine.rs::cursor_indicates_unchanged` + `hash_head_text` / `head_text` /
// `utf8_prefix` (~/src/otto, 2026-05-25). The selection here reads the *local SQLite* `CursorStore`
// instead of otto's server-returned sync-start cursors — Trace Flow keeps cursor state on-disk (ADR
// "Local state"). Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Transcript discovery: the **scan + selection** half of the sync pass.
//!
//! [`walk_transcripts`] enumerates and stats the transcript files under a root; [`select_changed`]
//! narrows that list to the files a pass should actually read — those inside the [`ImportWindow`] that
//! are new or changed since their stored [`FileCursor`]. The read + parse + [`SyncUnit`] assembly is
//! the next 3d leaf; this module decides only *which* files, never opening one except to confirm the
//! head hash.
//!
//! **Whole-file read, delta fact send (ADR / otto).** A cursor records the file's size, mtime, and
//! head-hash at the last successful ingest; "unchanged" means all three still match. A changed file is
//! re-read in full so JSONL record boundaries and session-level assembly stay correct, then the sync
//! cycle sends only new or changed fact hashes. `byte_offset` is therefore the file *size* at last
//! ingest, used only for this test.
//!
//! I/O here is synchronous to match the synchronous [`CursorStore`]; the embedder runs a pass off its
//! hot path. The walk is best-effort (an unreadable entry is skipped and reappears next scan); only a
//! [`CursorStore`] failure — a broken local DB — aborts a selection.

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::time::SystemTime;

use collector_contracts::AgentSource;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use walkdir::WalkDir;

use crate::cursor::{CursorStore, CursorStoreError};
use crate::import::ImportWindow;

/// The first 4096 chars are enough to fingerprint an in-place rewrite (a transcript's header changes
/// when the session is replaced); hashing the whole file every scan would be wasteful.
const HEAD_HASH_CHAR_LIMIT: usize = 4096;
/// UTF-8 encodes a `char` in at most four bytes, so this many bytes always covers `HEAD_HASH_CHAR_LIMIT`
/// chars regardless of content.
const MAX_UTF8_BYTES_PER_CHAR: usize = 4;

/// A transcript file the scan found, carrying the stats [`select_changed`] needs.
#[derive(Debug, Clone, PartialEq)]
pub struct DiscoveredFile {
    /// Absolute local path. Local-only — never uploaded.
    pub path: String,
    pub mtime_ms: f64,
    pub size_bytes: u64,
}

/// Walk `root` and stat every `.jsonl` transcript file beneath it, sorted oldest-mtime-first (then by
/// path) so a partial pass makes progress on the oldest files first and the order is deterministic.
///
/// A missing root yields an empty list — the normal first-run state before the agent has written any
/// transcript. Entries that fail to read or stat are skipped rather than failing the whole walk; they
/// reappear on the next scan.
pub fn walk_transcripts(root: &Path) -> Vec<DiscoveredFile> {
    if !root.exists() {
        return Vec::new();
    }
    let mut found = Vec::new();
    for entry in WalkDir::new(root).follow_links(false).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str() else {
            continue;
        };
        if !name.ends_with(".jsonl") {
            continue;
        }
        let Some(path) = entry.path().to_str() else {
            continue;
        };
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        found.push(DiscoveredFile {
            path: path.to_string(),
            mtime_ms: mtime_to_ms(&meta),
            size_bytes: meta.len(),
        });
    }
    found.sort_by(|a, b| {
        a.mtime_ms
            .total_cmp(&b.mtime_ms)
            .then_with(|| a.path.cmp(&b.path))
    });
    found
}

/// Narrow `files` to those a pass should read: inside `window` and new-or-changed since their cursor.
///
/// A file is skipped only when its cursor matches on size **and** mtime is not newer **and** the head
/// hash still matches — otto's unchanged test — so an in-place rewrite that preserved size and mtime is
/// still caught by the hash. A `CursorStore` read error aborts the selection (the local DB is broken);
/// a head-hash *read* error does not — that file is conservatively treated as changed, and the next
/// leaf's full read surfaces any real I/O error per-file instead of stranding the whole batch.
pub fn select_changed(
    files: Vec<DiscoveredFile>,
    store: &CursorStore,
    source: AgentSource,
    window: ImportWindow,
) -> Result<Vec<DiscoveredFile>, CursorStoreError> {
    let mut selected = Vec::new();
    for file in files {
        if !window.includes(file.mtime_ms) {
            continue;
        }
        if is_changed(&file, store, source)? {
            selected.push(file);
        }
    }
    Ok(selected)
}

fn is_changed(
    file: &DiscoveredFile,
    store: &CursorStore,
    source: AgentSource,
) -> Result<bool, CursorStoreError> {
    let Some(cursor) = store.get(source, &file.path)? else {
        return Ok(true); // never ingested
    };
    // `>` not `>=`: a re-stat at the *same* mtime is not a change, so the head-hash check below is the
    // tie-breaker. Tightening this to `>=` would re-read every unchanged file every pass.
    if file.size_bytes != cursor.byte_offset || file.mtime_ms > cursor.mtime_ms {
        return Ok(true);
    }
    if cursor.content_hash_head.is_empty() {
        return Ok(true);
    }
    // Size and mtime say unchanged; confirm against the head hash to catch an in-place rewrite. If the
    // head can't be read, re-read the file — losing the skip is harmless, a wrong skip would drop data.
    match read_head_hash(&file.path) {
        Ok(head) => Ok(head != cursor.content_hash_head),
        Err(_) => Ok(true),
    }
}

/// `"sha256:"` + lowercase hex of the SHA-256 of `text`'s first [`HEAD_HASH_CHAR_LIMIT`] chars — the
/// stored cursor's `content_hash_head`. Same convention as the parser's content hashes; a stable
/// change-detection fingerprint, not a security boundary. The next leaf calls this on the full text it
/// reads so the cursor it writes matches what [`read_head_hash`] recomputes from disk on the next scan.
pub fn head_hash(text: &str) -> String {
    let head = head_text(text);
    let digest = Sha256::digest(head.as_bytes());
    let mut out = String::with_capacity("sha256:".len() + digest.len() * 2);
    out.push_str("sha256:");
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Read just enough of `path` to hash its head, without loading the whole file. The buffer holds the
/// worst-case byte length of [`HEAD_HASH_CHAR_LIMIT`] chars, so the UTF-8 prefix always contains every
/// char [`head_hash`] needs.
fn read_head_hash(path: &str) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut buf = vec![0u8; HEAD_HASH_CHAR_LIMIT * MAX_UTF8_BYTES_PER_CHAR];
    let n = file.read(&mut buf)?;
    Ok(head_hash(utf8_prefix(&buf[..n])))
}

/// The longest valid UTF-8 prefix of `bytes` (a read may cut a multi-byte char; the dropped tail is
/// past `HEAD_HASH_CHAR_LIMIT` anyway, so the hash is unaffected).
fn utf8_prefix(bytes: &[u8]) -> &str {
    match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(err) => std::str::from_utf8(&bytes[..err.valid_up_to()]).unwrap_or(""),
    }
}

fn head_text(text: &str) -> &str {
    match text.char_indices().nth(HEAD_HASH_CHAR_LIMIT) {
        Some((byte_idx, _)) => &text[..byte_idx],
        None => text,
    }
}

fn mtime_to_ms(meta: &std::fs::Metadata) -> f64 {
    let modified = meta
        .modified()
        .or_else(|_| meta.created())
        .unwrap_or_else(|_| SystemTime::now());
    modified
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor::FileCursor;
    use std::fs;
    use tempfile::TempDir;

    const MS_PER_DAY: i64 = 24 * 60 * 60 * 1000;

    /// A window that admits everything from the epoch onward, so window filtering is out of the way
    /// for the change-detection tests.
    fn open_window() -> ImportWindow {
        ImportWindow::first_incremental(MS_PER_DAY) // cutoff = 0
    }

    fn write(dir: &TempDir, name: &str, body: &str) -> String {
        let path = dir.path().join(name);
        fs::write(&path, body).unwrap();
        path.to_str().unwrap().to_string()
    }

    /// Stat a path back into a `DiscoveredFile` the way the walk would, so cursors can be built to
    /// match (or deliberately mismatch) the real on-disk size/mtime.
    fn stat(path: &str) -> DiscoveredFile {
        let meta = fs::metadata(path).unwrap();
        DiscoveredFile {
            path: path.to_string(),
            mtime_ms: mtime_to_ms(&meta),
            size_bytes: meta.len(),
        }
    }

    fn matching_cursor(file: &DiscoveredFile, body: &str) -> FileCursor {
        FileCursor {
            file_path: file.path.clone(),
            mtime_ms: file.mtime_ms,
            byte_offset: file.size_bytes,
            content_hash_head: head_hash(body),
        }
    }

    #[test]
    fn walk_finds_nested_jsonl_and_skips_other_files() {
        let dir = TempDir::new().unwrap();
        write(&dir, "a.jsonl", "{}");
        write(&dir, "notes.txt", "ignore me");
        fs::create_dir(dir.path().join("proj")).unwrap();
        write(&dir, "proj/b.jsonl", "{}");

        let found = walk_transcripts(dir.path());
        let names: Vec<_> = found
            .iter()
            .map(|f| {
                Path::new(&f.path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap()
            })
            .collect();
        assert_eq!(found.len(), 2);
        assert!(names.contains(&"a.jsonl"));
        assert!(names.contains(&"b.jsonl"));
        assert!(!names.contains(&"notes.txt"));
    }

    #[test]
    fn walk_of_a_missing_root_is_empty() {
        assert!(walk_transcripts(Path::new("/no/such/dir/here")).is_empty());
    }

    #[test]
    fn a_file_with_no_cursor_is_selected() {
        let dir = TempDir::new().unwrap();
        let path = write(&dir, "s.jsonl", "{}\n");
        let store = CursorStore::open_in_memory("org").unwrap();

        let out = select_changed(
            vec![stat(&path)],
            &store,
            AgentSource::Claude,
            open_window(),
        )
        .unwrap();
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn an_unchanged_file_is_skipped() {
        let dir = TempDir::new().unwrap();
        let body = "{\"a\":1}\n";
        let path = write(&dir, "s.jsonl", body);
        let file = stat(&path);
        let store = CursorStore::open_in_memory("org").unwrap();
        store
            .advance(AgentSource::Claude, &matching_cursor(&file, body))
            .unwrap();

        let out = select_changed(vec![file], &store, AgentSource::Claude, open_window()).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn a_grown_file_is_selected() {
        let dir = TempDir::new().unwrap();
        let body = "{\"a\":1}\n";
        let path = write(&dir, "s.jsonl", body);
        let file = stat(&path);
        let store = CursorStore::open_in_memory("org").unwrap();
        // Cursor recorded a smaller size than the file now has.
        let mut cursor = matching_cursor(&file, body);
        cursor.byte_offset = file.size_bytes - 1;
        store.advance(AgentSource::Claude, &cursor).unwrap();

        let out = select_changed(vec![file], &store, AgentSource::Claude, open_window()).unwrap();
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn a_file_with_a_newer_mtime_is_selected() {
        let dir = TempDir::new().unwrap();
        let body = "{\"a\":1}\n";
        let path = write(&dir, "s.jsonl", body);
        let file = stat(&path);
        let store = CursorStore::open_in_memory("org").unwrap();
        // Cursor's mtime is older than the file's current mtime.
        let mut cursor = matching_cursor(&file, body);
        cursor.mtime_ms = file.mtime_ms - 1.0;
        store.advance(AgentSource::Claude, &cursor).unwrap();

        let out = select_changed(vec![file], &store, AgentSource::Claude, open_window()).unwrap();
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn an_in_place_rewrite_that_preserved_size_and_mtime_is_caught_by_the_head_hash() {
        let dir = TempDir::new().unwrap();
        let body = "{\"version\":1}\n";
        let path = write(&dir, "s.jsonl", body);
        let file = stat(&path);
        let store = CursorStore::open_in_memory("org").unwrap();
        // Same size and mtime, but the head hash is from the *previous* content.
        let mut cursor = matching_cursor(&file, body);
        cursor.content_hash_head = head_hash("{\"version\":0}\n");
        store.advance(AgentSource::Claude, &cursor).unwrap();

        let out = select_changed(vec![file], &store, AgentSource::Claude, open_window()).unwrap();
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn files_outside_the_import_window_are_dropped_before_any_cursor_check() {
        let dir = TempDir::new().unwrap();
        let path = write(&dir, "s.jsonl", "{}\n");
        let file = stat(&path);
        // Window whose cutoff is after the file's mtime: first_incremental(start) cuts at start - 24h,
        // so a start two days past the file's mtime leaves the cutoff a day after it.
        let start = file.mtime_ms as i64 + 2 * MS_PER_DAY;
        let window = ImportWindow::first_incremental(start);
        let store = CursorStore::open_in_memory("org").unwrap();

        let out = select_changed(vec![file], &store, AgentSource::Claude, window).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn head_hash_from_memory_matches_a_disk_read() {
        let dir = TempDir::new().unwrap();
        let body = "line one\nline two\n";
        let path = write(&dir, "s.jsonl", body);
        assert_eq!(read_head_hash(&path).unwrap(), head_hash(body));
        assert!(head_hash(body).starts_with("sha256:"));
    }
}
