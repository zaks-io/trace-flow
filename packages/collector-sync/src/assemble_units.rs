// SPDX-License-Identifier: Apache-2.0
// Original Trace Flow code. This is the sync-layer equivalent of otto-sync engine.rs's per-file ->
// upload-unit step (~/src/otto, 2026-05-25), but it targets the local SQLite-cursor model — a `SyncUnit`
// the drive loop POSTs plus a `FileCursor` it advances only on a `2xx` — instead of otto's
// server-returned cursors, and resolves the `SessionContext` through the landed git freeze cache +
// remote normalizer rather than inline. Trace Flow owns the contract, IDs, pricing, redaction, and
// storage around this code.

//! Transcript assembly with durable session git attribution.
//!
//! [`assemble_sync_unit`] reads a discovered transcript snapshot and builds a [`SyncUnit`]. Live git
//! fallback first checks [`CursorStore`]'s per-source, per-transcript pin; a successful repo resolution
//! persists its root, normalized remote, and branch before facts are built. Later reads reuse that
//! evidence without git. Failed resolutions stay unpinned and retry in a later sync cycle.
//!
//! Claude and Cursor JSONL prefer the transcript's `gitBranch` over the pinned live branch. Codex
//! prefers its embedded git evidence and uses the pin only for live fallback. [`build_session_context`]
//! maps that evidence to parser context. Absolute repo roots remain local path-relativization anchors
//! and never enter uploaded facts. The file cursor advances only after successful upload.

use std::io::{BufRead, BufReader, Cursor, Error, ErrorKind, Read};

use collector_contracts::AgentSource;
use collector_parser::session_context::SessionContext;
use serde_json::Value;

use crate::claude_session::{
    agent_depth_from_transcript_path, claude_session_fields, ClaudeSessionFields,
};
use crate::codex_lineage::CodexLineage;
use crate::codex_session::codex_session_fields;
use crate::cursor::{CursorStore, FileCursor};
use crate::discovery::{head_hash, DiscoveredFile};
use crate::git::GitRemoteCache;
use crate::session_git::SessionGit;
use crate::sync_cycle::{SyncUnit, UnitCursor};

/// Read `file`, resolve its session's git attribution, and assemble the [`SyncUnit`] the drive loop
/// POSTs. A file-level read error propagates (the loop leaves the cursor unadvanced and retries the file
/// next scan); a malformed *line* inside the file is skipped, not fatal — see [`read_transcript`].
pub async fn assemble_sync_unit(
    file: &DiscoveredFile,
    source: AgentSource,
    cache: &GitRemoteCache,
    store: &CursorStore,
) -> std::io::Result<SyncUnit> {
    assemble_sync_unit_with_lineage(file, source, cache, store, None).await
}

pub async fn assemble_sync_unit_with_lineage(
    file: &DiscoveredFile,
    source: AgentSource,
    cache: &GitRemoteCache,
    store: &CursorStore,
    lineage: Option<&CodexLineage>,
) -> std::io::Result<SyncUnit> {
    let snapshot = read_transcript_file(file)?;
    assemble_snapshot(file, source, cache, store, snapshot, lineage).await
}

/// Read and parse `file`, bounded to its discovered size. Separate from [`assemble_snapshot`] so an
/// embedder can report [`TranscriptSnapshot::skipped_lines`] even when assembly then fails.
pub fn read_transcript_file(file: &DiscoveredFile) -> std::io::Result<TranscriptSnapshot> {
    let input = std::fs::File::open(&file.path)?;
    // Bound this pass to the discovered snapshot. A concurrent append belongs to the next pass.
    read_transcript_snapshot(BufReader::new(input.take(file.size_bytes)), file.size_bytes)
}

/// Assemble the [`SyncUnit`] for `file` from a snapshot [`read_transcript_file`] returned.
pub async fn assemble_snapshot(
    file: &DiscoveredFile,
    source: AgentSource,
    cache: &GitRemoteCache,
    store: &CursorStore,
    snapshot: TranscriptSnapshot,
    lineage: Option<&CodexLineage>,
) -> std::io::Result<SyncUnit> {
    assemble_records(
        file,
        source,
        cache,
        store,
        snapshot.parsed.records,
        snapshot.content_hash_head,
        lineage,
    )
    .await
}

/// Assemble a [`SyncUnit`] from an already-read snapshot of `file`.
///
/// Callers with a captured snapshot can reuse those bytes. Facts require UTF-8, matching
/// the historical `read_to_string` path.
pub async fn assemble_sync_unit_from_bytes(
    file: &DiscoveredFile,
    source: AgentSource,
    cache: &GitRemoteCache,
    store: &CursorStore,
    bytes: &[u8],
) -> std::io::Result<SyncUnit> {
    let size = usize::try_from(file.size_bytes)
        .map_err(|_| Error::new(ErrorKind::InvalidInput, "transcript snapshot is too large"))?;
    if bytes.len() < size {
        return Err(Error::new(
            ErrorKind::UnexpectedEof,
            format!(
                "transcript shrank after discovery: expected {} bytes, read {}",
                file.size_bytes,
                bytes.len()
            ),
        ));
    }
    let snapshot =
        read_transcript_snapshot(BufReader::new(Cursor::new(&bytes[..size])), file.size_bytes)?;
    assemble_records(
        file,
        source,
        cache,
        store,
        snapshot.parsed.records,
        snapshot.content_hash_head,
        None,
    )
    .await
}

async fn assemble_records(
    file: &DiscoveredFile,
    source: AgentSource,
    cache: &GitRemoteCache,
    store: &CursorStore,
    records: Vec<Value>,
    content_hash_head: String,
    lineage: Option<&CodexLineage>,
) -> std::io::Result<SyncUnit> {
    // Source-specific extraction preserves Codex embedded evidence and Claude transcript hints.
    let (fields, meta, head_sha, codex_agent_depth, parent_vendor_session_id) = match source {
        AgentSource::Codex => {
            let codex = codex_session_fields(&records);
            if codex.parent_thread_id.as_deref() == Some(codex.fields.vendor_session_id.as_str()) {
                return Err(Error::new(
                    ErrorKind::InvalidData,
                    "Codex session cannot parent itself",
                ));
            }
            let parent_vendor_session_id = codex.parent_thread_id.clone().unwrap_or_default();
            let agent_depth = match (codex.agent_depth, codex.parent_thread_id.as_deref()) {
                (Some(0), Some(_)) => {
                    return Err(Error::new(
                        ErrorKind::InvalidData,
                        "Codex child session has explicit depth zero",
                    ));
                }
                (Some(depth), _) => depth,
                (None, Some(parent)) => lineage
                    .ok_or_else(|| {
                        Error::new(
                            ErrorKind::InvalidData,
                            "Codex child depth requires the source lineage index",
                        )
                    })?
                    .child_depth(parent)?,
                (None, None) => 0,
            };
            // Prefer the transcript's embedded git (stable even if the checkout moved); only fall back
            // to a live resolve when Codex recorded no git block at all.
            let meta = match codex.embedded_git {
                Some(g) => Some(SessionGit::from(g)),
                None => store
                    .resolve_session_git(source, &file.path, codex.fields.cwd.as_deref(), cache)
                    .await
                    .map_err(Error::other)?,
            };
            (
                codex.fields,
                meta,
                codex.git_head_sha.unwrap_or_default(),
                Some(agent_depth),
                parent_vendor_session_id,
            )
        }
        AgentSource::Claude | AgentSource::Cursor => {
            let fields = claude_session_fields(&records);
            let meta = store
                .resolve_session_git(source, &file.path, fields.cwd.as_deref(), cache)
                .await
                .map_err(Error::other)?;
            (fields, meta, String::new(), None, String::new())
        }
    };
    let mut ctx = build_session_context(&fields, &file.path, meta.as_ref(), &head_sha);
    ctx.parent_vendor_session_id = parent_vendor_session_id;
    if let Some(agent_depth) = codex_agent_depth {
        ctx.agent_depth = agent_depth;
    }

    let next_cursor = UnitCursor::File(FileCursor {
        file_path: file.path.clone(),
        mtime_ms: file.mtime_ms,
        byte_offset: file.size_bytes,
        content_hash_head,
    });
    Ok(SyncUnit {
        records,
        ctx,
        next_cursor,
    })
}

/// A transcript's parsed JSONL records and how many lines were skipped as malformed.
#[derive(Debug, Default)]
pub struct TranscriptRecords {
    pub records: Vec<Value>,
    /// Non-blank lines that were not valid JSON. A count only, so format drift that drops data is
    /// visible in sync reports without the skipped content ever leaving the parser.
    pub skipped_lines: u32,
}

impl TranscriptRecords {
    fn push_line(&mut self, line: &str) {
        if line.trim().is_empty() {
            return;
        }
        match serde_json::from_str(line) {
            Ok(record) => self.records.push(record),
            Err(_) => self.skipped_lines = self.skipped_lines.saturating_add(1),
        }
    }
}

/// Parse a transcript's text into one [`Value`] per JSONL line. Blank lines are ignored and a line that
/// fails to parse is skipped (and counted) rather than failing the whole file, so one corrupt record
/// can't strand the rest of a session. This drops no data the cursor then hides: the whole file is
/// re-parsed every scan (the cursor advances only on a successful POST), so a line that becomes valid
/// later is picked up then.
pub fn read_transcript(text: &str) -> TranscriptRecords {
    let mut parsed = TranscriptRecords::default();
    text.lines().for_each(|line| parsed.push_line(line));
    parsed
}

/// One transcript read at its discovered size: the parsed records plus the head hash its cursor keeps.
pub struct TranscriptSnapshot {
    parsed: TranscriptRecords,
    content_hash_head: String,
}

impl TranscriptSnapshot {
    /// Lines skipped as malformed; see [`TranscriptRecords::skipped_lines`].
    pub fn skipped_lines(&self) -> u32 {
        self.parsed.skipped_lines
    }
}

fn read_transcript_snapshot(
    mut reader: impl BufRead,
    expected_bytes: u64,
) -> std::io::Result<TranscriptSnapshot> {
    let mut parsed = TranscriptRecords::default();
    let mut line = String::new();
    let mut bytes_read = 0u64;
    let mut head = String::new();
    let mut head_chars = 0usize;
    loop {
        let count = reader.read_line(&mut line)?;
        if count == 0 {
            break;
        }
        bytes_read = bytes_read.saturating_add(count as u64);
        if head_chars < 4096 {
            let remaining = 4096 - head_chars;
            for ch in line.chars().take(remaining) {
                head.push(ch);
                head_chars += 1;
            }
        }
        parsed.push_line(&line);
        line.clear();
    }
    if bytes_read != expected_bytes {
        return Err(Error::new(
            ErrorKind::UnexpectedEof,
            format!(
                "transcript shrank after discovery: expected {expected_bytes} bytes, read {bytes_read}"
            ),
        ));
    }
    Ok(TranscriptSnapshot {
        parsed,
        content_hash_head: head_hash(&head),
    })
}

/// Map a session's record-derived [`ClaudeSessionFields`] and resolved [`SessionGit`] onto the
/// [`SessionContext`] every emitter reads. Pure: `meta` is `None` for a non-repo cwd, which leaves the
/// remote and `repo_root` empty — the safe default that makes the parser relativize every absolute path
/// to the `outside_repo` sentinel, so no home dir or username leaks into a file event.
pub fn build_session_context(
    fields: &ClaudeSessionFields,
    transcript_path: &str,
    meta: Option<&SessionGit>,
    git_head_sha: &str,
) -> SessionContext {
    let normalized_git_remote = meta
        .map(|m| m.normalized_git_remote.clone())
        .unwrap_or_default();
    let repo_root = meta.map(|m| m.repo_root.clone()).unwrap_or_default();
    let git_branch = fields
        .git_branch
        .clone()
        .or_else(|| meta.and_then(|m| m.git_branch.clone()))
        .unwrap_or_default();
    // Coarse, hashable label used only when there is no remote. The *basename* of the repo root (or the
    // cwd when not a repo), never the full path, so `/Users/<name>/...` can't ride through the fallback.
    let label_source = if repo_root.is_empty() {
        fields.cwd.as_deref().unwrap_or_default()
    } else {
        repo_root.as_str()
    };

    let agent_depth = agent_depth_from_transcript_path(transcript_path);

    SessionContext {
        parent_vendor_session_id: String::new(),
        vendor_session_id: fields.vendor_session_id.clone(),
        agent_id: if agent_depth > 0 {
            fields.agent_id.clone()
        } else {
            String::new()
        },
        normalized_git_remote,
        repo_path_fallback: basename(label_source).to_string(),
        git_branch,
        // Claude records carry no HEAD sha (left empty); Codex embeds one in `session_meta.payload.git`.
        git_head_sha: git_head_sha.to_string(),
        vendor_started_at: fields.vendor_started_at,
        agent_depth,
        repo_root,
    }
}

/// The last path component of `path` (trailing separators trimmed), or `""` if there is none.
fn basename(path: &str) -> &str {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;

    fn fields(cwd: Option<&str>, branch: Option<&str>) -> ClaudeSessionFields {
        ClaudeSessionFields {
            vendor_session_id: "sess-1".to_string(),
            agent_id: String::new(),
            vendor_started_at: Some(1_779_813_539_892),
            cwd: cwd.map(str::to_string),
            git_branch: branch.map(str::to_string),
        }
    }

    fn meta(remote: Option<&str>, root: &str, branch: Option<&str>) -> SessionGit {
        SessionGit {
            repo_root: root.to_string(),
            normalized_git_remote: remote
                .map(crate::git_remote::normalize_git_remote)
                .unwrap_or_default(),
            git_branch: branch.map(str::to_string),
        }
    }

    #[test]
    fn read_transcript_skips_blank_lines_without_counting_them() {
        let text = "{\"a\":1}\n\n   \n{\"b\":2}\n";
        let parsed = read_transcript(text);
        assert_eq!(parsed.records.len(), 2);
        assert_eq!(parsed.skipped_lines, 0);
    }

    #[test]
    fn read_transcript_skips_malformed_lines_counts_them_and_keeps_the_good_ones() {
        let text = "{\"a\":1}\nnot json at all\n{\"b\":2}\n{\"truncated\":\n";
        let parsed = read_transcript(text);
        assert_eq!(parsed.records.len(), 2);
        assert_eq!(parsed.records[0]["a"], json!(1));
        assert_eq!(parsed.records[1]["b"], json!(2));
        assert_eq!(parsed.skipped_lines, 2);
    }

    #[test]
    fn no_meta_leaves_remote_and_repo_root_empty_and_falls_back_to_cwd_basename() {
        let ctx = build_session_context(
            &fields(Some("/work/trace-flow"), Some("feature-x")),
            "/Users/x/.claude/projects/p/abc.jsonl",
            None,
            "",
        );
        assert_eq!(ctx.normalized_git_remote, "");
        assert_eq!(ctx.repo_root, "");
        assert_eq!(ctx.repo_path_fallback, "trace-flow");
        // With no resolved branch, the record's hint is used.
        assert_eq!(ctx.git_branch, "feature-x");
        assert_eq!(ctx.agent_id, "");
        assert_eq!(ctx.git_head_sha, "");
        assert_eq!(ctx.vendor_session_id, "sess-1");
        assert_eq!(ctx.vendor_started_at, Some(1_779_813_539_892));
        assert_eq!(ctx.agent_depth, 0);
    }

    #[test]
    fn resolved_meta_sets_normalized_remote_and_root_but_transcript_branch_wins() {
        let ctx = build_session_context(
            &fields(Some("/work/trace-flow"), Some("feature-x")),
            "/p/abc.jsonl",
            Some(&meta(
                Some("git@github.com:acme/trace-flow.git"),
                "/work/trace-flow",
                Some("main"),
            )),
            "",
        );
        assert_eq!(ctx.normalized_git_remote, "github.com/acme/trace-flow");
        assert_eq!(ctx.repo_root, "/work/trace-flow");
        assert_eq!(ctx.git_branch, "feature-x");
        assert_eq!(ctx.repo_path_fallback, "trace-flow");
    }

    #[test]
    fn repo_path_fallback_is_a_bare_basename_never_a_home_path() {
        let ctx = build_session_context(
            &fields(Some("/Users/someone/projects/myrepo"), None),
            "/p/abc.jsonl",
            None,
            "",
        );
        assert_eq!(ctx.repo_path_fallback, "myrepo");
        assert!(!ctx.repo_path_fallback.contains("Users"));
        assert!(!ctx.repo_path_fallback.contains("someone"));
    }

    #[test]
    fn a_degenerate_root_cwd_yields_an_empty_fallback_not_a_separator() {
        // `basename("/")` has no last component; an empty label (no fingerprint) is the safe result,
        // never a bare separator that could read as a path.
        let ctx = build_session_context(&fields(Some("/"), None), "/p/abc.jsonl", None, "");
        assert_eq!(ctx.repo_path_fallback, "");
    }

    #[test]
    fn agent_depth_is_read_from_the_transcript_path() {
        let ctx = build_session_context(&fields(None, None), "/p/subagents/child.jsonl", None, "");
        assert_eq!(ctx.agent_depth, 1);
    }

    #[test]
    fn nested_claude_transcripts_keep_their_agent_id() {
        let mut fields = fields(Some("/work/trace-flow"), Some("feature-x"));
        fields.agent_id = "agent-a4816690be3dffb45".to_string();

        let top_level = build_session_context(&fields, "/p/parent.jsonl", None, "");
        assert_eq!(top_level.agent_depth, 0);
        assert_eq!(top_level.agent_id, "");

        let nested = build_session_context(
            &fields,
            "/p/parent/subagents/workflows/wf_ad9cf9af-963/agent-a4816690be3dffb45.jsonl",
            None,
            "",
        );
        assert_eq!(nested.agent_depth, 1);
        assert_eq!(nested.agent_id, "agent-a4816690be3dffb45");
    }

    fn run_git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("git is available");
        assert!(status.success(), "git {args:?} failed");
    }

    #[tokio::test]
    async fn assembles_a_unit_with_resolved_git_attribution_and_a_matching_cursor() {
        let dir = tempfile::TempDir::new().unwrap();
        let repo = dir.path();
        run_git(repo, &["init", "-q"]);
        run_git(
            repo,
            &["remote", "add", "origin", "git@github.com:acme/demo.git"],
        );

        let cwd = repo.to_str().unwrap();
        let body = format!(
            "{}\n",
            json!({
                "type": "user", "sessionId": "s-1", "cwd": cwd,
                "timestamp": "2026-05-26T16:38:59.892Z"
            })
        );
        let path = repo.join("transcript.jsonl");
        std::fs::write(&path, &body).unwrap();
        let size = std::fs::metadata(&path).unwrap().len();
        let file = DiscoveredFile {
            path: path.to_str().unwrap().to_string(),
            mtime_ms: 123.0,
            size_bytes: size,
        };

        let cache = GitRemoteCache::new();
        let store = CursorStore::open_in_memory("org").unwrap();
        let unit = assemble_sync_unit(&file, AgentSource::Claude, &cache, &store)
            .await
            .unwrap();

        assert_eq!(unit.ctx.normalized_git_remote, "github.com/acme/demo");
        assert!(!unit.ctx.repo_root.is_empty());
        assert_eq!(unit.ctx.vendor_session_id, "s-1");
        assert_eq!(unit.records.len(), 1);
        // The cursor pins the whole-file size and a head hash that matches a fresh disk read next scan.
        let UnitCursor::File(cursor) = &unit.next_cursor else {
            panic!("a JSONL source assembles a file cursor");
        };
        assert_eq!(cursor.byte_offset, size);
        assert_eq!(cursor.mtime_ms, 123.0);
        assert_eq!(cursor.content_hash_head, head_hash(&body));
    }

    #[tokio::test]
    async fn codex_uses_embedded_git_without_a_live_repo() {
        // A Codex transcript in a dir that is NOT a git checkout must still resolve its repo from the
        // `session_meta.payload.git` block — the bug was the Claude reader leaving Codex with no cwd,
        // so it fell back to a path fingerprint that read like a commit SHA.
        let dir = tempfile::TempDir::new().unwrap();
        let cwd = dir.path().join("not-a-repo");
        std::fs::create_dir_all(&cwd).unwrap();
        let body = format!(
            "{}\n{}\n",
            json!({
                "type": "session_meta",
                "timestamp": "2026-05-18T21:35:06.549Z",
                "payload": {
                    "id": "019e3d03-6b35-74c0-9dd1-c40bdbb6af72",
                    "cwd": cwd.to_str().unwrap(),
                    "timestamp": "2026-05-18T21:34:54.800Z",
                    "git": {
                        "commit_hash": "d1e85c4e8fdef82fbaded9539532b754080419e0",
                        "branch": "main",
                        "repository_url": "https://github.com/pingdotgg/t3code.git"
                    }
                }
            }),
            json!({ "type": "turn_context", "timestamp": "2026-05-18T21:35:07.000Z", "payload": { "model": "gpt-5.5" } })
        );
        let path = dir.path().join("rollout.jsonl");
        std::fs::write(&path, &body).unwrap();
        let file = DiscoveredFile {
            path: path.to_str().unwrap().to_string(),
            mtime_ms: 1.0,
            size_bytes: std::fs::metadata(&path).unwrap().len(),
        };

        let cache = GitRemoteCache::new();
        let store = CursorStore::open_in_memory("org").unwrap();
        let unit = assemble_sync_unit(&file, AgentSource::Codex, &cache, &store)
            .await
            .unwrap();

        assert_eq!(
            unit.ctx.normalized_git_remote,
            "github.com/pingdotgg/t3code"
        );
        assert_eq!(
            unit.ctx.vendor_session_id,
            "019e3d03-6b35-74c0-9dd1-c40bdbb6af72"
        );
        assert_eq!(unit.ctx.git_branch, "main");
        assert_eq!(
            unit.ctx.git_head_sha,
            "d1e85c4e8fdef82fbaded9539532b754080419e0"
        );
        assert_eq!(unit.ctx.repo_root, cwd.to_str().unwrap());
    }

    #[tokio::test]
    async fn streaming_and_byte_snapshot_paths_match_for_unicode_and_malformed_lines() {
        let dir = tempfile::TempDir::new().unwrap();
        let padding = "界".repeat(4_200);
        let body = format!(
            "{}\nmalformed json\n{}\n",
            json!({
                "type": "user",
                "sessionId": "unicode-session",
                "timestamp": "2026-05-26T16:38:59.892Z",
                "message": { "content": padding }
            }),
            json!({ "type": "assistant", "sessionId": "unicode-session" })
        );
        let path = dir.path().join("unicode.jsonl");
        std::fs::write(&path, &body).unwrap();
        let file = DiscoveredFile {
            path: path.to_str().unwrap().to_string(),
            mtime_ms: 10.0,
            size_bytes: body.len() as u64,
        };
        let cache = GitRemoteCache::new();
        let store = CursorStore::open_in_memory("org").unwrap();

        let streamed = assemble_sync_unit(&file, AgentSource::Claude, &cache, &store)
            .await
            .unwrap();
        let from_bytes = assemble_sync_unit_from_bytes(
            &file,
            AgentSource::Claude,
            &cache,
            &store,
            body.as_bytes(),
        )
        .await
        .unwrap();

        assert_eq!(streamed.records, from_bytes.records);
        assert_eq!(read_transcript_file(&file).unwrap().skipped_lines(), 1);
        assert_eq!(streamed.ctx, from_bytes.ctx);
        assert_eq!(streamed.next_cursor, from_bytes.next_cursor);
        let UnitCursor::File(cursor) = streamed.next_cursor else {
            panic!("JSONL source has a file cursor");
        };
        assert_eq!(cursor.content_hash_head, head_hash(&body));
    }

    #[tokio::test]
    async fn assembly_ignores_bytes_appended_after_discovery() {
        let dir = tempfile::TempDir::new().unwrap();
        let first = format!(
            "{}\n",
            json!({ "type": "user", "sessionId": "bounded", "message": {} })
        );
        let appended = format!(
            "{}\n",
            json!({ "type": "assistant", "sessionId": "bounded", "message": {} })
        );
        let path = dir.path().join("bounded.jsonl");
        std::fs::write(&path, &first).unwrap();
        let file = DiscoveredFile {
            path: path.to_str().unwrap().to_string(),
            mtime_ms: 10.0,
            size_bytes: first.len() as u64,
        };
        std::fs::write(&path, format!("{first}{appended}")).unwrap();
        let cache = GitRemoteCache::new();
        let store = CursorStore::open_in_memory("org").unwrap();

        let streamed = assemble_sync_unit(&file, AgentSource::Claude, &cache, &store)
            .await
            .unwrap();
        let from_bytes = assemble_sync_unit_from_bytes(
            &file,
            AgentSource::Claude,
            &cache,
            &store,
            format!("{first}{appended}").as_bytes(),
        )
        .await
        .unwrap();

        assert_eq!(streamed.records.len(), 1);
        assert_eq!(streamed.records, from_bytes.records);
        assert_eq!(streamed.next_cursor, from_bytes.next_cursor);
        let UnitCursor::File(cursor) = streamed.next_cursor else {
            panic!("JSONL source has a file cursor");
        };
        assert_eq!(cursor.byte_offset, first.len() as u64);
        assert_eq!(cursor.content_hash_head, head_hash(&first));
    }

    #[tokio::test]
    async fn assembly_fails_when_the_discovered_snapshot_is_no_longer_available() {
        let dir = tempfile::TempDir::new().unwrap();
        let body = "{\"type\":\"user\",\"sessionId\":\"short\"}\n";
        let path = dir.path().join("short.jsonl");
        std::fs::write(&path, body).unwrap();
        let file = DiscoveredFile {
            path: path.to_str().unwrap().to_string(),
            mtime_ms: 10.0,
            size_bytes: body.len() as u64,
        };
        std::fs::write(&path, &body[..body.len() / 2]).unwrap();
        let cache = GitRemoteCache::new();
        let store = CursorStore::open_in_memory("org").unwrap();

        let disk_error = match assemble_sync_unit(&file, AgentSource::Claude, &cache, &store).await
        {
            Ok(_) => panic!("a short disk snapshot must fail"),
            Err(error) => error,
        };
        let bytes_error = match assemble_sync_unit_from_bytes(
            &file,
            AgentSource::Claude,
            &cache,
            &store,
            &body.as_bytes()[..body.len() / 2],
        )
        .await
        {
            Ok(_) => panic!("a short byte snapshot must fail"),
            Err(error) => error,
        };
        assert_eq!(disk_error.kind(), ErrorKind::UnexpectedEof);
        assert_eq!(bytes_error.kind(), ErrorKind::UnexpectedEof);
    }

    #[tokio::test]
    async fn codex_uses_explicit_depth_without_a_parent_index() {
        let dir = tempfile::TempDir::new().unwrap();
        let body = format!(
            "{}\n",
            json!({
                "type": "session_meta",
                "payload": {
                    "id": "child",
                    "parent_thread_id": "unavailable-parent",
                    "source": { "subagent": { "thread_spawn": { "depth": 3 } } }
                }
            })
        );
        let path = dir.path().join("child.jsonl");
        std::fs::write(&path, &body).unwrap();
        let file = DiscoveredFile {
            path: path.to_str().unwrap().to_string(),
            mtime_ms: 1.0,
            size_bytes: body.len() as u64,
        };

        let unit = assemble_sync_unit(
            &file,
            AgentSource::Codex,
            &GitRemoteCache::new(),
            &CursorStore::open_in_memory("org").unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(unit.ctx.agent_depth, 3);
        assert_eq!(unit.ctx.parent_vendor_session_id, "unavailable-parent");
    }

    #[tokio::test]
    async fn codex_rejects_self_parent() {
        let dir = tempfile::TempDir::new().unwrap();
        let body = format!(
            "{}\n",
            json!({ "type": "session_meta", "payload": {
                "id": "same-thread", "parent_thread_id": "same-thread",
                "source": { "subagent": { "thread_spawn": { "depth": 1 } } }
            } })
        );
        let path = dir.path().join("self.jsonl");
        std::fs::write(&path, &body).unwrap();
        let file = DiscoveredFile {
            path: path.to_str().unwrap().to_string(),
            mtime_ms: 1.0,
            size_bytes: body.len() as u64,
        };
        let error = match assemble_sync_unit(
            &file,
            AgentSource::Codex,
            &GitRemoteCache::new(),
            &CursorStore::open_in_memory("org").unwrap(),
        )
        .await
        {
            Ok(_) => panic!("self-parent must fail before upload"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn codex_derives_missing_depth_from_verified_parent_metadata() {
        let dir = tempfile::TempDir::new().unwrap();
        let parent_body = format!(
            "{}\n",
            json!({ "type": "session_meta", "payload": { "id": "parent" } })
        );
        let parent_path = dir.path().join("parent.jsonl");
        std::fs::write(&parent_path, &parent_body).unwrap();
        let child_body = format!(
            "{}\n",
            json!({
                "type": "session_meta",
                "payload": { "id": "child", "parent_thread_id": "parent" }
            })
        );
        let child_path = dir.path().join("child.jsonl");
        std::fs::write(&child_path, &child_body).unwrap();
        let discovered = |path: &Path, size: usize| DiscoveredFile {
            path: path.to_str().unwrap().to_string(),
            mtime_ms: 1.0,
            size_bytes: size as u64,
        };
        let parent = discovered(&parent_path, parent_body.len());
        let child = discovered(&child_path, child_body.len());
        let lineage = CodexLineage::index(&[parent, child.clone()]);

        let unit = assemble_sync_unit_with_lineage(
            &child,
            AgentSource::Codex,
            &GitRemoteCache::new(),
            &CursorStore::open_in_memory("org").unwrap(),
            Some(&lineage),
        )
        .await
        .unwrap();
        assert_eq!(unit.ctx.agent_depth, 1);
        assert_eq!(unit.ctx.parent_vendor_session_id, "parent");
    }
}
