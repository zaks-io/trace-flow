use super::*;
use crate::sync::SyncRunOutcome;
use crate::sync::{run_detailed, window_from_since, RunConfig, Window};
use collector_contracts::AgentSource;
use collector_sync::CursorStore;
use std::time::{Duration, UNIX_EPOCH};

const NOW: i64 = 1_779_840_000_000;
const RETRY: i64 = NOW + 120_000;

impl SessionGitHarness {
    fn window_edge_transcript(&self) -> PathBuf {
        self.append("window-edge", 1, None);
        let path = self.transcript("window-edge");
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_millis((NOW - 86_340_000) as u64))
            .unwrap();
        path
    }

    fn store(&self) -> CursorStore {
        CursorStore::open(
            crate::connection::Paths::at(self.state.path().to_path_buf()).cursor_db("org_1"),
            "org_1",
        )
        .unwrap()
    }

    async fn sync_at(&self, now: i64, ingest_url: &str) -> SyncRunOutcome {
        self.sync_window_at(now, ingest_url, Window::Incremental)
            .await
    }

    async fn sync_window_at(&self, now: i64, ingest_url: &str, window: Window) -> SyncRunOutcome {
        run_detailed(RunConfig {
            ingest_url: ingest_url.to_string(),
            credential: "tfc_secret".to_string(),
            org_id: "org_1",
            home: self.home.path(),
            source_homes: None,
            window,
            replay: false,
            now_ms: now,
            batch_id_prefix: "test",
            app_version: TEST_APP_VERSION,
            state_dir: Some(self.state.path()),
        })
        .await
        .unwrap()
    }

    fn assert_incomplete_first_sync(&self, outcome: &SyncRunOutcome, path: &Path) {
        let report = &outcome.reports[0].1;
        assert_eq!(report.selected, 1, "{outcome:?}");
        assert_eq!(report.failed, 1, "{outcome:?}");
        assert!(!report.is_complete());
        assert!(self.uploads.lock().unwrap().is_empty());
        assert_eq!(self.store().last_complete_sync_at_ms().unwrap(), None);
        assert!(self
            .store()
            .get(AgentSource::Claude, path.to_str().unwrap())
            .unwrap()
            .is_none());
    }

    async fn assert_window_edge_recovery(&self, path: &Path) {
        let recovered = self.sync_at(RETRY, &self.ingest_url).await;
        assert_eq!(recovered.reports[0].1.selected, 1, "{recovered:?}");
        assert_eq!(recovered.reports[0].1.advanced, 1, "{recovered:?}");
        assert!(recovered.reports.iter().all(|(_, r)| r.is_complete()));
        assert_eq!(
            self.store().last_complete_sync_at_ms().unwrap(),
            Some(RETRY)
        );
        assert!(self
            .store()
            .get(AgentSource::Claude, path.to_str().unwrap())
            .unwrap()
            .is_some());
        let pin = self
            .store()
            .session_git(AgentSource::Claude, path.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(pin.normalized_git_remote, "github.com/acme/original");
        let unchanged = self.sync_at(RETRY + 1, &self.ingest_url).await;
        assert_eq!(unchanged.reports[0].1.advanced, 0);
        let uploads = self.uploads.lock().unwrap();
        assert_eq!(uploads.len(), 1, "the unchanged transcript uploads once");
        let messages = &uploads[0].facts.messages;
        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0].normalized_git_remote,
            "github.com/acme/original"
        );
        assert_eq!(messages[0].git_branch, "main");
    }
}

#[tokio::test]
async fn failed_history_or_legacy_backfill_keeps_its_window_until_complete() {
    for legacy_backfill in [false, true] {
        let harness = SessionGitHarness::new().await;
        // Establish a watermark too: a failed history pass must retain its wider cutoff even when
        // the next pass requests incremental sync and already has a complete watermark to resume.
        harness.sync().await;
        let path = harness.window_edge_transcript();
        let edge_mtime = NOW - 7 * 86_400_000 + 60_000;
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_millis(edge_mtime as u64))
            .unwrap();
        let window = if legacy_backfill {
            harness
                .store()
                .advance(
                    AgentSource::Claude,
                    &collector_sync::FileCursor {
                        file_path: path.to_str().unwrap().to_string(),
                        mtime_ms: edge_mtime as f64,
                        byte_offset: 1,
                        content_hash_head: "legacy".to_string(),
                    },
                )
                .unwrap();
            Window::Incremental
        } else {
            window_from_since("7d").unwrap()
        };
        let rejected =
            spawn_http(|_| raw_response(401, "Unauthorized", r#"{"error":"unauthorized"}"#)).await;
        let first = harness.sync_window_at(NOW, &rejected, window).await;
        assert_eq!(first.reports[0].1.failed, 1, "{first:?}");
        assert_eq!(
            harness.store().last_complete_sync_at_ms().unwrap(),
            Some(NOW)
        );
        assert_eq!(
            harness.store().needs_replay_backfill().unwrap(),
            legacy_backfill
        );

        harness.assert_window_edge_recovery(&path).await;
        assert!(!harness.store().needs_replay_backfill().unwrap());
        // Completing the pending history does not turn subsequent incremental passes into imports.
        harness.append("outside-incremental", 1, None);
        std::fs::File::options()
            .write(true)
            .open(harness.transcript("outside-incremental"))
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_millis(edge_mtime as u64))
            .unwrap();
        assert_eq!(
            harness
                .sync_at(RETRY + 2, &harness.ingest_url)
                .await
                .reports[0]
                .1
                .selected,
            0
        );
    }
}

#[tokio::test]
async fn first_sync_git_deferral_keeps_window_edge_on_later_retry() {
    let harness = SessionGitHarness::new().await;
    let path = harness.window_edge_transcript();
    let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
    let config = harness.repo.join(".git/config");
    let original = std::fs::read(&config).unwrap();
    let mut broken = original.clone();
    broken.extend_from_slice(b"\n[remote \"origin\"]\n url = https://github.com/acme/\xff.git\n");
    std::fs::write(&config, broken).unwrap();

    let first = harness.sync_at(NOW, &harness.ingest_url).await;
    harness.assert_incomplete_first_sync(&first, &path);
    assert!(first.reports[0]
        .1
        .first_error
        .as_deref()
        .unwrap()
        .contains("git config returned invalid UTF-8"));
    assert!(harness
        .store()
        .session_git(AgentSource::Claude, path.to_str().unwrap())
        .unwrap()
        .is_none());

    std::fs::write(config, original).unwrap();
    harness.assert_window_edge_recovery(&path).await;
    assert_eq!(std::fs::metadata(path).unwrap().modified().unwrap(), mtime);
}

#[tokio::test]
async fn first_sync_upload_failure_keeps_window_edge_on_later_retry() {
    let harness = SessionGitHarness::new().await;
    let path = harness.window_edge_transcript();
    let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
    let rejected =
        spawn_http(|_| raw_response(401, "Unauthorized", r#"{"error":"unauthorized"}"#)).await;

    let first = harness.sync_at(NOW, &rejected).await;
    harness.assert_incomplete_first_sync(&first, &path);
    assert!(first.reports[0]
        .1
        .first_error
        .as_deref()
        .unwrap()
        .starts_with("unauthorized"));

    harness.assert_window_edge_recovery(&path).await;
    assert_eq!(std::fs::metadata(path).unwrap().modified().unwrap(), mtime);
}
