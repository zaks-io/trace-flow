// SPDX-License-Identifier: MIT
// Trace Flow Collector CLI: detected transcript sources.

//! Where each [`AgentSource`]'s local transcripts live, and which ones are present on this box.
//!
//! The sync engine (`collector-sync`) is root-agnostic: the embedder hands it a root to walk. This
//! module is that embedder's knowledge of *where* each Source writes — Claude under
//! `~/.claude/projects`, Codex under `~/.codex/sessions`, Cursor in its `state.vscdb` SQLite store under
//! globalStorage — and a presence check the `sources list` command renders. Cursor is `Ready`: the
//! Cursor reader (`collector_sync::assemble_cursor_units`) ingests its SQLite store directly, so it does
//! not have a `.jsonl` root the walker reads (`source_root` is `None`); its presence is the DB file
//! existing. We never print the absolute root (it carries `$HOME`/username); the UI shows a stable label.

use std::path::PathBuf;

use collector_contracts::AgentSource;

/// A Source the CLI can ingest, paired with where it reads. Every recognized Source is now wired into
/// the collector path (Claude/Codex via the JSONL walker, Cursor via the `state.vscdb` reader), so this
/// is a single `Ready` state; the enum is kept so `sources list` can render a support column and a future
/// not-yet-wired source has a home.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Support {
    /// Discoverable and ingestable today.
    Ready,
}

/// The detection state of one Source on this machine.
#[derive(Debug, Clone)]
pub struct DetectedSource {
    pub source: AgentSource,
    pub support: Support,
    /// Items found for the Source: `.jsonl` files under a transcript root for Claude/Codex, or `1`/`0`
    /// for whether Cursor's `state.vscdb` exists (counting its composers would mean opening a multi-GB
    /// DB, so presence is what `sources list` reports).
    pub file_count: usize,
}

impl DetectedSource {
    /// A short, $HOME-free label for display (e.g. `~/.claude/projects`), so `sources list` never
    /// prints an absolute home path.
    pub fn display_root(&self) -> &'static str {
        match self.source {
            AgentSource::Claude => "~/.claude/projects",
            AgentSource::Codex => "~/.codex/sessions",
            AgentSource::Cursor => "(Cursor state store)",
        }
    }
}

/// The transcript root for `source` under `home`, or `None` for a Source with no `.jsonl` root. Cursor
/// reads a SQLite store, not a `.jsonl` tree, so it has no walker root (see [`cursor_db_path`]).
pub fn source_root(home: &std::path::Path, source: AgentSource) -> Option<PathBuf> {
    match source {
        AgentSource::Claude => Some(home.join(".claude").join("projects")),
        AgentSource::Codex => Some(home.join(".codex").join("sessions")),
        AgentSource::Cursor => None,
    }
}

/// The Cursor `state.vscdb` path under `home`, or `None` on a platform where Cursor's global store is
/// not at the known macOS location. This single DB under globalStorage holds every composer (session)
/// and bubble (message); the per-workspace stores are not the v1 target.
pub fn cursor_db_path(home: &std::path::Path) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        Some(
            home.join("Library")
                .join("Application Support")
                .join("Cursor")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb"),
        )
    } else {
        // Linux/Windows Cursor store locations differ; wiring them is a follow-up. macOS is the v1 target.
        None
    }
}

/// The ingestable Sources, in display order. Cursor reads its SQLite store via the Cursor reader.
pub fn ingestable_sources() -> [AgentSource; 3] {
    [AgentSource::Claude, AgentSource::Codex, AgentSource::Cursor]
}

/// Detect every Source's state on this machine. Pure over an injected `home` so tests don't depend on
/// the real home dir; the `count` closure counts `.jsonl` files under a JSONL root, and `db_exists`
/// reports whether a path (Cursor's `state.vscdb`) is present.
pub fn detect_with<F, G>(
    home: &std::path::Path,
    mut count: F,
    mut db_exists: G,
) -> Vec<DetectedSource>
where
    F: FnMut(&std::path::Path) -> usize,
    G: FnMut(&std::path::Path) -> bool,
{
    let mut out = Vec::new();
    for source in ingestable_sources() {
        let file_count = match source_root(home, source) {
            Some(root) => count(&root),
            // No JSONL root: Cursor's presence is its DB existing (1) or not (0).
            None => cursor_db_path(home)
                .map(|db| usize::from(db_exists(&db)))
                .unwrap_or(0),
        };
        out.push(DetectedSource {
            source,
            support: Support::Ready,
            file_count,
        });
    }
    out
}

/// Detect against the real filesystem: count `.jsonl` files under each JSONL root, and check whether
/// Cursor's `state.vscdb` exists.
pub fn detect(home: &std::path::Path) -> Vec<DetectedSource> {
    detect_with(
        home,
        |root| collector_sync::walk_transcripts(root).len(),
        |db| db.exists(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn claude_and_codex_roots_are_under_home_and_cursor_has_no_jsonl_root() {
        let home = Path::new("/home/u");
        assert_eq!(
            source_root(home, AgentSource::Claude).unwrap(),
            Path::new("/home/u/.claude/projects")
        );
        assert_eq!(
            source_root(home, AgentSource::Codex).unwrap(),
            Path::new("/home/u/.codex/sessions")
        );
        // Cursor reads SQLite, not a JSONL tree, so it has no walker root.
        assert!(source_root(home, AgentSource::Cursor).is_none());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn cursor_db_path_points_at_global_storage_on_macos() {
        let db = cursor_db_path(Path::new("/Users/u")).unwrap();
        assert!(db.ends_with("Cursor/User/globalStorage/state.vscdb"));
    }

    #[test]
    fn detect_marks_every_source_ready_and_reports_cursor_by_db_presence() {
        let detected = detect_with(
            Path::new("/home/u"),
            |root| {
                if root.ends_with(".claude/projects") {
                    3
                } else {
                    0
                }
            },
            // Pretend Cursor's state.vscdb exists.
            |_db| true,
        );
        let claude = detected
            .iter()
            .find(|d| d.source == AgentSource::Claude)
            .unwrap();
        assert_eq!(claude.support, Support::Ready);
        assert_eq!(claude.file_count, 3);

        let cursor = detected
            .iter()
            .find(|d| d.source == AgentSource::Cursor)
            .unwrap();
        assert_eq!(cursor.support, Support::Ready);
        // On macOS the db path resolves and `db_exists` returned true → count 1; off macOS the path is
        // None → count 0. Either way Cursor is now a Ready source, never Unsupported.
        let expected = usize::from(cursor_db_path(Path::new("/home/u")).is_some());
        assert_eq!(cursor.file_count, expected);
    }

    #[test]
    fn display_root_never_leaks_home() {
        for source in [AgentSource::Claude, AgentSource::Codex, AgentSource::Cursor] {
            let d = DetectedSource {
                source,
                support: Support::Ready,
                file_count: 0,
            };
            assert!(!d.display_root().contains("Users"));
            assert!(!d.display_root().contains("secret"));
        }
    }
}
