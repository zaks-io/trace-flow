use std::fs;

use collector_archive_sync::{ArchiveSpool, MemoryKeyStore};

#[test]
fn opening_a_spool_removes_plaintext_left_by_a_crashed_decoder() {
    let state = tempfile::tempdir().unwrap();
    let root = state.path().join("spool");
    let keys = MemoryKeyStore::new();
    let spool = ArchiveSpool::open(&root, "org", &keys).unwrap();
    let scratch = spool.scratch_dir();
    fs::create_dir_all(&scratch).unwrap();
    fs::write(scratch.join("abandoned.decoded"), b"private transcript").unwrap();
    drop(spool);

    ArchiveSpool::open(&root, "org", &keys).unwrap();

    assert!(!scratch.exists());
}

#[test]
fn recovery_preserves_live_scratch_and_purge_retries_after_decoder_releases_it() {
    let state = tempfile::tempdir().unwrap();
    let root = state.path().join("spool");
    let keys = MemoryKeyStore::new();
    let spool = ArchiveSpool::open(&root, "org", &keys).unwrap();
    let lease = spool.acquire_scratch_lease().unwrap();
    let scratch = spool.scratch_dir();
    fs::write(scratch.join("live.decoded"), b"private transcript").unwrap();

    ArchiveSpool::open(&root, "org", &keys).unwrap();
    assert!(scratch.join("live.decoded").exists());
    assert!(ArchiveSpool::purge_at(&root, "org", &keys).is_err());
    assert!(scratch.join("live.decoded").exists());
    assert!(root.exists());

    drop(lease);
    ArchiveSpool::purge_at(&root, "org", &keys).unwrap();
    assert!(!scratch.exists());
    assert!(!root.exists());
}

#[test]
fn terminal_purge_removes_plaintext_scratch() {
    let state = tempfile::tempdir().unwrap();
    let root = state.path().join("spool");
    let keys = MemoryKeyStore::new();
    let spool = ArchiveSpool::open(&root, "org", &keys).unwrap();
    let scratch = spool.scratch_dir();
    fs::create_dir_all(&scratch).unwrap();
    fs::write(scratch.join("abandoned.decoded"), b"private transcript").unwrap();
    drop(spool);

    ArchiveSpool::purge_at(&root, "org", &keys).unwrap();

    assert!(!scratch.exists());
    assert!(!root.exists());
}
