// SPDX-License-Identifier: Apache-2.0
// Adapted from otto-parser/src/parser/normalize.rs `normalize_agent_file_path` (~/src/otto,
// 2026-05-25). Reworked for Trace Flow's stricter rule: a stored file path is either repo-relative
// or the `outside_repo` sentinel — never the `~/`-prefixed fallback otto keeps, and never an
// absolute path, home directory, or username. This is a privacy guard (ADR "File facts store
// repo-relative paths only") and a worktree-correctness guard (the same file across worktrees
// aggregates as one row only when anchored to the session's own repo root).
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Repo-relative path normalization for `agent_file_event_facts`. `relativize_repo_path` is the single
//! gate every touched path passes before it becomes a fact field; anything it cannot prove sits
//! inside the session's repo root collapses to [`OUTSIDE_REPO`] rather than leaking a local path.

use std::path::Path;

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

    let root = PortablePath::parse(&repo_root.to_string_lossy());
    let path = PortablePath::parse(candidate);
    let resolved = if path.is_absolute() {
        if !root.is_absolute() {
            return OUTSIDE_REPO.to_string();
        }
        match strip_repo_root(&root, &path) {
            Some(rel) => rel,
            None => return OUTSIDE_REPO.to_string(),
        }
    } else {
        // A relative candidate is already repo-relative *if* it neither climbs out via `..` nor
        // carries a home marker. We can't anchor it to prove it, but we can refuse anything unsafe.
        match clean_relative(candidate, &path) {
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct PortablePath {
    anchor: PathAnchor,
    segments: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PathAnchor {
    Relative,
    PosixRoot,
    WindowsDrive(char),
    WindowsDriveRelative(char),
    WindowsUnc { server: String, share: String },
}

impl PortablePath {
    fn parse(raw: &str) -> Self {
        let raw = raw.trim();

        if let Some((server, share, rest)) = parse_unc(raw) {
            return Self {
                anchor: PathAnchor::WindowsUnc { server, share },
                segments: normalize_segments(rest, true),
            };
        }

        if let Some(drive) = windows_drive(raw) {
            let rest = &raw[2..];
            if starts_with_separator(rest) {
                return Self {
                    anchor: PathAnchor::WindowsDrive(drive),
                    segments: normalize_segments(rest, true),
                };
            }
            return Self {
                anchor: PathAnchor::WindowsDriveRelative(drive),
                segments: normalize_segments(rest, false),
            };
        }

        if starts_with_separator(raw) {
            return Self {
                anchor: PathAnchor::PosixRoot,
                segments: normalize_segments(raw, true),
            };
        }

        Self {
            anchor: PathAnchor::Relative,
            segments: normalize_segments(raw, false),
        }
    }

    fn is_absolute(&self) -> bool {
        matches!(
            self.anchor,
            PathAnchor::PosixRoot | PathAnchor::WindowsDrive(_) | PathAnchor::WindowsUnc { .. }
        )
    }
}

/// Lexically (no filesystem access — the file may be gone by parse time) strips `repo_root` from an
/// absolute `candidate`, returning the remainder as a `/`-joined string, or `None` when the candidate
/// is not under the root. The repo root itself collapses to `"."`.
fn strip_repo_root(repo_root: &PortablePath, candidate: &PortablePath) -> Option<String> {
    if !same_anchor(&repo_root.anchor, &candidate.anchor)
        || candidate.segments.len() < repo_root.segments.len()
    {
        return None;
    }

    if !candidate
        .segments
        .iter()
        .zip(&repo_root.segments)
        .all(|(candidate, root)| same_segment(&repo_root.anchor, root, candidate))
    {
        return None;
    }

    let rel = &candidate.segments[repo_root.segments.len()..];
    Some(if rel.is_empty() {
        ".".to_string()
    } else {
        rel.join("/")
    })
}

/// Cleans a relative candidate, returning `None` if it climbs above its base via a leading `..` or
/// carries a home marker we cannot anchor.
fn clean_relative(raw_input: &str, parsed_path: &PortablePath) -> Option<String> {
    if raw_input.starts_with('~')
        || raw_input.starts_with('$')
        || !matches!(parsed_path.anchor, PathAnchor::Relative)
    {
        return None;
    }
    // A normalized relative path that still leads with `..` escapes the repo root.
    if parsed_path.segments.first().is_some_and(|s| s == "..") {
        return None;
    }
    Some(if parsed_path.segments.is_empty() {
        ".".to_string()
    } else {
        parsed_path.segments.join("/")
    })
}

fn normalize_segments(input: &str, anchored: bool) -> Vec<String> {
    let mut out = Vec::new();
    for segment in input.split(is_separator) {
        match segment {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|last| last != "..") {
                    out.pop();
                } else if !anchored {
                    out.push("..".to_string());
                }
            }
            segment => out.push(segment.to_string()),
        }
    }
    out
}

fn parse_unc(raw: &str) -> Option<(String, String, &str)> {
    let rest = raw.strip_prefix(r"\\")?;
    let mut parts = rest.splitn(3, is_separator).filter(|part| !part.is_empty());
    let server = parts.next()?.to_ascii_lowercase();
    let share = parts.next()?.to_ascii_lowercase();
    let rest = parts.next().unwrap_or("");
    Some((server, share, rest))
}

fn windows_drive(raw: &str) -> Option<char> {
    let bytes = raw.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        Some((bytes[0] as char).to_ascii_lowercase())
    } else {
        None
    }
}

fn starts_with_separator(raw: &str) -> bool {
    raw.as_bytes()
        .first()
        .is_some_and(|byte| *byte == b'/' || *byte == b'\\')
}

fn is_separator(ch: char) -> bool {
    ch == '/' || ch == '\\'
}

fn same_anchor(a: &PathAnchor, b: &PathAnchor) -> bool {
    match (a, b) {
        (PathAnchor::Relative, PathAnchor::Relative) => true,
        (PathAnchor::PosixRoot, PathAnchor::PosixRoot) => true,
        (PathAnchor::WindowsDrive(left), PathAnchor::WindowsDrive(right)) => left == right,
        (
            PathAnchor::WindowsUnc {
                server: left_server,
                share: left_share,
            },
            PathAnchor::WindowsUnc {
                server: right_server,
                share: right_share,
            },
        ) => {
            left_server.eq_ignore_ascii_case(right_server)
                && left_share.eq_ignore_ascii_case(right_share)
        }
        _ => false,
    }
}

fn same_segment(anchor: &PathAnchor, left: &str, right: &str) -> bool {
    if matches!(
        anchor,
        PathAnchor::WindowsDrive(_) | PathAnchor::WindowsUnc { .. }
    ) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
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
    if starts_with_separator(s) {
        return false;
    }
    let parsed = PortablePath::parse(s);
    matches!(parsed.anchor, PathAnchor::Relative) && !parsed.segments.iter().any(|s| s == "..")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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
    fn windows_drive_path_inside_windows_repo_becomes_repo_relative() {
        assert_eq!(
            relativize_repo_path(
                Path::new(r"C:\Users\janedoe\code\trace-flow"),
                r"C:\Users\janedoe\code\trace-flow\src\main.rs"
            ),
            "src/main.rs"
        );
    }

    #[test]
    fn windows_drive_matching_is_case_insensitive() {
        assert_eq!(
            relativize_repo_path(
                Path::new(r"C:\Users\janedoe\Code\Trace-Flow"),
                r"c:\users\janedoe\code\trace-flow\SRC\main.rs"
            ),
            "SRC/main.rs"
        );
    }

    #[test]
    fn windows_drive_relative_path_does_not_leak() {
        let out = relativize_repo_path(&root(), r"C:Users\janedoe\repo\src\main.rs");
        assert_eq!(out, OUTSIDE_REPO);
        assert!(!out.contains("janedoe"));
    }

    #[test]
    fn windows_style_relative_path_is_normalized() {
        assert_eq!(
            relativize_repo_path(&root(), r"packages\collector-parser\src\paths.rs"),
            "packages/collector-parser/src/paths.rs"
        );
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
