use super::*;
use crate::cursor::CursorStore;
use collector_contracts::AgentSource;

fn git(repo: &std::path::Path, args: &[&str]) -> std::process::Output {
    std::process::Command::new("git")
        .current_dir(repo)
        .args(args)
        .output()
        .unwrap()
}

async fn failed_probe_recovers(failed_command: &str) {
    let repo = tempfile::TempDir::new().unwrap();
    assert!(git(repo.path(), &["init", "-b", "main"]).status.success());
    assert!(git(
        repo.path(),
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/acme/repo.git"
        ]
    )
    .status
    .success());
    let cwd = repo.path().to_str().unwrap();
    let partial = resolve_git_metadata_with(|args, absent_exit| async move {
        if args[0] == failed_command {
            Err(GitProbeError::Exit {
                command: args[0].into(),
                code: Some(128),
            })
        } else {
            run_git(cwd, args, absent_exit).await
        }
    })
    .await;
    let cache = GitRemoteCache::new();
    let _ = cache.freeze(cwd, partial);
    let store = CursorStore::open_in_memory("org").unwrap();
    store
        .resolve_session_git(AgentSource::Claude, "session.jsonl", Some(cwd), &cache)
        .await
        .unwrap_err();
    assert_eq!(
        store
            .session_git(AgentSource::Claude, "session.jsonl")
            .unwrap(),
        None,
        "a failed {failed_command} probe must not write a pin"
    );

    let recovered = store
        .resolve_session_git(
            AgentSource::Claude,
            "session.jsonl",
            Some(cwd),
            &GitRemoteCache::new(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered.normalized_git_remote, "github.com/acme/repo");
    assert_eq!(recovered.git_branch.as_deref(), Some("main"));
    assert_eq!(
        store
            .session_git(AgentSource::Claude, "session.jsonl")
            .unwrap(),
        Some(recovered)
    );
}

#[tokio::test]
async fn remote_probe_failure_retries_without_pinning_partial_metadata() {
    failed_probe_recovers("config").await;
}

#[tokio::test]
async fn branch_probe_failure_retries_without_pinning_partial_metadata() {
    failed_probe_recovers("symbolic-ref").await;
}

#[tokio::test]
async fn git_exit_codes_distinguish_absence_from_failure_and_support_unborn_branches() {
    let repo = tempfile::TempDir::new().unwrap();
    assert!(git(repo.path(), &["init", "-b", "main"]).status.success());
    let cwd = repo.path().to_str().unwrap();
    assert_eq!(
        git(repo.path(), &["config", "--get", "remote.origin.url"])
            .status
            .code(),
        Some(1)
    );
    assert_eq!(
        run_git(cwd, &["config", "--get", "remote.origin.url"], Some(1)).await,
        Ok(None)
    );
    assert_eq!(
        run_git(cwd, &["symbolic-ref", "--short", "-q", "HEAD"], Some(1)).await,
        Ok(Some("main".into()))
    );
    assert_eq!(
        resolve_git_metadata(cwd)
            .await
            .unwrap()
            .unwrap()
            .git_branch
            .as_deref(),
        Some("main")
    );
    assert_eq!(
        run_git(cwd, &["config", "--invalid-option"], Some(1)).await,
        Err(GitProbeError::Exit {
            command: "config".into(),
            code: Some(129)
        })
    );
    assert_eq!(
        run_git(
            &format!("{cwd}/missing"),
            &["rev-parse", "--show-toplevel"],
            None
        )
        .await,
        Err(GitProbeError::Unavailable)
    );

    assert!(git(
        repo.path(),
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "Initial"
        ]
    )
    .status
    .success());
    assert!(git(repo.path(), &["checkout", "--detach", "HEAD"])
        .status
        .success());
    assert_eq!(
        git(repo.path(), &["symbolic-ref", "--short", "-q", "HEAD"])
            .status
            .code(),
        Some(1)
    );
    assert_eq!(
        run_git(cwd, &["symbolic-ref", "--short", "-q", "HEAD"], Some(1)).await,
        Ok(None)
    );
    assert_eq!(
        resolve_git_metadata(cwd).await.unwrap().unwrap().git_branch,
        None
    );
}

#[tokio::test]
async fn missing_git_binary_is_absence_and_does_not_defer_assembly() {
    let cwd = tempfile::TempDir::new().unwrap();
    let absent_binary = cwd.path().join("missing-git-executable");
    let resolution = resolve_git_metadata_with(|args, absent| {
        run_git_command(
            Command::new(&absent_binary),
            cwd.path().to_str().unwrap(),
            args,
            absent,
        )
    })
    .await;
    assert_eq!(resolution, Ok(None));
    let cache = GitRemoteCache::new();
    let _ = cache.freeze(cwd.path().to_str().unwrap(), resolution);
    let store = CursorStore::open_in_memory("org").unwrap();
    let bytes = serde_json::to_vec(&serde_json::json!({
        "type":"user", "sessionId":"session", "uuid":"one", "cwd":cwd.path(),
        "message":{"role":"user", "content":"Inspect"}
    }))
    .unwrap();
    let file = crate::DiscoveredFile {
        path: cwd.path().join("session.jsonl").to_str().unwrap().into(),
        size_bytes: bytes.len() as u64,
        mtime_ms: 1.0,
    };
    let unit =
        crate::assemble_sync_unit_from_bytes(&file, AgentSource::Claude, &cache, &store, &bytes)
            .await
            .unwrap();
    assert_eq!(unit.ctx.repo_root, "");
    assert_eq!(unit.ctx.normalized_git_remote, "");
    assert_eq!(
        store.session_git(AgentSource::Claude, &file.path).unwrap(),
        None
    );
}

#[tokio::test]
async fn persistent_dubious_ownership_failure_is_actionable_and_retryable() {
    let cwd = tempfile::TempDir::new().unwrap();
    assert!(git(cwd.path(), &["init", "-b", "main"]).status.success());
    let resolution = resolve_git_metadata_with(|args, absent| {
        let mut command = Command::new("git");
        // Git's test seam simulates foreign ownership without changing filesystem owners.
        command.env("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1");
        run_git_command(command, cwd.path().to_str().unwrap(), args, absent)
    })
    .await;
    assert_eq!(resolution, Err(GitProbeError::DubiousOwnership));
    let cache = GitRemoteCache::new();
    let _ = cache.freeze(cwd.path().to_str().unwrap(), resolution);
    let store = CursorStore::open_in_memory("org").unwrap();
    let error = store
        .resolve_session_git(AgentSource::Claude, "session", cwd.path().to_str(), &cache)
        .await
        .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
    assert!(error.to_string().contains("safe.directory"));
    assert!(!error.to_string().contains(cwd.path().to_str().unwrap()));
}

#[tokio::test]
async fn empty_remote_pin_survives_a_failed_probe_with_root_and_branch() {
    let cwd = tempfile::TempDir::new().unwrap();
    assert!(git(cwd.path(), &["init", "-b", "main"]).status.success());
    let store = CursorStore::open_in_memory("org").unwrap();
    let pin = store
        .resolve_session_git(
            AgentSource::Claude,
            "session",
            cwd.path().to_str(),
            &GitRemoteCache::new(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pin.normalized_git_remote, "");
    assert_eq!(pin.git_branch.as_deref(), Some("main"));
    let cache = GitRemoteCache::new();
    let _ = cache.freeze(
        cwd.path().to_str().unwrap(),
        Err(GitProbeError::Timeout {
            command: "config".into(),
        }),
    );
    assert_eq!(
        store
            .resolve_session_git(AgentSource::Claude, "session", cwd.path().to_str(), &cache)
            .await
            .unwrap(),
        Some(pin.clone())
    );
    assert_eq!(
        store.session_git(AgentSource::Claude, "session").unwrap(),
        Some(pin)
    );
}
