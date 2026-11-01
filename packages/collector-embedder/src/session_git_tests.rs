use super::tests::{raw_response, request_json, run_fact_sync, spawn_http};
use collector_contracts::AgentIngestEnvelope;
use serde_json::json;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

struct SessionGitHarness {
    home: tempfile::TempDir,
    state: tempfile::TempDir,
    repo: PathBuf,
    ingest_url: String,
    uploads: Arc<Mutex<Vec<AgentIngestEnvelope>>>,
}

impl SessionGitHarness {
    async fn new() -> Self {
        let home = crate::test_support::private_tempdir();
        let state = crate::test_support::private_tempdir();
        let repo = home.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        init_repo(&repo);
        let uploads = Arc::new(Mutex::new(Vec::new()));
        let ingest_url = spawn_http({
            let uploads = Arc::clone(&uploads);
            move |raw| {
                uploads.lock().unwrap().push(
                    serde_json::from_str::<AgentIngestEnvelope>(&request_json(&raw)).unwrap(),
                );
                raw_response(
                    202,
                    "Accepted",
                    r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
                )
            }
        })
        .await;
        Self {
            home,
            state,
            repo,
            ingest_url,
            uploads,
        }
    }

    fn transcript(&self, session: &str) -> PathBuf {
        self.home
            .path()
            .join(".claude")
            .join("projects")
            .join("project")
            .join(format!("{session}.jsonl"))
    }

    fn append(&self, session: &str, index: usize, branch: Option<&str>) {
        let path = self.transcript(session);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let record = json!({
            "type":"user", "sessionId":session, "uuid":format!("{session}-{index}"),
            "timestamp":"2026-09-01T12:00:00.000Z", "cwd":self.repo,
            "gitBranch":branch, "message":{"role":"user", "content":"Inspect the repository"}
        });
        writeln!(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .unwrap(),
            "{record}"
        )
        .unwrap();
    }

    fn append_codex(&self, session: &str, index: usize, embedded_git: bool) {
        let path = self
            .home
            .path()
            .join(".codex")
            .join("sessions")
            .join(format!("{session}.jsonl"));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut output = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        if index == 1 {
            let mut meta =
                json!({"type":"session_meta", "payload":{"id":session, "cwd":self.repo}});
            if embedded_git {
                meta["payload"]["git"] = json!({"repository_url":"git@github.com:acme/embedded.git", "branch":"embedded-branch", "commit_hash":"recorded-sha"});
            }
            writeln!(output, "{meta}").unwrap();
        }
        let record = json!({"type":"response_item", "timestamp":format!("2026-09-01T12:00:{index:02}.000Z"), "payload":{
            "type":"message", "role":"user", "content":[{"type":"input_text", "text":format!("Inspect record {index}")}]
        }});
        writeln!(output, "{record}").unwrap();
    }

    async fn sync(&self) -> Vec<AgentIngestEnvelope> {
        let outcome = run_fact_sync(
            self.home.path(),
            self.state.path(),
            self.ingest_url.clone(),
            false,
            1_779_840_000_000,
        )
        .await;
        assert!(
            outcome
                .reports
                .iter()
                .all(|(_, report)| report.is_complete()),
            "{outcome:?}"
        );
        std::mem::take(&mut *self.uploads.lock().unwrap())
    }
}

fn git(repo: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .current_dir(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

fn init_repo(repo: &Path) {
    git(repo, &["init", "-b", "main"]);
    git(
        repo,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "Initial",
        ],
    );
    git(
        repo,
        &[
            "remote",
            "add",
            "origin",
            "git@github.com:acme/original.git",
        ],
    );
}

#[tokio::test]
async fn no_origin_session_adopts_first_remote_once() {
    let harness = SessionGitHarness::new().await;
    git(&harness.repo, &["remote", "remove", "origin"]);
    harness.append("session", 1, None);
    let first = harness.sync().await;
    assert_eq!(first[0].facts.messages[0].normalized_git_remote, "");
    git(
        &harness.repo,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/acme/first.git",
        ],
    );
    git(&harness.repo, &["checkout", "-b", "later-branch"]);
    harness.append("session", 2, None);
    let adopted = harness.sync().await;
    assert_eq!(adopted[0].facts.messages.len(), 2);
    assert!(adopted[0]
        .facts
        .messages
        .iter()
        .all(
            |message| message.normalized_git_remote == "github.com/acme/first"
                && message.git_branch == "main"
        ));
    git(
        &harness.repo,
        &[
            "remote",
            "set-url",
            "origin",
            "https://github.com/acme/later.git",
        ],
    );
    harness.append("session", 3, None);
    let fixed = harness.sync().await;
    assert_eq!(fixed[0].facts.messages.len(), 2);
    assert_eq!(fixed[0].facts.messages[0], adopted[0].facts.messages[0]);
    assert_eq!(
        fixed[0].facts.messages[1].normalized_git_remote,
        "github.com/acme/first"
    );
    assert_eq!(
        fixed[0].facts.messages[1].vendor_message_id.as_deref(),
        Some("session-3")
    );
}

#[tokio::test]
async fn ac1_remote_rename_uploads_only_new_message_and_unchanged_attribution() {
    let harness = SessionGitHarness::new().await;
    harness.append("old", 1, None);
    harness.append("old", 2, None);
    let first = harness.sync().await;
    assert_eq!(first[0].facts.messages.len(), 2);
    git(
        &harness.repo,
        &[
            "remote",
            "set-url",
            "origin",
            "https://github.com/acme/renamed.git",
        ],
    );
    harness.append("old", 3, None);
    let second = harness.sync().await;
    let messages = &second[0].facts.messages;
    assert_eq!(second.len(), 1);
    assert_eq!(
        messages.len(),
        2,
        "only the new message and repeated attribution may be uploaded"
    );
    assert_eq!(messages[0], first[0].facts.messages[0]);
    assert_eq!(messages[1].vendor_message_id.as_deref(), Some("old-3"));
    assert!(messages
        .iter()
        .all(|message| message.normalized_git_remote == "github.com/acme/original"));
}

#[tokio::test]
async fn ac2_new_session_after_rename_uses_current_remote() {
    let harness = SessionGitHarness::new().await;
    harness.append("old", 1, None);
    harness.sync().await;
    git(
        &harness.repo,
        &[
            "remote",
            "set-url",
            "origin",
            "https://github.com/acme/renamed.git",
        ],
    );
    harness.append("new", 1, None);
    let uploaded = harness.sync().await;
    assert_eq!(uploaded.len(), 1);
    assert_eq!(uploaded[0].facts.messages[0].vendor_session_id, "new");
    assert_eq!(
        uploaded[0].facts.messages[0].normalized_git_remote,
        "github.com/acme/renamed"
    );
}

#[tokio::test]
async fn detached_head_pins_no_live_branch_and_transcript_branch_still_wins() {
    for branch in [None, Some("recorded-branch")] {
        let harness = SessionGitHarness::new().await;
        git(&harness.repo, &["checkout", "--detach", "HEAD"]);
        harness.append("session", 1, branch);
        let first = harness.sync().await;
        assert_eq!(first[0].facts.messages[0].git_branch, branch.unwrap_or(""));
        let store = collector_sync::CursorStore::open(
            crate::connection::Paths::at(harness.state.path().to_path_buf()).cursor_db("org_1"),
            "org_1",
        )
        .unwrap();
        let pin = store
            .session_git(
                collector_contracts::AgentSource::Claude,
                harness.transcript("session").to_str().unwrap(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(pin.git_branch, None);
        git(&harness.repo, &["checkout", "-b", "later-branch"]);
        harness.append("session", 2, branch);
        let later = harness.sync().await;
        assert_eq!(later[0].facts.messages[0], first[0].facts.messages[0]);
        assert!(later[0]
            .facts
            .messages
            .iter()
            .all(|message| message.git_branch == branch.unwrap_or("")));
    }
}

#[tokio::test]
async fn ac3_branch_switch_keeps_existing_facts_and_transcript_branch_wins() {
    for branch in [Some("recorded-branch"), None] {
        let harness = SessionGitHarness::new().await;
        harness.append("session", 1, branch);
        harness.append("session", 2, branch);
        let first = harness.sync().await;
        assert!(first[0]
            .facts
            .messages
            .iter()
            .all(|message| message.git_branch == branch.unwrap_or("main")));
        git(&harness.repo, &["checkout", "-b", "later-branch"]);
        harness.append("session", 3, branch);
        let second = harness.sync().await;
        assert_eq!(second[0].facts.messages.len(), 2);
        assert_eq!(second[0].facts.messages[0], first[0].facts.messages[0]);
        assert_eq!(
            second[0].facts.messages[1].git_branch,
            branch.unwrap_or("main")
        );
    }
}

#[tokio::test]
async fn ac4_unresolved_cwd_retries_then_deleted_worktree_retains_pin() {
    let harness = SessionGitHarness::new().await;
    std::fs::remove_dir_all(&harness.repo).unwrap();
    harness.append("session", 1, None);
    assert_eq!(
        harness.sync().await[0].facts.messages[0].normalized_git_remote,
        ""
    );
    std::fs::create_dir(&harness.repo).unwrap();
    harness.append("session", 2, None);
    assert_eq!(
        harness.sync().await[0].facts.messages[0].normalized_git_remote,
        ""
    );
    init_repo(&harness.repo);
    harness.append("session", 3, None);
    let pinned = harness.sync().await;
    assert_eq!(
        pinned[0].facts.messages[0].normalized_git_remote,
        "github.com/acme/original"
    );
    std::fs::remove_dir_all(&harness.repo).unwrap();
    harness.append("session", 4, None);
    let after_delete = harness.sync().await;
    assert_eq!(after_delete[0].facts.messages.len(), 2);
    assert_eq!(
        after_delete[0].facts.messages[0],
        pinned[0].facts.messages[0]
    );
    assert_eq!(
        after_delete[0].facts.messages[1].normalized_git_remote,
        "github.com/acme/original"
    );
}

#[tokio::test]
async fn ac6_absolute_paths_never_leave_collector_in_uploaded_envelopes() {
    let harness = SessionGitHarness::new().await;
    harness.append("session", 1, None);
    let path = harness.transcript("session");
    let git_root = PathBuf::from(git(&harness.repo, &["rev-parse", "--show-toplevel"]));
    let tool_path = git_root.join("src/lib.rs");
    let record = json!({
        "type":"assistant", "sessionId":"session", "uuid":"tool-message", "cwd":harness.repo,
        "message":{"id":"tool-message", "role":"assistant", "content":[{
            "type":"tool_use", "id":"read-1", "name":"Read", "input":{"file_path":tool_path}
        }]}
    });
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap(),
        "{record}"
    )
    .unwrap();
    let uploaded = harness.sync().await;
    assert_eq!(
        uploaded[0].facts.file_events[0].normalized_repo_path,
        "src/lib.rs"
    );
    let wire = serde_json::to_string(&uploaded).unwrap();
    for private_path in [
        harness.home.path().to_path_buf(),
        harness.home.path().canonicalize().unwrap(),
        harness.state.path().to_path_buf(),
        harness.state.path().canonicalize().unwrap(),
        git_root.clone(),
        tool_path,
    ] {
        let raw = private_path.to_str().unwrap();
        let escaped = serde_json::to_string(raw).unwrap();
        assert!(!wire.contains(raw), "raw absolute path leaked");
        assert!(
            !wire.contains(&escaped[1..escaped.len() - 1]),
            "JSON-escaped absolute path leaked"
        );
    }
    assert!(!wire.contains("repo_root"));
    let store = collector_sync::CursorStore::open(
        crate::connection::Paths::at(harness.state.path().to_path_buf()).cursor_db("org_1"),
        "org_1",
    )
    .unwrap();
    let pin = store
        .session_git(
            collector_contracts::AgentSource::Claude,
            path.to_str().unwrap(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(pin.repo_root, git_root.to_str().unwrap());
    assert_eq!(
        git_root.canonicalize().unwrap(),
        harness.repo.canonicalize().unwrap()
    );
    assert!(!wire.contains("file_path\":\"/"));
}

#[tokio::test]
async fn codex_pins_live_fallback_and_keeps_embedded_git_precedence() {
    let harness = SessionGitHarness::new().await;
    for embedded in [false, true] {
        let session = if embedded { "embedded" } else { "fallback" };
        harness.append_codex(session, 1, embedded);
        harness.append_codex(session, 2, embedded);
    }
    let first = harness.sync().await;
    assert_eq!(
        first
            .iter()
            .map(|upload| upload.facts.messages.len())
            .sum::<usize>(),
        4
    );
    git(
        &harness.repo,
        &[
            "remote",
            "set-url",
            "origin",
            "https://github.com/acme/later.git",
        ],
    );
    git(&harness.repo, &["checkout", "-b", "later-branch"]);
    for embedded in [false, true] {
        harness.append_codex(if embedded { "embedded" } else { "fallback" }, 3, embedded);
    }
    let second = harness.sync().await;
    let messages: Vec<_> = second
        .iter()
        .flat_map(|upload| &upload.facts.messages)
        .collect();
    assert_eq!(
        messages.len(),
        4,
        "each session sends only its new and attribution messages"
    );
    for message in messages {
        let (remote, branch, sha) = if message.vendor_session_id == "embedded" {
            (
                "github.com/acme/embedded",
                "embedded-branch",
                "recorded-sha",
            )
        } else {
            ("github.com/acme/original", "main", "")
        };
        assert_eq!(message.normalized_git_remote, remote);
        assert_eq!(message.git_branch, branch);
        assert_eq!(message.git_head_sha, sha);
        if let Some(original) = first
            .iter()
            .flat_map(|upload| &upload.facts.messages)
            .find(|old| {
                old.vendor_session_id == message.vendor_session_id
                    && old.turn_index == message.turn_index
            })
        {
            assert_eq!(message, original);
        }
    }
}

#[tokio::test]
async fn failed_probe_defers_upload_and_retries_unchanged_transcript() {
    let harness = SessionGitHarness::new().await;
    // Keep a prior complete watermark to prove a failed pass cannot age this file out.
    harness.sync().await;
    harness.append("retry", 1, None);
    harness.append("retry", 2, None);
    let root = PathBuf::from(git(&harness.repo, &["rev-parse", "--show-toplevel"]));
    let record = json!({
        "type":"assistant", "sessionId":"retry", "uuid":"retry-3", "cwd":harness.repo,
        "message":{"id":"retry-3", "role":"assistant", "content":[{
            "type":"tool_use", "id":"read-retry", "name":"Read", "input":{"file_path":root.join("src/lib.rs")}
        }]}
    });
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(harness.transcript("retry"))
            .unwrap(),
        "{record}"
    )
    .unwrap();
    let config = harness.repo.join(".git").join("config");
    let original = std::fs::read(&config).unwrap();
    let mut broken = original.clone();
    broken.extend_from_slice(b"\n[remote \"origin\"]\n url = https://github.com/acme/\xff.git\n");
    std::fs::write(&config, broken).unwrap();
    // Git accepts this config; only the remote probe produces invalid UTF-8.
    assert_eq!(
        git(&harness.repo, &["symbolic-ref", "--short", "-q", "HEAD"]),
        "main"
    );
    let now = 1_779_840_000_000;
    let first = run_fact_sync(
        harness.home.path(),
        harness.state.path(),
        harness.ingest_url.clone(),
        false,
        now + 86_400_000,
    )
    .await;
    assert!(
        harness.uploads.lock().unwrap().is_empty(),
        "a failed probe must upload nothing: {first:?}"
    );
    let report = &first
        .reports
        .iter()
        .find(|(source, _)| *source == collector_contracts::AgentSource::Claude)
        .unwrap()
        .1;
    assert!(!report.is_complete());
    assert_eq!(report.failed, 1);
    let error = report.first_error.as_deref().unwrap();
    assert!(error.contains("git config returned invalid UTF-8"));
    assert!(!error.contains(harness.repo.to_str().unwrap()));
    assert!(!error.contains("https://"));
    let store = collector_sync::CursorStore::open(
        crate::connection::Paths::at(harness.state.path().to_path_buf()).cursor_db("org_1"),
        "org_1",
    )
    .unwrap();
    let path = harness.transcript("retry");
    assert_eq!(store.last_complete_sync_at_ms().unwrap(), Some(now));
    assert!(store
        .session_git(
            collector_contracts::AgentSource::Claude,
            path.to_str().unwrap()
        )
        .unwrap()
        .is_none());
    assert!(store
        .get(
            collector_contracts::AgentSource::Claude,
            path.to_str().unwrap()
        )
        .unwrap()
        .is_none());
    std::fs::write(&config, original).unwrap();
    // Do not append or touch the transcript before recovery.
    let recovered = harness.sync().await;
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].facts.messages.len(), 3);
    assert_eq!(
        recovered[0].facts.file_events[0].normalized_repo_path,
        "src/lib.rs"
    );
    assert!(recovered[0]
        .facts
        .messages
        .iter()
        .all(|m| m.normalized_git_remote == "github.com/acme/original"));
    assert_eq!(
        store
            .session_git(
                collector_contracts::AgentSource::Claude,
                path.to_str().unwrap()
            )
            .unwrap()
            .unwrap()
            .normalized_git_remote,
        "github.com/acme/original"
    );
    assert!(
        harness.sync().await.is_empty(),
        "the unchanged transcript uploads only once"
    );
}

#[tokio::test]
async fn legitimate_git_absence_uploads_without_pinning_or_deferring() {
    for case in ["deleted_cwd", "non_repo", "missing_cwd"] {
        let harness = SessionGitHarness::new().await;
        harness.append(case, 1, None);
        match case {
            "deleted_cwd" => std::fs::remove_dir_all(&harness.repo).unwrap(),
            "non_repo" => std::fs::remove_dir_all(harness.repo.join(".git")).unwrap(),
            "missing_cwd" => {
                let path = harness.transcript(case);
                let mut record: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
                record.as_object_mut().unwrap().remove("cwd");
                std::fs::write(path, format!("{record}\n")).unwrap();
            }
            _ => unreachable!(),
        }
        let uploaded = harness.sync().await;
        assert_eq!(uploaded.len(), 1, "{case}");
        assert_eq!(
            uploaded[0].facts.messages[0].normalized_git_remote, "",
            "{case}"
        );
        let store = collector_sync::CursorStore::open(
            crate::connection::Paths::at(harness.state.path().to_path_buf()).cursor_db("org_1"),
            "org_1",
        )
        .unwrap();
        let path = harness.transcript(case);
        assert!(
            store
                .session_git(
                    collector_contracts::AgentSource::Claude,
                    path.to_str().unwrap()
                )
                .unwrap()
                .is_none(),
            "{case}"
        );
        assert!(
            store
                .get(
                    collector_contracts::AgentSource::Claude,
                    path.to_str().unwrap()
                )
                .unwrap()
                .is_some(),
            "{case}"
        );
        assert!(harness.sync().await.is_empty(), "{case}");
    }
}
