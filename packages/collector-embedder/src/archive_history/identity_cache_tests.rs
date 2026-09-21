use std::fs;
use std::time::{Duration, UNIX_EPOCH};

use collector_archive::ArchiveSource;
use collector_archive_sync::{
    capture_archive_snapshots, ArchiveAuthorizedSource, ArchiveHistoryChoice, ArchivePolicy,
    ArchiveSpool, MemoryKeyStore,
};
use tempfile::TempDir;

use super::prepare;

#[test]
fn full_reconciliation_rechecks_content_when_metadata_hints_are_unchanged() {
    use super::identity_cache::identify_remembered;
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let spool = ArchiveSpool::open(dir.path().join("spool"), "org", &keys).unwrap();
    let path = dir.path().join("session.jsonl");
    let original = b"{\"sessionId\":\"first\"}\n";
    let changed = b"{\"sessionId\":\"other\"}\n";
    fs::write(&path, original).unwrap();
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let resolve = |verify| {
        identify_remembered(
            &spool,
            ArchiveSource::Claude,
            path.to_str().unwrap(),
            "same-path".to_string(),
            verify,
        )
        .unwrap()
    };
    assert_eq!(resolve(true).session, "first");
    fs::write(&path, changed).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let stable_identity =
        collector_archive_sync::source_file_identity(&fs::metadata(&path).unwrap()).is_some();
    assert_eq!(
        resolve(false).session,
        if stable_identity { "first" } else { "other" }
    );
    assert_eq!(resolve(true).session, "other");
}

#[test]
fn remembered_candidate_uses_metadata_refreshed_after_discovery() {
    use super::identity_cache::identify_remembered;
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let spool = ArchiveSpool::open(dir.path().join("spool"), "org", &keys).unwrap();
    let path = dir.path().join("session.jsonl");
    let original = b"{\"sessionId\":\"first\"}\n";
    fs::write(&path, original).unwrap();

    let resolve = || {
        identify_remembered(
            &spool,
            ArchiveSource::Claude,
            path.to_str().unwrap(),
            "same-path".to_string(),
            false,
        )
        .unwrap()
    };

    let appended = [original.as_slice(), b"{}\n"].concat();
    fs::write(&path, &appended).unwrap();
    let appended_mtime_ms = 1_800_000_000_123_i64;
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(
            fs::FileTimes::new()
                .set_modified(UNIX_EPOCH + Duration::from_millis(appended_mtime_ms as u64)),
        )
        .unwrap();
    let appended_candidate = resolve();
    assert_eq!(appended_candidate.size, appended.len() as u64);
    assert_eq!(appended_candidate.complete_extent, appended.len() as u64);
    assert_eq!(appended_candidate.activity_rank_ms, appended_mtime_ms);

    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(original.len() as u64)
        .unwrap();
    let truncated_mtime_ms = appended_mtime_ms + 1_000;
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(
            fs::FileTimes::new()
                .set_modified(UNIX_EPOCH + Duration::from_millis(truncated_mtime_ms as u64)),
        )
        .unwrap();
    let truncated_candidate = resolve();
    assert_eq!(truncated_candidate.size, original.len() as u64);
    assert_eq!(truncated_candidate.complete_extent, original.len() as u64);
    assert_eq!(truncated_candidate.activity_rank_ms, truncated_mtime_ms);
}

#[test]
fn identified_file_retains_malformed_rewrite_after_restart_under_new_only_consent() {
    let home = TempDir::new().unwrap();
    let root = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let path = home.path().join(".codex/sessions/session.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"known-session\",\"timestamp\":\"2026-09-21T00:00:00Z\"}}\n").unwrap();
    let auth = [ArchiveAuthorizedSource {
        source: ArchiveSource::Codex,
        history_choice: ArchiveHistoryChoice::NewOnly,
        authorized_at: 10,
    }];
    let mut spool = ArchiveSpool::open(root.path(), "org", &keys).unwrap();
    let initial = prepare(home.path(), &spool, &auth, 20);
    assert_eq!(initial.snapshots.len(), 1);
    let report = capture_archive_snapshots(
        &mut spool,
        &keys,
        &initial.snapshots,
        ArchivePolicy::Enrolled,
        &initial.plan,
        20,
        None,
    );
    assert_eq!(report.captured, 1);
    drop(spool);
    fs::write(&path, b"{malformed\xff").unwrap();
    let mut spool = ArchiveSpool::open(root.path(), "org", &keys).unwrap();
    let rewritten = prepare(home.path(), &spool, &auth, 30);
    if collector_archive_sync::source_file_identity(&fs::metadata(&path).unwrap()).is_none() {
        assert!(rewritten.snapshots.is_empty());
        assert!(rewritten
            .errors
            .iter()
            .any(|e| e == "invalid_archive_session"));
        return;
    }
    assert!(rewritten.errors.is_empty(), "{:?}", rewritten.errors);
    assert_eq!(rewritten.snapshots.len(), 1);
    assert_eq!(rewritten.snapshots[0].source_session_id, "known-session");
    let report = capture_archive_snapshots(
        &mut spool,
        &keys,
        &rewritten.snapshots,
        ArchivePolicy::Enrolled,
        &rewritten.plan,
        30,
        None,
    );
    assert_eq!(report.captured, 1);
    assert_eq!(report.forked, 1);
    assert_eq!(spool.all_pending().unwrap().len(), 2);

    // Keep the original inode alive to prove the replacement has another identity.
    fs::rename(&path, home.path().join("original.bin")).unwrap();
    fs::write(&path, b"unidentified replacement").unwrap();
    let replacement = prepare(home.path(), &spool, &auth, 40);
    assert!(replacement.snapshots.is_empty());
    assert!(replacement
        .errors
        .iter()
        .any(|e| e == "invalid_archive_session"));
}

#[test]
fn replacement_between_discovery_and_capture_cannot_inherit_consent() {
    let home = TempDir::new().unwrap();
    let root = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let path = home.path().join(".claude/projects/project/session.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        b"{\"sessionId\":\"known\",\"timestamp\":\"2026-09-21T00:00:00Z\",\"type\":\"user\"}\n",
    )
    .unwrap();
    let auth = [ArchiveAuthorizedSource {
        source: ArchiveSource::Claude,
        history_choice: ArchiveHistoryChoice::NewOnly,
        authorized_at: 10,
    }];
    let mut spool = ArchiveSpool::open(root.path(), "org", &keys).unwrap();
    let discovered = prepare(home.path(), &spool, &auth, 20);
    assert_eq!(discovered.snapshots.len(), 1);
    fs::rename(&path, home.path().join("original.bin")).unwrap();
    fs::write(&path, b"unidentified replacement").unwrap();
    let report = capture_archive_snapshots(
        &mut spool,
        &keys,
        &discovered.snapshots,
        ArchivePolicy::Enrolled,
        &discovered.plan,
        20,
        None,
    );
    assert_eq!(report.captured, 0);
    assert_eq!(
        report.first_error.as_deref(),
        Some("invalid_archive_session")
    );
    assert!(spool.all_pending().unwrap().is_empty());
}
