use super::*;
use crate::{assemble_sync_unit, DiscoveredFile, FileCursor};
use serde_json::json;

#[test]
fn ac5_pre_change_cursor_database_opens_and_adds_schema_idempotently() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("cursor.sqlite");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(include_str!(
        "../tests/fixtures/cursor-before-session-git.sql"
    ))
    .unwrap();
    conn.execute(
        "INSERT INTO file_cursors VALUES ('org', 'claude', '/old.jsonl', 1, 10, 'hash')",
        [],
    )
    .unwrap();
    drop(conn);
    for _ in 0..2 {
        let store = CursorStore::open(&path, "org").unwrap();
        assert_eq!(
            store.get(AgentSource::Claude, "/old.jsonl").unwrap(),
            Some(FileCursor {
                file_path: "/old.jsonl".into(),
                mtime_ms: 1.0,
                byte_offset: 10,
                content_hash_head: "hash".into(),
            })
        );
        assert_eq!(
            store
                .session_git(AgentSource::Claude, "/old.jsonl")
                .unwrap(),
            None
        );
    }
}

fn git(cwd: &std::path::Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn transcript(dir: &std::path::Path, cwd: Option<&str>, branch: Option<&str>) -> DiscoveredFile {
    let path = dir.join("session.jsonl");
    let body = format!(
        "{}\n",
        json!({"type":"user", "uuid":"one", "sessionId":"session", "cwd":cwd, "gitBranch":branch, "message":{"role":"user", "content":"Inspect"}})
    );
    std::fs::write(&path, &body).unwrap();
    DiscoveredFile {
        path: path.to_str().unwrap().into(),
        size_bytes: body.len() as u64,
        mtime_ms: 1.0,
    }
}

#[tokio::test]
async fn cursor_jsonl_pins_successful_repo_without_remote_and_prefers_transcript_branch() {
    let repo = tempfile::TempDir::new().unwrap();
    let transcripts = tempfile::TempDir::new().unwrap();
    git(repo.path(), &["init", "-b", "main"]);
    let store = CursorStore::open_in_memory("org").unwrap();
    let file = transcript(transcripts.path(), repo.path().to_str(), Some("recorded"));
    let before = assemble_sync_unit(&file, AgentSource::Cursor, &GitRemoteCache::new(), &store)
        .await
        .unwrap();
    assert_eq!(before.ctx.git_branch, "recorded");
    assert_eq!(before.ctx.normalized_git_remote, "");
    assert!(!before.ctx.repo_root.is_empty());
    let pin = store
        .session_git(AgentSource::Cursor, &file.path)
        .unwrap()
        .unwrap();
    assert_eq!(pin.repo_root, before.ctx.repo_root);
    assert_eq!(pin.normalized_git_remote, "");
    git(
        repo.path(),
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/acme/later.git",
        ],
    );
    let after = assemble_sync_unit(&file, AgentSource::Cursor, &GitRemoteCache::new(), &store)
        .await
        .unwrap();
    assert_eq!(before.ctx, after.ctx);
}

#[tokio::test]
async fn missing_cwd_is_not_pinned_and_later_repo_evidence_recovers() {
    let repo = tempfile::TempDir::new().unwrap();
    let transcripts = tempfile::TempDir::new().unwrap();
    git(repo.path(), &["init", "-b", "main"]);
    let store = CursorStore::open_in_memory("org").unwrap();
    let missing = transcript(transcripts.path(), None, None);
    let before = assemble_sync_unit(
        &missing,
        AgentSource::Claude,
        &GitRemoteCache::new(),
        &store,
    )
    .await
    .unwrap();
    assert_eq!(before.ctx.repo_root, "");
    assert_eq!(
        store
            .session_git(AgentSource::Claude, &missing.path)
            .unwrap(),
        None
    );
    let recovered = transcript(transcripts.path(), repo.path().to_str(), None);
    let after = assemble_sync_unit(
        &recovered,
        AgentSource::Claude,
        &GitRemoteCache::new(),
        &store,
    )
    .await
    .unwrap();
    assert!(!after.ctx.repo_root.is_empty());
    assert!(store
        .session_git(AgentSource::Claude, &missing.path)
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn pins_are_isolated_by_source_and_organization() {
    let repo = tempfile::TempDir::new().unwrap();
    let transcripts = tempfile::TempDir::new().unwrap();
    let db = transcripts.path().join("cursor.sqlite");
    git(repo.path(), &["init", "-b", "main"]);
    git(
        repo.path(),
        &[
            "remote",
            "add",
            "origin",
            "git@github.com:acme/original.git",
        ],
    );
    let store = CursorStore::open(&db, "org").unwrap();
    let file = transcript(transcripts.path(), repo.path().to_str(), None);
    assemble_sync_unit(&file, AgentSource::Claude, &GitRemoteCache::new(), &store)
        .await
        .unwrap();
    git(
        repo.path(),
        &[
            "remote",
            "set-url",
            "origin",
            "git@github.com:acme/current.git",
        ],
    );
    let other_org = CursorStore::open(&db, "other-org").unwrap();
    for (source, store) in [
        (AgentSource::Cursor, &store),
        (AgentSource::Claude, &other_org),
    ] {
        let unit = assemble_sync_unit(&file, source, &GitRemoteCache::new(), store)
            .await
            .unwrap();
        assert_eq!(unit.ctx.normalized_git_remote, "github.com/acme/current");
    }
    let unit = assemble_sync_unit(&file, AgentSource::Claude, &GitRemoteCache::new(), &store)
        .await
        .unwrap();
    assert_eq!(unit.ctx.normalized_git_remote, "github.com/acme/original");
}
