// SPDX-License-Identifier: MIT
// Original Trace Flow code. This is the sync-layer equivalent of otto-sync engine.rs's per-file ->
// upload-unit step (~/src/otto, 2026-05-25), but it targets the local SQLite-cursor model — a `SyncUnit`
// the drive loop POSTs plus a `FileCursor` it advances only on a `2xx` — instead of otto's
// server-returned cursors, and resolves the `SessionContext` through the landed git freeze cache +
// remote normalizer rather than inline. Trace Flow owns the contract, IDs, pricing, redaction, and
// storage around this code.

//! Sync-unit assembly: the read half of 3d.
//!
//! [`assemble_sync_unit`] turns one [`DiscoveredFile`] the scan selected into the [`SyncUnit`] the drive
//! loop POSTs: it reads the whole transcript, resolves the session's git attribution once, and records
//! the cursor the loop advances only after a `2xx`. The **whole-file model** (ADR / otto) means the unit
//! carries the *entire* file and the cursor's `byte_offset` is the file size; server-side dedupe absorbs
//! the re-send of an unchanged tail.
//!
//! The field mapping lives in the pure [`build_session_context`] (it takes already-resolved
//! [`GitMetadata`], so it is testable without a real repo); the only impure steps are the file read and
//! the one `git` resolve in the async wrapper.

use collector_contracts::AgentSource;
use collector_parser::session_context::SessionContext;
use serde_json::Value;

use crate::claude_session::{
    agent_depth_from_transcript_path, claude_session_fields, ClaudeSessionFields,
};
use crate::codex_session::codex_session_fields;
use crate::cursor::FileCursor;
use crate::discovery::{head_hash, DiscoveredFile};
use crate::git::{GitMetadata, GitRemoteCache};
use crate::git_remote::normalize_git_remote;
use crate::sync_cycle::{SyncUnit, UnitCursor};

/// Read `file`, resolve its session's git attribution, and assemble the [`SyncUnit`] the drive loop
/// POSTs. A file-level read error propagates (the loop leaves the cursor unadvanced and retries the file
/// next scan); a malformed *line* inside the file is skipped, not fatal — see [`read_transcript`].
pub async fn assemble_sync_unit(
    file: &DiscoveredFile,
    source: AgentSource,
    cache: &GitRemoteCache,
) -> std::io::Result<SyncUnit> {
    // Synchronous read by design: this crate spawns nothing and carries no tokio `rt` feature (the
    // whole discovery/cursor layer reads on the embedder's thread). This fn is `async` only for the
    // `git` resolve below; the embedder budgets the read like every other scan I/O.
    let text = std::fs::read_to_string(&file.path)?;
    let records = read_transcript(&text);

    // Codex and Claude carry session identity + git differently: Claude repeats `sessionId`/`cwd`/
    // `gitBranch` per line and the repo is resolved live from `cwd`; Codex records one `session_meta`
    // whose payload embeds the id, cwd, and git remote/branch/sha directly. Using the Claude reader on
    // a Codex transcript left every Codex session with no cwd → no remote → a path-hash that read like
    // a commit. Branch on source so each gets the right extractor.
    let (fields, meta, head_sha) = match source {
        AgentSource::Codex => {
            let codex = codex_session_fields(&records);
            // Prefer the transcript's embedded git (stable even if the checkout moved); only fall back
            // to a live resolve when Codex recorded no git block at all.
            let meta = match codex.embedded_git {
                Some(g) => Some(g),
                None => match codex.fields.cwd.as_deref() {
                    Some(cwd) => cache.resolve(cwd).await,
                    None => None,
                },
            };
            (codex.fields, meta, codex.git_head_sha.unwrap_or_default())
        }
        AgentSource::Claude | AgentSource::Cursor => {
            let fields = claude_session_fields(&records);
            // One git resolve per session, keyed on its cwd; a non-repo (or absent cwd) leaves
            // attribution empty.
            let meta = match fields.cwd.as_deref() {
                Some(cwd) => cache.resolve(cwd).await,
                None => None,
            };
            (fields, meta, String::new())
        }
    };
    let ctx = build_session_context(&fields, &file.path, meta.as_ref(), &head_sha);

    let next_cursor = UnitCursor::File(FileCursor {
        file_path: file.path.clone(),
        mtime_ms: file.mtime_ms,
        byte_offset: file.size_bytes,
        // Hash the same text we just read so the cursor matches what `discovery::read_head_hash`
        // recomputes from disk next scan; re-reading could race a concurrent write.
        content_hash_head: head_hash(&text),
    });
    Ok(SyncUnit {
        records,
        ctx,
        next_cursor,
    })
}

/// Parse a transcript's text into one [`Value`] per JSONL line. Blank lines are ignored and a line that
/// fails to parse is skipped rather than failing the whole file, so one corrupt record can't strand the
/// rest of a session. This drops no data the cursor then hides: the whole file is re-parsed every scan
/// (the cursor advances only on a successful POST), so a line that becomes valid later is picked up then.
pub fn read_transcript(text: &str) -> Vec<Value> {
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// Map a session's record-derived [`ClaudeSessionFields`] and resolved [`GitMetadata`] onto the
/// [`SessionContext`] every emitter reads. Pure: `meta` is `None` for a non-repo cwd, which leaves the
/// remote and `repo_root` empty — the safe default that makes the parser relativize every absolute path
/// to the `outside_repo` sentinel, so no home dir or username leaks into a file event.
pub fn build_session_context(
    fields: &ClaudeSessionFields,
    transcript_path: &str,
    meta: Option<&GitMetadata>,
    git_head_sha: &str,
) -> SessionContext {
    let normalized_git_remote = meta
        .and_then(|m| m.git_remote_url.as_deref())
        .map(normalize_git_remote)
        .unwrap_or_default();
    let repo_root = meta.map(|m| m.git_root.clone()).unwrap_or_default();
    let git_branch = meta
        .and_then(|m| m.git_branch.clone())
        .or_else(|| fields.git_branch.clone())
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

    fn meta(remote: Option<&str>, root: &str, branch: Option<&str>) -> GitMetadata {
        GitMetadata {
            git_root: root.to_string(),
            git_remote_url: remote.map(str::to_string),
            git_branch: branch.map(str::to_string),
        }
    }

    #[test]
    fn read_transcript_skips_blank_lines() {
        let text = "{\"a\":1}\n\n   \n{\"b\":2}\n";
        let records = read_transcript(text);
        assert_eq!(records.len(), 2);
    }

    #[test]
    fn read_transcript_skips_a_malformed_line_but_keeps_the_good_ones() {
        let text = "{\"a\":1}\nnot json at all\n{\"b\":2}\n";
        let records = read_transcript(text);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["a"], json!(1));
        assert_eq!(records[1]["b"], json!(2));
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
    fn resolved_meta_sets_normalized_remote_repo_root_and_overrides_the_branch_hint() {
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
        // The live branch wins over the record hint.
        assert_eq!(ctx.git_branch, "main");
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
        let unit = assemble_sync_unit(&file, AgentSource::Claude, &cache)
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
        let unit = assemble_sync_unit(&file, AgentSource::Codex, &cache)
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
}
