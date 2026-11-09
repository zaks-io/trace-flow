use super::tests::{raw_response, run_fact_sync, spawn_http};
use super::{SourceReport, SyncRunOutcome};
use crate::connection::Paths;
use collector_contracts::AgentSource;
use collector_sync::{ComposerCursor, CursorStore};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

const NOW_MS: i64 = 1_779_840_000_000;
const CYCLE_MS: i64 = 5 * 60 * 1000;

struct CursorHarness {
    home: tempfile::TempDir,
    state: tempfile::TempDir,
    db: PathBuf,
    ingest_url: String,
    uploads: Arc<AtomicU32>,
    accept: Arc<AtomicBool>,
}

impl CursorHarness {
    async fn new() -> Self {
        let home = crate::test_support::private_tempdir();
        let state = crate::test_support::private_tempdir();
        let db = crate::sources::cursor_db_path(home.path()).unwrap();
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        commit_row(
            &db,
            "composerData:c1",
            json!({ "composerId": "c1", "createdAt": NOW_MS - 60 * 60 * 1000 }),
        );
        commit_row(
            &db,
            "bubbleId:c1:b1",
            json!({ "bubbleId": "b1", "type": 1, "createdAt": "2026-05-26T23:00:00.000Z", "text": "hi" }),
        );
        let uploads = Arc::new(AtomicU32::new(0));
        let accept = Arc::new(AtomicBool::new(true));
        let ingest_url = spawn_http({
            let uploads = Arc::clone(&uploads);
            let accept = Arc::clone(&accept);
            move |_raw| {
                uploads.fetch_add(1, Ordering::SeqCst);
                if accept.load(Ordering::SeqCst) {
                    raw_response(
                        202,
                        "Accepted",
                        r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
                    )
                } else {
                    raw_response(401, "Unauthorized", r#"{"reason":"credential_revoked"}"#)
                }
            }
        })
        .await;
        Self {
            home,
            state,
            db,
            ingest_url,
            uploads,
            accept,
        }
    }

    async fn sync(&self, cycle: i64, replay: bool) -> SyncRunOutcome {
        run_fact_sync(
            self.home.path(),
            self.state.path(),
            self.ingest_url.clone(),
            replay,
            NOW_MS + cycle * CYCLE_MS,
        )
        .await
    }

    /// Make the stored watermark disagree with the DB, so any pass that rereads it selects `c1`.
    fn forget_c1_content(&self) {
        CursorStore::open(
            Paths::at(self.state.path().to_path_buf()).cursor_db("org_1"),
            "org_1",
        )
        .unwrap()
        .advance_composer(
            AgentSource::Cursor,
            &ComposerCursor {
                composer_id: "c1".to_string(),
                bubble_count: 0,
                max_created_at: 0,
                content_hash: Some("sha256:stale".to_string()),
            },
        )
        .unwrap();
    }
}

fn commit_row(db: &Path, key: &str, value: Value) {
    let conn = rusqlite::Connection::open(db).unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
        rusqlite::params![key, value.to_string()],
    )
    .unwrap();
}

fn cursor_report(outcome: &SyncRunOutcome) -> &SourceReport {
    &outcome
        .reports
        .iter()
        .find(|(source, _)| *source == AgentSource::Cursor)
        .unwrap()
        .1
}

#[tokio::test]
async fn an_idle_cursor_db_is_not_reread_until_cursor_commits_or_replay_asks() {
    let h = CursorHarness::new().await;
    assert_eq!(cursor_report(&h.sync(0, false).await).advanced, 1);

    h.forget_c1_content();
    let idle = h.sync(1, false).await;
    assert_eq!(cursor_report(&idle).selected, 0);
    assert_eq!(h.uploads.load(Ordering::SeqCst), 1);

    commit_row(&h.db, "unrelated:ui-state", json!({ "open": true }));
    let after_commit = h.sync(2, false).await;
    assert_eq!(cursor_report(&after_commit).selected, 1);
    assert_eq!(cursor_report(&after_commit).advanced, 1);

    let replay = h.sync(3, true).await;
    assert_eq!(cursor_report(&replay).selected, 1);
}

#[tokio::test]
async fn a_failed_cursor_pass_is_retried_even_though_the_db_did_not_change() {
    let h = CursorHarness::new().await;
    h.accept.store(false, Ordering::SeqCst);
    let rejected = h.sync(0, false).await;
    assert!(!cursor_report(&rejected).is_complete());

    h.accept.store(true, Ordering::SeqCst);
    let retried = h.sync(1, false).await;
    assert_eq!(cursor_report(&retried).selected, 1);
    assert_eq!(cursor_report(&retried).advanced, 1);
}
