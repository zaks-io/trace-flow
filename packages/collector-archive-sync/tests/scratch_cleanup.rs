use std::fs;
use std::sync::{mpsc, Arc};
use std::time::Duration;

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
fn recovery_waits_for_a_live_decoder_before_removing_scratch() {
    let state = tempfile::tempdir().unwrap();
    let root = state.path().join("spool");
    let keys = Arc::new(MemoryKeyStore::new());
    let spool = ArchiveSpool::open(&root, "org", keys.as_ref()).unwrap();
    let lease = spool.acquire_scratch_lease().unwrap();
    let scratch = spool.scratch_dir();
    fs::write(scratch.join("live.decoded"), b"private transcript").unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let other_root = root.clone();
    let other_keys = Arc::clone(&keys);
    let worker = std::thread::spawn(move || {
        let result = ArchiveSpool::open(other_root, "org", other_keys.as_ref());
        done_tx.send(result.map(|_| ())).unwrap();
    });

    assert!(done_rx.recv_timeout(Duration::from_millis(100)).is_err());
    assert!(scratch.join("live.decoded").exists());
    drop(lease);
    done_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    worker.join().unwrap();
    assert!(!scratch.exists());
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
