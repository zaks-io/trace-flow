// SPDX-License-Identifier: MIT
// Adapted from otto-parser/src/parser/normalize.rs `normalize_agent_file_path` (~/src/otto,
// 2026-05-25). Reworked for Trace Flow's stricter rule: a stored file path is either repo-relative
// or the `outside_repo` sentinel — never the `~/`-prefixed fallback otto keeps, and never an
// absolute path, home directory, or username. This is a privacy guard (ADR "File facts store
// repo-relative paths only") and a worktree-correctness guard (the same file across worktrees
// aggregates as one row only when anchored to the session's own repo root).
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Repo-relative path normalization for `agent_file_events`. `relativize_repo_path` is the single
//! gate every touched path passes before it becomes a fact field; anything it cannot prove sits
//! inside the session's repo root collapses to [`OUTSIDE_REPO`] rather than leaking a local path.

use std::path::{Component, Path, PathBuf};

/// Coarse category for a file touched outside the session's primary repo. The ADR forbids storing an
/// absolute local path, so anything we cannot prove is inside the repo becomes this constant.
pub const OUTSIDE_REPO: &str = "outside_repo";

/// Normalizes a path the agent touched into the form stored on an `AgentFileEventFact`.
///
/// Returns a forward-slash repo-relative path when `candidate` resolves inside `repo_root`, else
/// [`OUTSIDE_REPO`]. The result is guaranteed free of an absolute prefix, a `~`/`$HOME` home marker,
/// a drive letter, or a username component, so a relativization bug fails the 3a path canary instead
/// of leaking a local path at rest. `repo_root` is the session's resolved repo directory (the parser
/// supplies it); a non-absolute root cannot anchor an absolute candidate, so those collapse to
/// outside.
pub fn relativize_repo_path(repo_root: &Path, candidate: &str) -> String {
    let candidate = candidate.trim();
    if candidate.is_empty() {
        return OUTSIDE_REPO.to_string();
    }

    let path = Path::new(candidate);
    let resolved = if path.is_absolute() {
        if !repo_root.is_absolute() {
            return OUTSIDE_REPO.to_string();
        }
        match strip_repo_root(repo_root, path) {
            Some(rel) => rel,
            None => return OUTSIDE_REPO.to_string(),
        }
    } else {
        // A relative candidate is already repo-relative *if* it neither climbs out via `..` nor
        // carries a home marker. We can't anchor it to prove it, but we can refuse anything unsafe.
        match clean_relative(candidate, path) {
            Some(rel) => rel,
            None => return OUTSIDE_REPO.to_string(),
        }
    };

    if is_safe_relative(&resolved) {
        resolved
    } else {
        OUTSIDE_REPO.to_string()
    }
}

/// Lexically (no filesystem access — the file may be gone by parse time) strips `repo_root` from an
/// absolute `candidate`, returning the remainder as a `/`-joined string, or `None` when the candidate
/// is not under the root. The repo root itself collapses to `"."`.
fn strip_repo_root(repo_root: &Path, candidate: &Path) -> Option<String> {
    let root = lexical_normalize(repo_root);
    let cand = lexical_normalize(candidate);
    let rel = cand.strip_prefix(&root).ok()?;
    let joined = join_forward_slash(rel);
    Some(if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    })
}

/// Cleans a relative candidate, returning `None` if it climbs above its base via a leading `..` or
/// carries a home marker we cannot anchor.
fn clean_relative(raw_input: &str, parsed_path: &Path) -> Option<String> {
    if raw_input.starts_with('~') || raw_input.starts_with('$') {
        return None;
    }
    let norm = lexical_normalize(parsed_path);
    // A normalized relative path that still leads with `..` escapes the repo root.
    if norm.components().next() == Some(Component::ParentDir) {
        return None;
    }
    Some(join_forward_slash(&norm))
}

/// Resolves `.`/`..` segments without touching the filesystem. `..` cannot climb above a root or
/// prefix, so an absolute path stays anchored to its root.
fn lexical_normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => out.push(".."),
            },
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Joins a path's components with `/`, dropping any root or drive prefix so the output is never
/// absolute regardless of the host platform's native separator.
fn join_forward_slash(p: &Path) -> String {
    p.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            Component::ParentDir => Some("..".to_string()),
            Component::CurDir => Some(".".to_string()),
            Component::RootDir | Component::Prefix(_) => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Final guard: a stored path must be relative, climb-free, and carry no home/drive marker. Catches a
/// Windows-recorded absolute path parsed on a host whose native separator is `/` (so `is_absolute`
/// missed it), and any home marker that slipped through.
fn is_safe_relative(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    if s.starts_with('~') || s.starts_with('$') || s.starts_with('/') {
        return false;
    }
    // Windows drive prefix (e.g. `C:\Users\...`) on a `/`-separator host.
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return false;
    }
    let p = Path::new(s);
    if p.is_absolute() {
        return false;
    }
    !p.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from("/Users/janedoe/code/trace-flow")
    }

    #[test]
    fn file_inside_repo_becomes_repo_relative() {
        assert_eq!(
            relativize_repo_path(&root(), "/Users/janedoe/code/trace-flow/src/main.rs"),
            "src/main.rs"
        );
    }

    #[test]
    fn nested_file_keeps_full_relative_path() {
        assert_eq!(
            relativize_repo_path(
                &root(),
                "/Users/janedoe/code/trace-flow/packages/collector-parser/src/paths.rs"
            ),
            "packages/collector-parser/src/paths.rs"
        );
    }

    #[test]
    fn dotdot_inside_repo_is_resolved_not_escaped() {
        assert_eq!(
            relativize_repo_path(&root(), "/Users/janedoe/code/trace-flow/src/../README.md"),
            "README.md"
        );
    }

    #[test]
    fn repo_root_itself_collapses_to_dot() {
        assert_eq!(
            relativize_repo_path(&root(), "/Users/janedoe/code/trace-flow"),
            "."
        );
    }

    #[test]
    fn sibling_outside_repo_does_not_leak_the_home_path() {
        let out = relativize_repo_path(&root(), "/Users/janedoe/secrets/.env");
        assert_eq!(out, OUTSIDE_REPO);
        assert!(!out.contains("janedoe"));
        assert!(!out.contains("/Users/"));
    }

    #[test]
    fn unrelated_absolute_path_is_outside_repo() {
        assert_eq!(relativize_repo_path(&root(), "/etc/passwd"), OUTSIDE_REPO);
    }

    #[test]
    fn already_relative_clean_path_is_kept() {
        assert_eq!(relativize_repo_path(&root(), "src/lib.rs"), "src/lib.rs");
    }

    #[test]
    fn relative_path_escaping_with_dotdot_is_outside_repo() {
        assert_eq!(
            relativize_repo_path(&root(), "../other-repo/src/main.rs"),
            OUTSIDE_REPO
        );
    }

    #[test]
    fn tilde_and_home_var_paths_are_outside_repo() {
        assert_eq!(relativize_repo_path(&root(), "~/.ssh/id_rsa"), OUTSIDE_REPO);
        assert_eq!(
            relativize_repo_path(&root(), "$HOME/.aws/credentials"),
            OUTSIDE_REPO
        );
    }

    #[test]
    fn empty_candidate_is_outside_repo() {
        assert_eq!(relativize_repo_path(&root(), ""), OUTSIDE_REPO);
        assert_eq!(relativize_repo_path(&root(), "   "), OUTSIDE_REPO);
    }

    #[test]
    fn windows_drive_path_does_not_leak() {
        let out = relativize_repo_path(&root(), r"C:\Users\janedoe\repo\src\main.rs");
        assert_eq!(out, OUTSIDE_REPO);
        assert!(!out.contains("janedoe"));
    }

    #[test]
    fn an_absolute_candidate_cannot_anchor_to_a_relative_root() {
        assert_eq!(
            relativize_repo_path(Path::new("trace-flow"), "/Users/janedoe/x.rs"),
            OUTSIDE_REPO
        );
    }

    #[test]
    fn no_result_for_an_absolute_corpus_ever_contains_a_username() {
        let candidates = [
            "/Users/janedoe/code/trace-flow/src/main.rs",
            "/Users/janedoe/secrets/.env",
            "/etc/passwd",
            "/home/janedoe/code/trace-flow/x.rs",
            "~/janedoe/notes.txt",
            "$HOME/janedoe/.bashrc",
        ];
        for c in candidates {
            let out = relativize_repo_path(&root(), c);
            assert!(!out.contains("janedoe"), "{c} leaked username in {out:?}");
            assert!(
                !out.contains("/Users/"),
                "{c} leaked home prefix in {out:?}"
            );
            assert!(
                !out.starts_with('/'),
                "{c} produced an absolute path {out:?}"
            );
        }
    }
}
