// SPDX-License-Identifier: Apache-2.0

//! Durable git attribution for a source transcript. Pins contain only normalized remotes and local
//! repo roots, never raw remote URLs. Like cursors, pins are isolated by Organization. A successful
//! live repo resolution is insert-once; failed probes leave no row and can recover next sync cycle.

use collector_contracts::AgentSource;
use rusqlite::{params, OptionalExtension};

use crate::cursor::{source_key, CursorStore, CursorStoreError};
use crate::git::{GitMetadata, GitRemoteCache};
use crate::git_remote::normalize_git_remote;

pub(crate) const MIGRATION: &str = "CREATE TABLE IF NOT EXISTS session_git (
    org_id TEXT NOT NULL,
    source TEXT NOT NULL,
    file_path TEXT NOT NULL,
    repo_root TEXT NOT NULL CHECK (repo_root <> ''),
    normalized_git_remote TEXT NOT NULL,
    git_branch TEXT,
    PRIMARY KEY (org_id, source, file_path)
) WITHOUT ROWID;";

/// Resolved repo evidence. `repo_root` is local-only and anchors relative file paths; only the
/// normalized remote and optional branch may be copied to uploaded facts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionGit {
    pub repo_root: String,
    pub normalized_git_remote: String,
    pub git_branch: Option<String>,
}

impl From<GitMetadata> for SessionGit {
    fn from(meta: GitMetadata) -> Self {
        Self {
            repo_root: meta.git_root,
            normalized_git_remote: meta
                .git_remote_url
                .as_deref()
                .map(normalize_git_remote)
                .unwrap_or_default(),
            git_branch: meta.git_branch,
        }
    }
}

impl CursorStore {
    pub fn session_git(
        &self,
        source: AgentSource,
        file_path: &str,
    ) -> Result<Option<SessionGit>, CursorStoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT repo_root, normalized_git_remote, git_branch FROM session_git
             WHERE org_id=?1 AND source=?2 AND file_path=?3",
                params![self.org_id, source_key(source), file_path],
                |row| {
                    Ok(SessionGit {
                        repo_root: row.get(0)?,
                        normalized_git_remote: row.get(1)?,
                        git_branch: row.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    /// Reuse a pin before looking at cwd, so deleted worktrees never trigger another git probe.
    pub(crate) async fn resolve_session_git(
        &self,
        source: AgentSource,
        file_path: &str,
        cwd: Option<&str>,
        cache: &GitRemoteCache,
    ) -> Result<Option<SessionGit>, CursorStoreError> {
        if let Some(pinned) = self.session_git(source, file_path)? {
            return Ok(Some(pinned));
        }
        let Some(cwd) = cwd else {
            return Ok(None);
        };
        let Some(meta) = cache.resolve(cwd).await else {
            return Ok(None);
        };
        let resolved = SessionGit::from(meta);
        // Root presence is the success criterion, including repos with no remote or a detached HEAD.
        if resolved.repo_root.is_empty() {
            return Ok(None);
        }
        self.conn.execute(
            "INSERT INTO session_git (org_id, source, file_path, repo_root, normalized_git_remote, git_branch)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (org_id, source, file_path) DO NOTHING",
            params![self.org_id, source_key(source), file_path, resolved.repo_root, resolved.normalized_git_remote, resolved.git_branch],
        )?;
        // Return the first writer's evidence even if another store pinned this session meanwhile.
        self.session_git(source, file_path)
    }
}

#[cfg(test)]
#[path = "session_git_tests.rs"]
mod tests;
