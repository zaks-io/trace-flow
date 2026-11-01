// SPDX-License-Identifier: Apache-2.0
// `resolve_git_metadata` is vendored and refactored from otto-sync/src/git.rs (~/src/otto,
// 2026-05-25). The `cwd -> GitMetadata` freeze cache is original Trace Flow code: otto re-resolved
// the remote on every call, which lets a mid-run `git remote set-url` silently re-attribute a
// session. Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Live git resolution with a per-sync-cycle freeze cache.
//!
//! [`GitRemoteCache`] deduplicates probes for a cwd within one cycle, including unsuccessful probes.
//! Assembly first checks the durable `(source, transcript path)` pin in [`crate::cursor::CursorStore`].
//! A repo root creates a pin only when every probe succeeds or reports legitimate absence. Pins
//! with a non-empty remote bypass git even after a rename, branch switch, or worktree deletion.
//! Empty-remote pins keep their root and branch but retry live resolution until they adopt their
//! first non-empty remote, once. Failed probes retry with the next cycle's fresh cache.

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
/// directory is not inside a worktree or any probe fails. Incomplete metadata must not become a
/// durable session pin. Missing origin and detached HEAD are successful resolutions with absent fields.
pub async fn resolve_git_metadata(cwd: &str) -> Option<GitMetadata> {
    resolve_git_metadata_with(|args, absent_exit| run_git(cwd, args, absent_exit)).await
}

async fn resolve_git_metadata_with<F, Fut>(probe: F) -> Option<GitMetadata>
where
    F: Fn(&'static [&'static str], Option<i32>) -> Fut,
    Fut: std::future::Future<Output = Result<Option<String>, ()>>,
{
    let (root, branch, remote) = tokio::join!(
        probe(&["rev-parse", "--show-toplevel"], None),
        probe(&["symbolic-ref", "--short", "-q", "HEAD"], Some(1)),
        probe(&["config", "--get", "remote.origin.url"], Some(1)),
    );
    Some(GitMetadata {
        git_root: root.ok()??,
        git_remote_url: remote.ok()?,
        git_branch: branch.ok()?,
    })
}

/// Only the caller's documented absence exit code is accepted. Timeouts, spawn errors, unexpected
/// exits, and invalid UTF-8 fail the entire resolution so the next sync cycle can retry.
async fn run_git(cwd: &str, args: &[&str], absent_exit: Option<i32>) -> Result<Option<String>, ()> {
    let output = timeout(
        Duration::from_secs(5),
        Command::new("git")
            .current_dir(cwd)
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?;
    if !output.status.success() {
        return if absent_exit.is_some() && output.status.code() == absent_exit {
            Ok(None)
        } else {
            Err(())
        };
    }
    let text = String::from_utf8(output.stdout).map_err(|_| ())?;
    let trimmed = text.trim();
    Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
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

#[cfg(test)]
#[path = "git_probe_tests.rs"]
mod probe_tests;
