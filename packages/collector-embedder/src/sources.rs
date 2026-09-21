// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector CLI: detected transcript sources.

//! Transcript roots configured for each supported agent.

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use collector_contracts::AgentSource;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Support {
    Ready,
}

#[derive(Debug, Clone)]
pub struct DetectedSource {
    pub source: AgentSource,
    pub support: Support,
    pub file_count: usize,
}

impl DetectedSource {
    pub fn display_root(&self) -> &'static str {
        match self.source {
            AgentSource::Claude => "Claude projects",
            AgentSource::Codex => "Codex sessions",
            AgentSource::Cursor => "(Cursor state store)",
        }
    }
}

/// Persisted agent homes. Desktop applications often do not inherit a login shell's environment,
/// so resolving these variables on every launch is not enough.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SourceHomes {
    pub claude_config_dirs: Vec<PathBuf>,
    pub codex_homes: Vec<PathBuf>,
}

impl SourceHomes {
    pub fn standard(home: &Path) -> Self {
        Self {
            claude_config_dirs: vec![home.join(".claude")],
            codex_homes: vec![home.join(".codex")],
        }
    }

    pub fn resolve(home: &Path) -> Self {
        Self::resolve_with(home, |name| std::env::var_os(name))
    }

    fn resolve_with(home: &Path, mut env: impl FnMut(&str) -> Option<OsString>) -> Self {
        let mut homes = Self::standard(home);
        if let Some(path) = env("CLAUDE_CONFIG_DIR").filter(|path| !path.is_empty()) {
            homes.claude_config_dirs.push(PathBuf::from(path));
        }
        if let Some(path) = env("CODEX_HOME").filter(|path| !path.is_empty()) {
            homes.codex_homes.push(PathBuf::from(path));
        }
        homes.normalize();
        homes
    }

    /// Merge newly observed process configuration into the persisted set without dropping roots
    /// learned by an earlier shell-launched process.
    pub fn merge(&mut self, other: &Self) {
        self.claude_config_dirs
            .extend(other.claude_config_dirs.iter().cloned());
        self.codex_homes.extend(other.codex_homes.iter().cloned());
        self.normalize();
    }

    pub fn roots(&self, source: AgentSource) -> Vec<PathBuf> {
        match source {
            AgentSource::Claude => self
                .claude_config_dirs
                .iter()
                .map(|dir| dir.join("projects"))
                .collect(),
            AgentSource::Codex => self
                .codex_homes
                .iter()
                .flat_map(|dir| [dir.join("sessions"), dir.join("archived_sessions")])
                .collect(),
            AgentSource::Cursor => Vec::new(),
        }
    }

    fn normalize(&mut self) {
        dedupe_paths(&mut self.claude_config_dirs);
        dedupe_paths(&mut self.codex_homes);
    }
}

fn dedupe_paths(paths: &mut Vec<PathBuf>) {
    let mut seen = HashSet::new();
    paths.retain(|path| seen.insert(path.clone()));
}

pub fn source_roots(home: &Path, source: AgentSource) -> Vec<PathBuf> {
    SourceHomes::standard(home).roots(source)
}

pub fn cursor_db_path(home: &Path) -> Option<PathBuf> {
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
        None
    }
}

pub fn ingestable_sources() -> [AgentSource; 3] {
    [AgentSource::Claude, AgentSource::Codex, AgentSource::Cursor]
}

pub fn detect_with<F, G>(
    homes: &SourceHomes,
    home: &Path,
    mut count: F,
    mut db_exists: G,
) -> Vec<DetectedSource>
where
    F: FnMut(&Path) -> usize,
    G: FnMut(&Path) -> bool,
{
    ingestable_sources()
        .into_iter()
        .map(|source| {
            let roots = homes.roots(source);
            let file_count = if roots.is_empty() {
                cursor_db_path(home)
                    .map(|db| usize::from(db_exists(&db)))
                    .unwrap_or(0)
            } else {
                roots.iter().map(|root| count(root)).sum()
            };
            DetectedSource {
                source,
                support: Support::Ready,
                file_count,
            }
        })
        .collect()
}

pub fn detect(home: &Path) -> Vec<DetectedSource> {
    let homes = SourceHomes::resolve(home);
    detect_configured(&homes, home)
}

pub fn detect_configured(homes: &SourceHomes, home: &Path) -> Vec<DetectedSource> {
    detect_with(
        homes,
        home,
        |root| collector_sync::walk_transcripts(root).files.len(),
        |db| db.exists(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_homes_are_added_to_defaults_and_deduplicated() {
        let homes = SourceHomes::resolve_with(Path::new("/home/u"), |name| match name {
            "CLAUDE_CONFIG_DIR" => Some(OsString::from("/agents/claude")),
            "CODEX_HOME" => Some(OsString::from("/agents/codex")),
            _ => None,
        });
        assert_eq!(
            homes.roots(AgentSource::Claude),
            vec![
                PathBuf::from("/home/u/.claude/projects"),
                PathBuf::from("/agents/claude/projects"),
            ]
        );
        assert_eq!(homes.roots(AgentSource::Codex).len(), 4);

        let mut persisted = SourceHomes::resolve_with(Path::new("/home/u"), |_| None);
        persisted.merge(&homes);
        persisted.merge(&homes);
        assert_eq!(persisted.claude_config_dirs.len(), 2);
        assert_eq!(persisted.codex_homes.len(), 2);
    }

    #[test]
    fn detect_counts_every_configured_root() {
        let homes = SourceHomes {
            claude_config_dirs: vec![PathBuf::from("/one"), PathBuf::from("/two")],
            codex_homes: Vec::new(),
        };
        let detected = detect_with(&homes, Path::new("/home/u"), |_| 2, |_| false);
        let claude = detected
            .iter()
            .find(|source| source.source == AgentSource::Claude)
            .unwrap();
        assert_eq!(claude.file_count, 4);
    }

    #[test]
    fn display_root_never_leaks_home() {
        for source in ingestable_sources() {
            let detected = DetectedSource {
                source,
                support: Support::Ready,
                file_count: 0,
            };
            assert!(!detected.display_root().contains("Users"));
        }
    }
}
