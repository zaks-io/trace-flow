use super::*;

#[test]
fn unfinished_cutoff_survives_reopen_and_only_moves_earlier_until_completion() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cursors.sqlite");
    let store = CursorStore::open(&path, "org_1").unwrap();
    assert_eq!(store.begin_sync(100).unwrap(), 100);
    assert_eq!(store.begin_sync(200).unwrap(), 100);
    drop(store);

    let store = CursorStore::open(&path, "org_1").unwrap();
    assert_eq!(store.begin_sync(300).unwrap(), 100);
    assert_eq!(store.begin_sync(50).unwrap(), 50);
    assert_eq!(store.begin_sync(300).unwrap(), 50);
    let other_org = CursorStore::open(&path, "org_2").unwrap();
    assert_eq!(other_org.begin_sync(400).unwrap(), 400);

    store.mark_complete_sync(500, 50).unwrap();
    assert_eq!(store.last_complete_sync_at_ms().unwrap(), Some(500));
    assert_eq!(store.begin_sync(600).unwrap(), 600);
    assert_eq!(other_org.begin_sync(700).unwrap(), 400);
    assert_eq!(other_org.last_complete_sync_at_ms().unwrap(), None);
}

#[test]
fn corrupt_pending_cutoff_fails_without_replacing_it() {
    let store = CursorStore::open_in_memory("org_1").unwrap();
    store
        .set_meta(META_INCOMPLETE_SYNC_CUTOFF_MS, "not-a-timestamp")
        .unwrap();
    assert!(matches!(
        store.begin_sync(100),
        Err(CursorStoreError::CorruptMeta {
            key: META_INCOMPLETE_SYNC_CUTOFF_MS,
            ..
        })
    ));
    assert_eq!(
        store
            .get_meta(META_INCOMPLETE_SYNC_CUTOFF_MS)
            .unwrap()
            .as_deref(),
        Some("not-a-timestamp")
    );
}

#[test]
fn completing_sync_rolls_back_watermark_if_pending_cutoff_cannot_be_cleared() {
    let store = CursorStore::open_in_memory("org_1").unwrap();
    store.begin_sync(100).unwrap();
    store
        .conn
        .execute_batch(
            "CREATE TEMP TRIGGER reject_pending_clear BEFORE DELETE ON cursor_meta
             WHEN OLD.key = 'incomplete_sync_cutoff_ms'
             BEGIN SELECT RAISE(ABORT, 'injected metadata write failure'); END;",
        )
        .unwrap();
    assert!(store.mark_complete_sync(200, 100).is_err());
    assert_eq!(store.last_complete_sync_at_ms().unwrap(), None);
    assert_eq!(store.begin_sync(300).unwrap(), 100);
    store
        .conn
        .execute_batch("DROP TRIGGER reject_pending_clear;")
        .unwrap();
    store.mark_complete_sync(400, 100).unwrap();
    assert_eq!(store.last_complete_sync_at_ms().unwrap(), Some(400));
    assert_eq!(store.begin_sync(500).unwrap(), 500);
}

#[test]
fn overlapping_narrow_pass_keeps_a_wider_unfinished_cutoff() {
    let store = CursorStore::open_in_memory("org_1").unwrap();
    // An incremental pass starts, then a wider import starts on the same database before the
    // incremental pass finishes; the import fails and leaves its cutoff pending.
    let narrow = store.begin_sync(1_000).unwrap();
    let wide = store.begin_sync(100).unwrap();
    assert_eq!((narrow, wide), (1_000, 100));

    store.mark_complete_sync(2_000, narrow).unwrap();
    assert_eq!(store.last_complete_sync_at_ms().unwrap(), Some(2_000));
    assert_eq!(
        store.begin_sync(1_500).unwrap(),
        100,
        "the next pass still scans the failed import's window"
    );

    store.mark_complete_sync(3_000, 100).unwrap();
    assert_eq!(store.begin_sync(2_500).unwrap(), 2_500);
}
