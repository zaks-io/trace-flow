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
//! first non-empty remote, once. A failed probe without a pin defers assembly and keeps the file
//! cursor and complete-cycle watermark unchanged. The next cycle retries the unchanged transcript.
//!
//! Resolution classifies absence separately from failure:
//! - Missing/invalid cwd or git executable (`NotFound`/`NotADirectory`): no pin, sync proceeds.
//! - Root probe exit 128 with a C-locale not-a-repository message, including a dangling or
//!   malformed `.git` gitfile left by a pruned worktree: no repo, sync proceeds.
//! - Origin/branch exit 1: legitimate absent field, a resolved repo may be pinned.
//! - Timeout, other spawn/exit failures, invalid UTF-8 or empty root: retryable failure.
//! - Dubious ownership: retryable failure with an actionable diagnostic. Deferring visibly avoids
//!   silently replacing valid attribution; the user must fix repository trust outside the Collector.
//!
//! Exit 128 alone is insufficient: git uses it for both non-repos and real repo failures. Raw stderr
//! and remote output never enter errors, because either can contain private paths or credentials.

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

/// `Ok(Some(metadata))` is a repo, `Ok(None)` is legitimate absence, and `Err` is a failed probe.
/// Errors contain only fixed diagnostics, command names and exit codes, never git output.
pub type GitResolution = Result<Option<GitMetadata>, GitProbeError>;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GitProbeError {
    #[error("git is unavailable or the working directory no longer exists")]
    Unavailable,
    #[error("not a git repository")]
    NotRepository,
    #[error("git {command} timed out; retry on the next sync")]
    Timeout { command: String },
    #[error(
        "git {command} could not start ({kind:?}); check git installation and directory access"
    )]
    Spawn {
        command: String,
        kind: std::io::ErrorKind,
    },
    #[error("git {command} failed (exit {code:?}); check the repository with git status")]
    Exit { command: String, code: Option<i32> },
    #[error("git rejected dubious ownership; verify repository ownership and configure safe.directory for this checkout if trusted")]
    DubiousOwnership,
    #[error("git {command} returned invalid UTF-8; check repository metadata")]
    InvalidUtf8 { command: String },
    #[error("git returned an empty repository root; check the repository with git status")]
    EmptyRoot,
}

/// Per-cycle freeze cache preserves resolved, absent, and failed outcomes independently of misses.
#[derive(Debug, Default)]
pub struct GitRemoteCache {
    frozen: Mutex<HashMap<String, GitResolution>>,
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
    pub async fn resolve(&self, cwd: &str) -> GitResolution {
        if let Some(frozen) = self.peek(cwd) {
            return frozen;
        }
        let resolved = resolve_git_metadata(cwd).await;
        self.freeze(cwd, resolved)
    }

    /// `Some(outcome)` for a cache hit, or `None` if the cwd has never been probed.
    fn peek(&self, cwd: &str) -> Option<GitResolution> {
        self.frozen.lock().unwrap().get(cwd).cloned()
    }

    /// Insert-once: freezes `value` for `cwd` if unset and returns whatever is now frozen. A second
    /// `freeze` for the same `cwd` is a no-op and returns the original (first-writer-wins).
    fn freeze(&self, cwd: &str, value: GitResolution) -> GitResolution {
        self.frozen
            .lock()
            .unwrap()
            .entry(cwd.to_string())
            .or_insert(value)
            .clone()
    }
}

/// Read root, branch, and origin without conflating absence and failed probes.
pub async fn resolve_git_metadata(cwd: &str) -> GitResolution {
    resolve_git_metadata_with(|args, absent_exit| run_git(cwd, args, absent_exit)).await
}

async fn resolve_git_metadata_with<F, Fut>(probe: F) -> GitResolution
where
    F: Fn(&'static [&'static str], Option<i32>) -> Fut,
    Fut: std::future::Future<Output = Result<Option<String>, GitProbeError>>,
{
    // Establish absence first: a non-repo's branch probe also fails, but must not defer sync.
    let root = match probe(&["rev-parse", "--show-toplevel"], None).await {
        Err(GitProbeError::Unavailable | GitProbeError::NotRepository) => return Ok(None),
        other => other?.ok_or(GitProbeError::EmptyRoot)?,
    };
    let (branch, remote) = tokio::join!(
        probe(&["symbolic-ref", "--short", "-q", "HEAD"], Some(1)),
        probe(&["config", "--get", "remote.origin.url"], Some(1)),
    );
    Ok(Some(GitMetadata {
        git_root: root,
        git_remote_url: remote?,
        git_branch: branch?,
    }))
}

/// C-locale root-probe messages for a cwd with no usable repository. A pruned linked worktree keeps
/// a `.git` gitfile that points at deleted metadata, and git words that differently across versions
/// ("not a git repository: <path>" in older releases, "gitfile does not point to a valid
/// repository" in newer ones). No retry can repair it, so it is absence rather than a deferral that
/// would hold the session forever.
const NOT_A_REPOSITORY: [&str; 3] = [
    "fatal: not a git repository",
    "fatal: gitfile does not point to a valid repository",
    "fatal: invalid gitfile format",
];

async fn run_git(
    cwd: &str,
    args: &[&str],
    absent_exit: Option<i32>,
) -> Result<Option<String>, GitProbeError> {
    run_git_command(Command::new("git"), cwd, args, absent_exit).await
}

async fn run_git_command(
    mut command: Command,
    cwd: &str,
    args: &[&str],
    absent_exit: Option<i32>,
) -> Result<Option<String>, GitProbeError> {
    let name = args[0].to_string();
    let output = timeout(
        Duration::from_secs(5),
        command
            .current_dir(cwd)
            .env("LC_ALL", "C")
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| GitProbeError::Timeout {
        command: name.clone(),
    })?
    .map_err(|error| match error.kind() {
        // Windows reports a deleted cwd as NotADirectory, Unix as NotFound. Neither can resolve.
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => {
            GitProbeError::Unavailable
        }
        kind => GitProbeError::Spawn {
            command: name.clone(),
            kind,
        },
    })?;
    if !output.status.success() {
        if absent_exit.is_some() && output.status.code() == absent_exit {
            return Ok(None);
        }
        // C-locale git uses exit 128 for both absence and fatal repository errors.
        let stderr = String::from_utf8_lossy(&output.stderr);
        if args == ["rev-parse", "--show-toplevel"]
            && output.status.code() == Some(128)
            && NOT_A_REPOSITORY
                .iter()
                .any(|prefix| stderr.starts_with(prefix))
        {
            return Err(GitProbeError::NotRepository);
        }
        // Do not silently rewrite attribution or change user trust settings on persistent failures.
        if stderr.starts_with("fatal: detected dubious ownership in repository") {
            return Err(GitProbeError::DubiousOwnership);
        }
        return Err(GitProbeError::Exit {
            command: name,
            code: output.status.code(),
        });
    }
    let text = String::from_utf8(output.stdout)
        .map_err(|_| GitProbeError::InvalidUtf8 { command: name })?;
    let trimmed = text.trim();
    Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(remote: &str) -> GitResolution {
        Ok(Some(GitMetadata {
            git_root: "/work/repo".to_string(),
            git_remote_url: Some(remote.to_string()),
            git_branch: Some("main".to_string()),
        }))
    }

    #[test]
    fn freeze_preserves_all_outcomes_and_first_writer_wins() {
        let cache = GitRemoteCache::new();
        for (cwd, outcome) in [
            ("repo", meta("https://github.com/acme/repo.git")),
            ("absent", Ok(None)),
            ("failed", Err(GitProbeError::EmptyRoot)),
        ] {
            assert_eq!(cache.peek(cwd), None);
            assert_eq!(cache.freeze(cwd, outcome.clone()), outcome);
            assert_eq!(cache.freeze(cwd, meta("later")), outcome);
            assert_eq!(cache.peek(cwd), Some(outcome));
        }
    }
}

#[cfg(test)]
#[path = "git_probe_tests.rs"]
mod probe_tests;
