use std::collections::VecDeque;
use std::path::PathBuf;

use collector_contracts::AgentSource;
use collector_sync::{
    assemble_sync_unit_with_lineage, select_changed, walk_transcripts, CodexLineage, CursorStore,
    CursorStoreError, DiscoveredFile, GitRemoteCache, ImportWindow, SyncUnit,
};

use crate::sync::SourceReport;

const ASSEMBLY_BATCH_BYTES: u64 = 16 * 1024 * 1024;
const ASSEMBLY_BATCH_FILES: usize = 16;

pub(crate) struct FactSources {
    source: AgentSource,
    files: VecDeque<DiscoveredFile>,
    lineage: Option<CodexLineage>,
}

impl FactSources {
    pub(crate) fn discover(
        roots: &[PathBuf],
        source: AgentSource,
        store: &CursorStore,
        window: ImportWindow,
        replay: bool,
        reparse_known: bool,
        report: &mut SourceReport,
    ) -> Result<Self, CursorStoreError> {
        let mut files: Vec<_> = roots
            .iter()
            .flat_map(|root| walk_transcripts(root))
            .collect();
        files.sort_by(|a, b| {
            a.mtime_ms
                .total_cmp(&b.mtime_ms)
                .then_with(|| a.path.cmp(&b.path))
        });
        report.source_files_scanned = files.len();
        let lineage = (source == AgentSource::Codex).then(|| CodexLineage::index(&files));
        let files = if replay || reparse_known {
            let mut selected = Vec::new();
            for file in files {
                let needs_upgrade = reparse_known
                    && store.get(source, &file.path)?.is_some()
                    && !store.is_file_parser_current(source, &file.path)?;
                if (replay && window.includes(file.mtime_ms)) || needs_upgrade {
                    selected.push(file);
                } else {
                    selected.extend(select_changed(vec![file], store, source, window)?);
                }
            }
            selected
        } else {
            select_changed(files, store, source, window)?
        };
        report.selected = files.len();
        Ok(Self {
            source,
            files: files.into(),
            lineage,
        })
    }

    pub(crate) async fn next_batch(
        &mut self,
        cache: &GitRemoteCache,
        report: &mut SourceReport,
        files_read: &mut usize,
    ) -> Option<Vec<SyncUnit>> {
        let files = self.take_batch();
        if files.is_empty() {
            return None;
        }
        let mut units = Vec::with_capacity(files.len());
        for file in files {
            match assemble_sync_unit_with_lineage(&file, self.source, cache, self.lineage.as_ref())
                .await
            {
                Ok(unit) => {
                    *files_read += 1;
                    units.push(unit);
                }
                Err(error) => {
                    report.failed += 1;
                    report
                        .first_error
                        .get_or_insert_with(|| format!("transcript assembly failed: {error}"));
                }
            }
        }
        Some(units)
    }

    fn take_batch(&mut self) -> Vec<DiscoveredFile> {
        let mut files = Vec::new();
        let mut bytes = 0u64;
        while let Some(next) = self.files.front() {
            if !files.is_empty()
                && (files.len() >= ASSEMBLY_BATCH_FILES
                    || bytes.saturating_add(next.size_bytes) > ASSEMBLY_BATCH_BYTES)
            {
                break;
            }
            // A large transcript must make progress alone; never truncate it to fit a batch.
            let file = self.files.pop_front().expect("front exists");
            bytes = bytes.saturating_add(file.size_bytes);
            files.push(file);
        }
        files
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use collector_sync::{head_hash, FileCursor};
    use serde_json::json;

    #[test]
    fn failed_migration_does_not_reparse_already_completed_files() {
        let home = tempfile::TempDir::new().unwrap();
        let first = write_jsonl(home.path(), "first.jsonl", json!({"a":1}));
        let second = write_jsonl(home.path(), "second.jsonl", json!({"b":2}));
        let mut store = CursorStore::open_in_memory("org").unwrap();
        store.set_active_parser_version("0.1.0");
        for file in walk_transcripts(home.path()) {
            let content_hash_head = head_hash(&std::fs::read_to_string(&file.path).unwrap());
            store
                .advance(
                    AgentSource::Claude,
                    &FileCursor {
                        file_path: file.path,
                        mtime_ms: file.mtime_ms,
                        byte_offset: file.size_bytes,
                        content_hash_head,
                    },
                )
                .unwrap();
        }
        store.set_active_parser_version("0.2.0");
        let completed = store
            .get(AgentSource::Claude, first.to_str().unwrap())
            .unwrap()
            .unwrap();
        store.advance(AgentSource::Claude, &completed).unwrap();
        let mut report = SourceReport::default();
        let mut files = FactSources::discover(
            &[home.path().to_path_buf()],
            AgentSource::Claude,
            &store,
            ImportWindow::first_incremental(9_000_000_000_000),
            false,
            true,
            &mut report,
        )
        .unwrap();
        assert_eq!(report.selected, 1);
        assert_eq!(files.take_batch()[0].path, second.to_str().unwrap());
        assert_eq!(
            store
                .get(AgentSource::Claude, first.to_str().unwrap())
                .unwrap()
                .unwrap(),
            completed
        );
    }

    fn write_jsonl(dir: &std::path::Path, name: &str, value: serde_json::Value) -> PathBuf {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, format!("{value}\n")).unwrap();
        path
    }

    fn source(sizes: &[u64]) -> FactSources {
        FactSources {
            source: AgentSource::Codex,
            files: sizes
                .iter()
                .enumerate()
                .map(|(index, size)| DiscoveredFile {
                    path: format!("session-{index}.jsonl"),
                    mtime_ms: 1.0,
                    size_bytes: *size,
                })
                .collect(),
            lineage: None,
        }
    }

    #[test]
    fn large_transcripts_are_isolated_without_starving_following_files() {
        let mut source = source(&[1, ASSEMBLY_BATCH_BYTES + 1, 2, 3]);
        assert_eq!(source.take_batch().len(), 1);
        let large = source.take_batch();
        assert_eq!(large.len(), 1);
        assert_eq!(large[0].size_bytes, ASSEMBLY_BATCH_BYTES + 1);
        assert_eq!(source.take_batch().len(), 2);
        assert!(source.take_batch().is_empty());
    }

    #[test]
    fn byte_and_file_bounds_both_limit_resident_assembly() {
        let mut exact = source(&[ASSEMBLY_BATCH_BYTES / 2, ASSEMBLY_BATCH_BYTES / 2, 1]);
        assert_eq!(exact.take_batch().len(), 2);
        assert_eq!(exact.take_batch().len(), 1);
        let mut tiny = source(&[1; ASSEMBLY_BATCH_FILES + 1]);
        assert_eq!(tiny.take_batch().len(), ASSEMBLY_BATCH_FILES);
        assert_eq!(tiny.take_batch().len(), 1);
    }

    #[test]
    fn parser_migration_selects_known_old_files_without_importing_unknown_old_files() {
        let home = tempfile::TempDir::new().unwrap();
        let known = write_jsonl(
            home.path(),
            "known.jsonl",
            json!({ "type": "user", "sessionId": "known" }),
        );
        let _unknown = write_jsonl(
            home.path(),
            "unknown.jsonl",
            json!({ "type": "user", "sessionId": "unknown" }),
        );
        let store = CursorStore::open_in_memory("org").unwrap();
        let known_body = std::fs::read_to_string(&known).unwrap();
        store
            .advance(
                AgentSource::Claude,
                &FileCursor {
                    file_path: known.to_str().unwrap().to_string(),
                    mtime_ms: 0.0,
                    byte_offset: known_body.len() as u64,
                    content_hash_head: head_hash(&known_body),
                },
            )
            .unwrap();
        let mut report = SourceReport::default();
        let sources = FactSources::discover(
            &[home.path().to_path_buf()],
            AgentSource::Claude,
            &store,
            ImportWindow::first_incremental(9_000_000_000_000),
            false,
            true,
            &mut report,
        )
        .unwrap();

        assert_eq!(report.source_files_scanned, 2);
        assert_eq!(report.selected, 1);
        assert_eq!(sources.files[0].path, known.to_str().unwrap());
    }

    #[tokio::test]
    async fn archived_codex_root_is_assembled() {
        let home = tempfile::TempDir::new().unwrap();
        let archived = home.path().join("archived_sessions");
        write_jsonl(
            &archived,
            "archived.jsonl",
            json!({ "type": "session_meta", "payload": { "id": "archived" } }),
        );
        let store = CursorStore::open_in_memory("org").unwrap();
        let mut report = SourceReport::default();
        let mut sources = FactSources::discover(
            &[home.path().join("sessions"), archived],
            AgentSource::Codex,
            &store,
            ImportWindow::first_incremental(24 * 60 * 60 * 1000),
            false,
            false,
            &mut report,
        )
        .unwrap();
        let mut files_read = 0;

        let units = sources
            .next_batch(&GitRemoteCache::new(), &mut report, &mut files_read)
            .await
            .unwrap();
        assert_eq!(units.len(), 1);
        assert_eq!(units[0].ctx.vendor_session_id, "archived");
        assert_eq!(files_read, 1);
    }

    #[tokio::test]
    async fn unresolved_codex_parent_fails_assembly_without_advancing_a_cursor() {
        let home = tempfile::TempDir::new().unwrap();
        let sessions = home.path().join("sessions");
        let child = write_jsonl(
            &sessions,
            "child.jsonl",
            json!({
                "type": "session_meta",
                "payload": { "id": "child", "parent_thread_id": "missing" }
            }),
        );
        let store = CursorStore::open_in_memory("org").unwrap();
        let mut report = SourceReport::default();
        let mut sources = FactSources::discover(
            &[sessions],
            AgentSource::Codex,
            &store,
            ImportWindow::first_incremental(24 * 60 * 60 * 1000),
            false,
            false,
            &mut report,
        )
        .unwrap();
        let mut files_read = 0;

        let units = sources
            .next_batch(&GitRemoteCache::new(), &mut report, &mut files_read)
            .await
            .unwrap();
        assert!(units.is_empty());
        assert_eq!(report.failed, 1);
        assert!(report
            .first_error
            .as_deref()
            .is_some_and(|error| error.contains("unavailable")));
        assert_eq!(files_read, 0);
        assert!(store
            .get(AgentSource::Codex, child.to_str().unwrap())
            .unwrap()
            .is_none());
    }
}
