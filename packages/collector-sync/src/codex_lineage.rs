// SPDX-License-Identifier: Apache-2.0
// Original Trace Flow code.

//! Codex parent-session lineage resolution for transcripts whose metadata names a parent without an
//! explicit spawn depth.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Error, ErrorKind};
use std::path::Path;

use serde_json::Value;

use crate::codex_session::codex_session_fields;
use crate::discovery::DiscoveredFile;

#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionLineage {
    parent_thread_id: Option<String>,
    agent_depth: Option<i64>,
}

/// Resolves Codex child depth from verified local session metadata.
///
/// The filename index is built once for a Codex source pass. Parent files are opened lazily, so a
/// session carrying an explicit `thread_spawn.depth` does not read any other transcript.
pub struct CodexLineage {
    paths_by_session_id: HashMap<String, Vec<String>>,
    metadata: RefCell<HashMap<String, Result<SessionLineage, String>>>,
}

impl CodexLineage {
    pub fn index(files: &[DiscoveredFile]) -> Self {
        let mut paths_by_session_id: HashMap<String, Vec<String>> = HashMap::new();
        for file in files {
            let Some(stem) = Path::new(&file.path)
                .file_stem()
                .and_then(|stem| stem.to_str())
            else {
                continue;
            };
            paths_by_session_id
                .entry(stem.to_string())
                .or_default()
                .push(file.path.clone());
            if let Some(id) = uuid_suffix(stem) {
                paths_by_session_id
                    .entry(id.to_string())
                    .or_default()
                    .push(file.path.clone());
            }
        }
        for paths in paths_by_session_id.values_mut() {
            paths.sort();
            paths.dedup();
        }
        Self {
            paths_by_session_id,
            metadata: RefCell::new(HashMap::new()),
        }
    }

    pub fn child_depth(&self, parent_thread_id: &str) -> std::io::Result<i64> {
        let mut visiting = HashSet::new();
        self.session_depth(parent_thread_id, &mut visiting)?
            .checked_add(1)
            .ok_or_else(|| invalid_data("Codex agent depth overflow"))
    }

    fn session_depth(
        &self,
        session_id: &str,
        visiting: &mut HashSet<String>,
    ) -> std::io::Result<i64> {
        if !visiting.insert(session_id.to_string()) {
            return Err(invalid_data(format!(
                "Codex parent lineage cycle at session {session_id}"
            )));
        }

        let lineage = self.metadata_for(session_id)?;
        let depth = match (lineage.parent_thread_id.as_deref(), lineage.agent_depth) {
            (Some(_), Some(0)) => Err(invalid_data(format!(
                "Codex session {session_id} has a parent but depth zero"
            ))),
            (_, Some(depth)) => Ok(depth),
            (Some(parent), None) => self
                .session_depth(parent, visiting)?
                .checked_add(1)
                .ok_or_else(|| invalid_data("Codex agent depth overflow")),
            (None, None) => Ok(0),
        };
        visiting.remove(session_id);
        depth
    }

    fn metadata_for(&self, session_id: &str) -> std::io::Result<SessionLineage> {
        if let Some(cached) = self.metadata.borrow().get(session_id) {
            return cached.clone().map_err(invalid_data);
        }
        let loaded = self.load_metadata(session_id);
        self.metadata
            .borrow_mut()
            .insert(session_id.to_string(), loaded.clone());
        loaded.map_err(invalid_data)
    }

    fn load_metadata(&self, session_id: &str) -> Result<SessionLineage, String> {
        let candidates = self
            .paths_by_session_id
            .get(session_id)
            .ok_or_else(|| format!("Codex parent session {session_id} is unavailable"))?;
        let mut verified = Vec::new();
        for path in candidates {
            let Some(fields) = read_session_metadata(path)
                .map_err(|err| format!("cannot read Codex parent session {session_id}: {err}"))?
            else {
                continue;
            };
            if fields.fields.vendor_session_id == session_id {
                verified.push(SessionLineage {
                    parent_thread_id: fields.parent_thread_id,
                    agent_depth: fields.agent_depth,
                });
            }
        }
        let Some(first) = verified.first().cloned() else {
            return Err(format!(
                "Codex parent session {session_id} has no identity-verified metadata"
            ));
        };
        if verified.iter().any(|lineage| lineage != &first) {
            return Err(format!(
                "Codex parent session {session_id} has conflicting lineage metadata"
            ));
        }
        Ok(first)
    }
}

fn read_session_metadata(
    path: &str,
) -> std::io::Result<Option<crate::codex_session::CodexSessionFields>> {
    let input = std::fs::File::open(path)?;
    let mut reader = BufReader::new(input);
    let mut line = String::new();
    while reader.read_line(&mut line)? > 0 {
        if let Ok(record) = serde_json::from_str::<Value>(&line) {
            if record.get("type").and_then(Value::as_str) == Some("session_meta") {
                return Ok(Some(codex_session_fields(&[record])));
            }
        }
        line.clear();
    }
    Ok(None)
}

fn uuid_suffix(stem: &str) -> Option<&str> {
    let start = stem.len().checked_sub(36)?;
    let suffix = stem.get(start..)?;
    let bytes = suffix.as_bytes();
    let valid = bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    });
    valid.then_some(suffix)
}

fn invalid_data(message: impl Into<String>) -> Error {
    Error::new(ErrorKind::InvalidData, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write_session(
        dir: &Path,
        filename: &str,
        id: &str,
        parent: Option<&str>,
        depth: Option<i64>,
    ) -> DiscoveredFile {
        let path = dir.join(filename);
        let mut payload = json!({ "id": id });
        if let Some(parent) = parent {
            payload["parent_thread_id"] = json!(parent);
        }
        if let Some(depth) = depth {
            payload["source"] = json!({
                "subagent": { "thread_spawn": { "depth": depth } }
            });
        }
        std::fs::write(
            &path,
            format!(
                "{}\n",
                json!({ "type": "session_meta", "payload": payload })
            ),
        )
        .unwrap();
        DiscoveredFile {
            path: path.to_str().unwrap().to_string(),
            mtime_ms: 1.0,
            size_bytes: std::fs::metadata(path).unwrap().len(),
        }
    }

    #[test]
    fn derives_depth_recursively_across_indexed_roots() {
        let active = tempfile::TempDir::new().unwrap();
        let archived = tempfile::TempDir::new().unwrap();
        let root = write_session(active.path(), "root.jsonl", "root", None, None);
        let parent = write_session(
            archived.path(),
            "parent.jsonl",
            "parent",
            Some("root"),
            None,
        );
        let lineage = CodexLineage::index(&[root, parent]);
        assert_eq!(lineage.child_depth("parent").unwrap(), 2);
    }

    #[test]
    fn rejects_missing_cycles_and_conflicting_duplicate_metadata() {
        let dir = tempfile::TempDir::new().unwrap();
        let a = write_session(dir.path(), "a.jsonl", "a", Some("b"), None);
        let b = write_session(dir.path(), "b.jsonl", "b", Some("a"), None);
        let lineage = CodexLineage::index(&[a, b]);
        assert!(lineage
            .child_depth("a")
            .unwrap_err()
            .to_string()
            .contains("cycle"));
        assert!(lineage.child_depth("missing").is_err());

        let first_dir = tempfile::TempDir::new().unwrap();
        let second_dir = tempfile::TempDir::new().unwrap();
        let first = write_session(first_dir.path(), "same.jsonl", "same", None, Some(1));
        let second = write_session(second_dir.path(), "same.jsonl", "same", None, Some(2));
        let lineage = CodexLineage::index(&[first, second]);
        assert!(lineage
            .child_depth("same")
            .unwrap_err()
            .to_string()
            .contains("conflicting"));
    }

    #[test]
    fn filename_candidate_must_match_the_metadata_identity() {
        let dir = tempfile::TempDir::new().unwrap();
        let mismatch = write_session(dir.path(), "claimed.jsonl", "actual", None, None);
        let lineage = CodexLineage::index(&[mismatch]);
        assert!(lineage.child_depth("claimed").is_err());
    }
}
