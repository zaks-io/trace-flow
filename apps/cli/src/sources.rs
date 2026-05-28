// SPDX-License-Identifier: MIT
// Trace Flow Collector CLI: detected transcript sources.

//! Where each [`AgentSource`]'s local transcripts live, and which ones are present on this box.
//!
//! The sync engine (`collector-sync`) is root-agnostic: the embedder hands it a root to walk. This
//! module is that embedder's knowledge of *where* each Source writes — Claude under
//! `~/.claude/projects`, Codex under `~/.codex/sessions` — and a presence check the `sources list`
//! command renders. Cursor is deliberately listed `Unsupported`: its `state.vscdb` path is not a
//! `.jsonl` corpus the current walker reads, and Cursor support is gated behind TRA-108 (P7) until it
//! lands through the same path. We never print the absolute root (it carries `$HOME`/username); the
//! UI shows a stable label.

use std::path::PathBuf;

use collector_contracts::AgentSource;

/// A Source the CLI can ingest, paired with where it reads and whether it is wired up yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Support {
    /// Discoverable and ingestable today.
    Ready,
    /// Recognized Source, not yet wired into the collector path (Cursor → TRA-108).
    Unsupported,
}

/// The detection state of one Source on this machine.
#[derive(Debug, Clone)]
pub struct DetectedSource {
    pub source: AgentSource,
    pub support: Support,
    /// `.jsonl` files found beneath the Source's transcript root, or `0` when absent/unsupported.
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

/// The transcript root for `source` under `home`, or `None` for a Source with no `.jsonl` root yet.
pub fn source_root(home: &std::path::Path, source: AgentSource) -> Option<PathBuf> {
    match source {
        AgentSource::Claude => Some(home.join(".claude").join("projects")),
        AgentSource::Codex => Some(home.join(".codex").join("sessions")),
        // Cursor reads a SQLite store, not a .jsonl tree; the walker can't ingest it yet (TRA-108).
        AgentSource::Cursor => None,
    }
}

/// The two ingestable Sources, in display order. Cursor is reported separately as unsupported.
pub fn ingestable_sources() -> [AgentSource; 2] {
    [AgentSource::Claude, AgentSource::Codex]
}

/// Detect every Source's state on this machine. Pure over an injected `home` so tests don't depend on
/// the real home dir; the `count` closure lets tests avoid touching the filesystem.
pub fn detect_with<F>(home: &std::path::Path, mut count: F) -> Vec<DetectedSource>
where
    F: FnMut(&std::path::Path) -> usize,
{
    let mut out = Vec::new();
    for source in ingestable_sources() {
        let file_count = source_root(home, source)
            .as_deref()
            .map(&mut count)
            .unwrap_or(0);
        out.push(DetectedSource {
            source,
            support: Support::Ready,
            file_count,
        });
    }
    out.push(DetectedSource {
        source: AgentSource::Cursor,
        support: Support::Unsupported,
        file_count: 0,
    });
    out
}

/// Detect against the real filesystem: count `.jsonl` files under each root.
pub fn detect(home: &std::path::Path) -> Vec<DetectedSource> {
    detect_with(home, |root| collector_sync::walk_transcripts(root).len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn claude_and_codex_roots_are_under_home() {
        let home = Path::new("/home/u");
        assert_eq!(
            source_root(home, AgentSource::Claude).unwrap(),
            Path::new("/home/u/.claude/projects")
        );
        assert_eq!(
            source_root(home, AgentSource::Codex).unwrap(),
            Path::new("/home/u/.codex/sessions")
        );
        assert!(source_root(home, AgentSource::Cursor).is_none());
    }

    #[test]
    fn detect_marks_cursor_unsupported_and_counts_the_rest() {
        let detected = detect_with(Path::new("/home/u"), |root| {
            if root.ends_with(".claude/projects") {
                3
            } else {
                0
            }
        });
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
        assert_eq!(cursor.support, Support::Unsupported);
        assert_eq!(cursor.file_count, 0);
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
