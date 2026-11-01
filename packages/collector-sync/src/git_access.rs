//! Git reports repository metadata it cannot read exactly like metadata that does not exist: "not
//! a git repository", or for a linked worktree "gitfile does not point to a valid repository". Only
//! missing metadata is legitimate absence. Treating an unreadable `.git` (wrong owner, chmod, or a
//! macOS privacy block) as absence would upload the session unattributed and never retry it once
//! access returns, so the root probe checks for permission errors before accepting absence.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// True when a `.git` entry that git would consider while discovering from `cwd` hides what git's
/// repository check reads (`HEAD`, `objects`, `refs`) behind a permission error.
pub(crate) fn repository_metadata_unreadable(cwd: &Path) -> bool {
    cwd.ancestors().any(|dir| match named_git_dir(dir) {
        Ok(Some(git_dir)) => git_dir_unreadable(&git_dir),
        Ok(None) => false,
        Err(error) => error.kind() == ErrorKind::PermissionDenied,
    })
}

/// The directory `dir/.git` names: itself, or a gitfile's `gitdir:` target relative to `dir`.
fn named_git_dir(dir: &Path) -> std::io::Result<Option<PathBuf>> {
    let entry = dir.join(".git");
    let metadata = match std::fs::metadata(&entry) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        other => other?,
    };
    if metadata.is_dir() {
        return Ok(Some(entry));
    }
    let gitfile = std::fs::read_to_string(&entry)?;
    Ok(gitfile
        .strip_prefix("gitdir:")
        .map(str::trim)
        .filter(|target| !target.is_empty())
        .map(|target| dir.join(target)))
}

fn git_dir_unreadable(git_dir: &Path) -> bool {
    // A linked worktree keeps `objects` and `refs` in the main repository's directory.
    let common_dir = match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(relative) => git_dir.join(relative.trim()),
        Err(error) if error.kind() == ErrorKind::PermissionDenied => return true,
        Err(_) => git_dir.to_path_buf(),
    };
    [
        std::fs::File::open(git_dir.join("HEAD")).map(drop),
        // Git needs search permission on these; resolving `<dir>/.` fails exactly when it is missing.
        std::fs::metadata(common_dir.join("objects").join(".")).map(drop),
        std::fs::metadata(common_dir.join("refs").join(".")).map(drop),
    ]
    .into_iter()
    .any(|probe| matches!(probe, Err(error) if error.kind() == ErrorKind::PermissionDenied))
}

#[cfg(all(test, unix))]
mod tests {
    use crate::git::{resolve_git_metadata, GitProbeError};
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    fn git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    #[tokio::test]
    async fn unreadable_repository_metadata_is_a_retryable_failure_not_absence() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path().join("repo");
        let worktree = root.path().join("worktree");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "Initial",
            ],
        );
        git(
            &repo,
            &["worktree", "add", "-q", worktree.to_str().unwrap()],
        );
        let git_dir = repo.join(".git");

        for (cwd, locked) in [
            (&repo, git_dir.clone()),
            (&repo, git_dir.join("HEAD")),
            (&repo, git_dir.join("objects")),
            (&repo, git_dir.join("refs")),
            (&worktree, git_dir.clone()),
        ] {
            let original = std::fs::metadata(&locked).unwrap().permissions();
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
            // Root ignores permission bits, so nothing is unreadable there.
            let enforced = std::fs::File::open(&locked).is_err();
            let resolution = resolve_git_metadata(cwd.to_str().unwrap()).await;
            std::fs::set_permissions(&locked, original).unwrap();
            if enforced {
                assert_eq!(
                    resolution,
                    Err(GitProbeError::MetadataUnreadable),
                    "{locked:?}"
                );
            }
            assert!(resolve_git_metadata(cwd.to_str().unwrap())
                .await
                .unwrap()
                .is_some());
        }
    }
}
