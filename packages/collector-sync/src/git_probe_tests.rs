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
            Err(())
        } else {
            run_git(cwd, args, absent_exit).await
        }
    })
    .await;
    let cache = GitRemoteCache::new();
    cache.freeze(cwd, partial);
    let store = CursorStore::open_in_memory("org").unwrap();
    store
        .resolve_session_git(AgentSource::Claude, "session.jsonl", Some(cwd), &cache)
        .await
        .unwrap();
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
            .git_branch
            .as_deref(),
        Some("main")
    );
    assert_eq!(
        run_git(cwd, &["config", "--invalid-option"], Some(1)).await,
        Err(())
    );
    assert_eq!(
        run_git(
            &format!("{cwd}/missing"),
            &["rev-parse", "--show-toplevel"],
            None
        )
        .await,
        Err(())
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
    assert_eq!(resolve_git_metadata(cwd).await.unwrap().git_branch, None);
}
