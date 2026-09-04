// SPDX-License-Identifier: Apache-2.0
// Vendored and refactored from otto-common/src/paths.rs (~/src/otto, 2026-05-25).
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

use std::path::PathBuf;

use anyhow::{anyhow, Result};

pub fn home_dir() -> Result<PathBuf> {
    dirs::home_dir().ok_or_else(|| anyhow!("could not determine home directory"))
}

/// Expands a leading `~` to the home directory; leaves every other path unchanged.
///
/// Tilde expansion is Unix-only — on Windows a `~`-prefixed path is returned verbatim. This does no
/// canonicalization or traversal checks: `expand_home("~/../etc")` keeps the `..` components, so a
/// caller that feeds this untrusted input must validate the result before touching the filesystem.
pub fn expand_home(path: &str) -> Result<PathBuf> {
    if cfg!(unix) {
        if path == "~" {
            return home_dir();
        }
        if let Some(rest) = path.strip_prefix("~/") {
            return Ok(home_dir()?.join(rest));
        }
    }
    Ok(PathBuf::from(path))
}

/// Root directory where Claude Code stores project transcript JSONL files.
pub fn claude_projects_dir() -> Result<PathBuf> {
    Ok(home_dir()?.join(".claude").join("projects"))
}

/// Root directory where Codex CLI stores transcript files.
pub fn codex_transcripts_dir() -> Result<PathBuf> {
    Ok(home_dir()?.join(".codex").join("transcripts"))
}

/// macOS Cursor application-support root. Cursor stores `state.vscdb` under
/// `User/workspaceStorage/<hash>/state.vscdb` beneath this directory.
///
/// Cursor uses SQLite (`state.vscdb`) rather than flat JSONL — callers must
/// open the DB read-only and use a `GLOB` prefix scan on `cursorDiskKV` keys
/// (`composerData:*`, `bubbleId:*`). Direct iteration over `~/.cursor/projects`
/// JSONL (the Otto pattern) targets an old layout that Cursor dropped.
#[cfg(target_os = "macos")]
pub fn cursor_app_support_dir() -> Result<PathBuf> {
    Ok(home_dir()?
        .join("Library")
        .join("Application Support")
        .join("Cursor"))
}

/// Resolves the `workspaceStorage` directory under the Cursor app-support root.
/// Each subdirectory contains a `state.vscdb` with session data.
#[cfg(target_os = "macos")]
pub fn cursor_workspace_storage_dir() -> Result<PathBuf> {
    Ok(cursor_app_support_dir()?
        .join("User")
        .join("workspaceStorage"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_absolute_path() {
        let result = expand_home("/tmp/foo").unwrap();
        assert_eq!(result, PathBuf::from("/tmp/foo"));
    }

    // These assert the join logic against the real `home_dir()` rather than mutating the
    // process-wide `HOME` env var. Env mutation would force `unsafe` (edition 2024) and a
    // serialization lock to avoid racing other tests; resolving against `home_dir()` is
    // deterministic, parallel-safe, and exercises the same path-composition the callers rely on.
    #[cfg(unix)]
    mod tilde {
        use super::super::*;

        #[test]
        fn tilde_alone_returns_home() {
            assert_eq!(expand_home("~").unwrap(), home_dir().unwrap());
        }

        #[test]
        fn tilde_slash_joins_home() {
            assert_eq!(
                expand_home("~/.claude/projects").unwrap(),
                home_dir().unwrap().join(".claude/projects")
            );
        }

        #[test]
        fn claude_projects_dir_is_under_home() {
            assert_eq!(
                claude_projects_dir().unwrap(),
                home_dir().unwrap().join(".claude/projects")
            );
        }

        #[test]
        fn codex_transcripts_dir_is_under_home() {
            assert_eq!(
                codex_transcripts_dir().unwrap(),
                home_dir().unwrap().join(".codex/transcripts")
            );
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn cursor_workspace_storage_is_under_library() {
            assert_eq!(
                cursor_workspace_storage_dir().unwrap(),
                home_dir()
                    .unwrap()
                    .join("Library/Application Support/Cursor/User/workspaceStorage")
            );
        }
    }
}
