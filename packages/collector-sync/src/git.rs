// SPDX-License-Identifier: MIT
// `resolve_git_metadata` is vendored and refactored from otto-sync/src/git.rs (~/src/otto,
// 2026-05-25). The `cwd -> GitMetadata` freeze cache is original Trace Flow code: otto re-resolved
// the remote on every call, which lets a mid-run `git remote set-url` silently re-attribute a
// session. Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Git remote resolution with a **freeze cache**.
//!
//! A session's repo attribution must be stable for the whole sync run. The first time a `cwd` is
//! seen, [`GitRemoteCache`] resolves its git root / remote / branch and **freezes** the result;
//! every later lookup returns the frozen value without shelling out again. A `cwd` that is not a git
//! repo freezes as `None`, so non-repo directories are probed at most once too. The frozen value is
//! the *first* observed one — a later remote change does not overwrite it — which is the whole point:
//! one canonical remote per `cwd` per run (ADR "Repo and pull request attribution").

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

/// The frozen git facts for one working directory. Remote/branch are `None` when git reports none
/// (no `origin`, or a detached `HEAD`); `git_root` is always present when the directory is a repo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitMetadata {
    pub git_root: String,
    pub git_remote_url: Option<String>,
    pub git_branch: Option<String>,
}

/// Process-lifetime `cwd -> Option<GitMetadata>` freeze cache. `Some(None)` distinguishes "frozen as
/// not-a-repo" from "never probed", so a non-repo `cwd` is shelled out for exactly once.
#[derive(Debug, Default)]
pub struct GitRemoteCache {
    frozen: Mutex<HashMap<String, Option<GitMetadata>>>,
}

impl GitRemoteCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Return `cwd`'s frozen metadata, resolving + freezing it on first sight. Subsequent calls for
    /// the same `cwd` never shell out again.
    ///
    /// The lock is dropped before the `await` (a `std::sync::Mutex` guard must never cross one). That
    /// opens a benign TOCTOU window: two concurrent first-time callers for the same `cwd` both miss
    /// `peek` and both shell out, but `freeze` is first-writer-wins, so they converge on one frozen
    /// value and the duplicate `git` spawn is the only cost. Fine while the orchestrator syncs one
    /// job at a time; revisit if it ever dispatches concurrent resolves for the same `cwd`.
    pub async fn resolve(&self, cwd: &str) -> Option<GitMetadata> {
        if let Some(frozen) = self.peek(cwd) {
            return frozen;
        }
        let resolved = resolve_git_metadata(cwd).await;
        self.freeze(cwd, resolved)
    }

    /// `Some(frozen)` if `cwd` has been resolved (the inner `Option` is the metadata, `None` for a
    /// non-repo), or `None` if it has never been probed.
    fn peek(&self, cwd: &str) -> Option<Option<GitMetadata>> {
        self.frozen.lock().unwrap().get(cwd).cloned()
    }

    /// Insert-once: freezes `value` for `cwd` if unset and returns whatever is now frozen. A second
    /// `freeze` for the same `cwd` is a no-op and returns the original (first-writer-wins).
    fn freeze(&self, cwd: &str, value: Option<GitMetadata>) -> Option<GitMetadata> {
        self.frozen
            .lock()
            .unwrap()
            .entry(cwd.to_string())
            .or_insert(value)
            .clone()
    }
}

/// Shell out to `git` to read a `cwd`'s root, branch, and `origin` URL. Returns `None` when the
/// directory is not inside a worktree (no `--show-toplevel`). Integration-tested at 3d against a real
/// repo; the freeze cache above is what the 3b unit tests cover.
pub async fn resolve_git_metadata(cwd: &str) -> Option<GitMetadata> {
    let (root, branch, remote) = tokio::join!(
        run_git(cwd, &["rev-parse", "--show-toplevel"]),
        run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]),
        run_git(cwd, &["config", "--get", "remote.origin.url"]),
    );
    // `--show-toplevel` only succeeds inside a worktree and prints an existing canonical path, so its
    // presence is the repo test; no extra `stat` is warranted (and a blocking one in async would be
    // wrong here).
    let root = root?;
    Some(GitMetadata {
        git_root: root,
        git_remote_url: remote,
        // A detached HEAD reports the literal "HEAD"; treat that as no branch.
        git_branch: branch.filter(|b| b != "HEAD"),
    })
}

/// Run one `git` probe in `cwd`, returning its trimmed stdout or `None`. Every failure mode — missing
/// `cwd`, non-zero exit, non-UTF-8 output, empty output — collapses to `None`, which the caller reads
/// as "this field is absent" (and an absent `--show-toplevel` as "not a repo"). That coarse signal is
/// all repo attribution needs; per-failure diagnostics belong to the 3d end-to-end run, not here.
async fn run_git(cwd: &str, args: &[&str]) -> Option<String> {
    // These probes are local config/HEAD reads that finish in milliseconds. The deadline exists only so
    // a wedged `git` (a credential prompt on a misconfigured remote, a stuck filesystem) can't stall the
    // whole sync cycle; a timeout collapses to `None` like every other failure mode.
    let output = timeout(
        Duration::from_secs(5),
        Command::new("git").current_dir(cwd).args(args).output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(remote: &str) -> GitMetadata {
        GitMetadata {
            git_root: "/work/repo".to_string(),
            git_remote_url: Some(remote.to_string()),
            git_branch: Some("main".to_string()),
        }
    }

    #[test]
    fn peek_misses_before_resolve_and_hits_after_freeze() {
        let cache = GitRemoteCache::new();
        assert_eq!(cache.peek("/work/repo"), None);
        cache.freeze("/work/repo", Some(meta("git@github.com:acme/repo.git")));
        assert_eq!(
            cache.peek("/work/repo"),
            Some(Some(meta("git@github.com:acme/repo.git")))
        );
    }

    #[test]
    fn freeze_is_first_writer_wins_so_a_later_remote_change_is_ignored() {
        let cache = GitRemoteCache::new();
        let first = cache.freeze("/work/repo", Some(meta("git@github.com:acme/repo.git")));
        // Simulate a mid-run `git remote set-url`: the cache must keep the first frozen value.
        let second = cache.freeze("/work/repo", Some(meta("git@github.com:evil/fork.git")));
        assert_eq!(first, Some(meta("git@github.com:acme/repo.git")));
        assert_eq!(second, first);
        assert_eq!(
            cache.peek("/work/repo"),
            Some(Some(meta("git@github.com:acme/repo.git")))
        );
    }

    #[test]
    fn non_repo_cwd_freezes_as_none_so_it_is_probed_at_most_once() {
        let cache = GitRemoteCache::new();
        assert_eq!(cache.freeze("/tmp/not-a-repo", None), None);
        // Frozen as `Some(None)` — a cache hit that yields no metadata, not a miss that re-probes.
        assert_eq!(cache.peek("/tmp/not-a-repo"), Some(None));
    }

    #[test]
    fn distinct_cwds_freeze_independently() {
        let cache = GitRemoteCache::new();
        cache.freeze("/work/a", Some(meta("git@github.com:acme/a.git")));
        cache.freeze("/work/b", Some(meta("git@github.com:acme/b.git")));
        assert_eq!(
            cache.peek("/work/a"),
            Some(Some(meta("git@github.com:acme/a.git")))
        );
        assert_eq!(
            cache.peek("/work/b"),
            Some(Some(meta("git@github.com:acme/b.git")))
        );
    }
}
