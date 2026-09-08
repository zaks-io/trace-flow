use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};

use collector_archive::ArchiveSource;
use collector_archive_sync::{
    ArchiveAuthorizedSource, ArchiveHistoryChoice, ArchiveSpool, ArchiveWorkClass, MemoryKeyStore,
};
use tempfile::TempDir;

use super::prepare;

fn authorization(source: ArchiveSource, choice: ArchiveHistoryChoice) -> ArchiveAuthorizedSource {
    ArchiveAuthorizedSource {
        source,
        history_choice: choice,
        authorized_at: 1_700_000_000_000,
    }
}

fn codex(session: &str, timestamp: &str, record: &str) -> String {
    format!(
        "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{session}\",\"timestamp\":\"{timestamp}\"}}}}\n{{\"type\":\"event_msg\",\"payload\":{{\"id\":\"{record}\"}}}}\n"
    )
}

fn write_codex(home: &TempDir, root: &str, name: &str, bytes: &str) {
    let dir = home.path().join(".codex").join(root);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(name), bytes).unwrap();
}

fn open_spool(dir: &TempDir, keys: &MemoryKeyStore) -> ArchiveSpool {
    ArchiveSpool::open(dir.path(), "org_1", keys).unwrap()
}

#[test]
fn new_only_commits_inventory_before_admitting_a_later_session() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    write_codex(
        &home,
        "sessions",
        "existing.jsonl",
        &codex("existing", "2026-01-01T00:00:00Z", "one"),
    );
    let spool = open_spool(&spool_dir, &keys);
    let auth = authorization(ArchiveSource::Codex, ArchiveHistoryChoice::NewOnly);
    let first = prepare(home.path(), &spool, std::slice::from_ref(&auth), 10);
    assert!(first.snapshots.is_empty());
    assert!(spool
        .history_state(ArchiveSource::Codex)
        .unwrap()
        .unwrap()
        .excludes_session("existing"));

    write_codex(
        &home,
        "sessions",
        "later.jsonl",
        &codex("later", "2026-02-01T00:00:00Z", "two"),
    );
    let second = prepare(home.path(), &spool, &[auth], 11);
    assert_eq!(second.snapshots.len(), 1);
    assert_eq!(second.snapshots[0].source_session_id, "later");
    assert_eq!(second.snapshots[0].class, ArchiveWorkClass::Live);
}

#[test]
fn all_history_keeps_new_session_priority_after_restart() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    write_codex(
        &home,
        "sessions",
        "old.jsonl",
        &codex("old", "2020-01-01T00:00:00Z", "one"),
    );
    write_codex(
        &home,
        "sessions",
        "new.jsonl",
        &codex("new", "2026-01-01T00:00:00Z", "two"),
    );
    let auth = authorization(ArchiveSource::Codex, ArchiveHistoryChoice::AllHistory);
    let spool = open_spool(&spool_dir, &keys);
    let first = prepare(home.path(), &spool, std::slice::from_ref(&auth), 10);
    assert_eq!(
        first.plan.class_for(ArchiveSource::Codex, "new"),
        ArchiveWorkClass::Live
    );
    assert_eq!(
        first.plan.class_for(ArchiveSource::Codex, "old"),
        ArchiveWorkClass::Baseline
    );
    drop(spool);

    let reopened = open_spool(&spool_dir, &keys);
    let second = prepare(home.path(), &reopened, &[auth], 11);
    assert_eq!(
        second.plan.class_for(ArchiveSource::Codex, "new"),
        ArchiveWorkClass::Live
    );
    assert_eq!(
        second.plan.class_for(ArchiveSource::Codex, "old"),
        ArchiveWorkClass::Baseline
    );
}

#[test]
fn codex_roots_dedupe_prefixes_and_reject_divergence() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let prefix = codex("shared", "2020-01-01T00:00:00Z", "one");
    write_codex(&home, "archived_sessions", "copy.jsonl", &prefix);
    write_codex(
        &home,
        "sessions",
        "longer.jsonl",
        &format!("{prefix}{{\"type\":\"event_msg\",\"payload\":{{\"id\":\"two\"}}}}\n"),
    );
    let auth = authorization(ArchiveSource::Codex, ArchiveHistoryChoice::AllHistory);
    let spool = open_spool(&spool_dir, &keys);
    let compatible = prepare(home.path(), &spool, std::slice::from_ref(&auth), 10);
    assert_eq!(compatible.snapshots.len(), 1);
    assert!(!compatible
        .errors
        .iter()
        .any(|error| error == "archive_history_divergent_copy"));

    write_codex(
        &home,
        "archived_sessions",
        "copy.jsonl",
        &codex("shared", "2020-01-01T00:00:00Z", "different"),
    );
    let divergent = prepare(home.path(), &spool, &[auth], 11);
    assert!(divergent.snapshots.is_empty());
    assert!(divergent
        .errors
        .iter()
        .any(|error| error == "archive_history_divergent_copy"));
    assert!(home
        .path()
        .join(".codex/archived_sessions/copy.jsonl")
        .exists());
    assert!(home.path().join(".codex/sessions/longer.jsonl").exists());
}

#[test]
fn registered_complete_extent_survives_a_shorter_partial_tail() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let complete = codex("partial", "2020-01-01T00:00:00Z", "one");
    write_codex(
        &home,
        "sessions",
        "partial.jsonl",
        &format!("{complete}{{\"unfinished\":"),
    );
    let auth = authorization(ArchiveSource::Codex, ArchiveHistoryChoice::AllHistory);
    let spool = open_spool(&spool_dir, &keys);
    prepare(home.path(), &spool, std::slice::from_ref(&auth), 10);
    let first = spool.history_state(ArchiveSource::Codex).unwrap().unwrap();
    let target = first.targets()[0].clone();
    assert!(target.registered_complete_byte_offset < target.registered_size_bytes);

    fs::write(home.path().join(".codex/sessions/partial.jsonl"), complete).unwrap();
    prepare(home.path(), &spool, &[auth], 11);
    let second = spool.history_state(ArchiveSource::Codex).unwrap().unwrap();
    assert_eq!(second.targets()[0], target);
}

#[test]
fn failed_source_baseline_commit_does_not_disable_another_source() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let claude_dir = home.path().join(".claude/projects/project");
    fs::create_dir_all(&claude_dir).unwrap();
    for index in 0..100 {
        fs::write(
            claude_dir.join(format!("{index}.jsonl")),
            format!(
                "{{\"sessionId\":\"claude-{index}\",\"uuid\":\"record-{index}\",\"timestamp\":\"2020-01-01T00:00:00Z\"}}\n"
            ),
        )
        .unwrap();
    }
    write_codex(
        &home,
        "sessions",
        "codex.jsonl",
        &codex("codex-valid", "2020-01-01T00:00:00Z", "one"),
    );
    let spool = ArchiveSpool::open_with_cap(spool_dir.path(), "org_1", &keys, 2_048).unwrap();
    let prepared = prepare(
        home.path(),
        &spool,
        &[
            authorization(ArchiveSource::Claude, ArchiveHistoryChoice::AllHistory),
            authorization(ArchiveSource::Codex, ArchiveHistoryChoice::AllHistory),
        ],
        10,
    );

    assert!(prepared
        .errors
        .iter()
        .any(|error| error == "archive_history_uncommitted"));
    assert_eq!(prepared.plan.failed_sources(), &[ArchiveSource::Claude]);
    assert!(!prepared.plan.authorizes(ArchiveSource::Claude));
    assert!(prepared.plan.authorizes(ArchiveSource::Codex));
    assert!(prepared
        .snapshots
        .iter()
        .all(|snapshot| snapshot.source == ArchiveSource::Codex));
    assert!(spool
        .history_state(ArchiveSource::Claude)
        .unwrap()
        .is_none());
    assert!(spool.history_state(ArchiveSource::Codex).unwrap().is_some());
}

#[test]
fn new_only_excludes_later_parts_of_a_baseline_session() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let project = home.path().join(".claude/projects/project");
    fs::create_dir_all(&project).unwrap();
    fs::write(
        project.join("parent.jsonl"),
        b"{\"sessionId\":\"shared\",\"uuid\":\"parent\",\"timestamp\":\"2020-01-01T00:00:00Z\"}\n",
    )
    .unwrap();
    let spool = open_spool(&spool_dir, &keys);
    let auth = authorization(ArchiveSource::Claude, ArchiveHistoryChoice::NewOnly);
    prepare(home.path(), &spool, std::slice::from_ref(&auth), 10);

    let subagents = project.join("subagents");
    fs::create_dir_all(&subagents).unwrap();
    fs::write(
        subagents.join("child.jsonl"),
        b"{\"sessionId\":\"shared\",\"uuid\":\"child\",\"agentId\":\"agent-1\",\"timestamp\":\"2026-01-01T00:00:00Z\"}\n",
    )
    .unwrap();
    let prepared = prepare(home.path(), &spool, &[auth], 11);
    assert!(prepared.snapshots.is_empty());
    assert!(prepared
        .plan
        .state(ArchiveSource::Claude)
        .unwrap()
        .excludes_session("shared"));
}

#[test]
fn all_history_registers_later_old_and_unknown_sessions() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let spool = open_spool(&spool_dir, &keys);
    let auth = authorization(ArchiveSource::Codex, ArchiveHistoryChoice::AllHistory);
    prepare(home.path(), &spool, std::slice::from_ref(&auth), 10);
    write_codex(
        &home,
        "archived_sessions",
        "old.jsonl",
        &codex("later-old", "2020-01-01T00:00:00Z", "one"),
    );
    write_codex(
        &home,
        "sessions",
        "unknown.jsonl",
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"unknown\"}}\n",
    );

    let prepared = prepare(home.path(), &spool, &[auth], 11);
    let state = spool.history_state(ArchiveSource::Codex).unwrap().unwrap();
    assert!(state.contains_session("later-old"));
    assert!(state.contains_session("unknown"));
    assert_eq!(prepared.snapshots.len(), 2);
    assert!(!prepared
        .errors
        .iter()
        .any(|error| error == "archive_history_ambiguous"));
}

#[test]
fn unsupported_history_state_is_left_unchanged_and_disables_its_source() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    write_codex(
        &home,
        "sessions",
        "session.jsonl",
        &codex("session", "2020-01-01T00:00:00Z", "one"),
    );
    let spool = open_spool(&spool_dir, &keys);
    let auth = authorization(ArchiveSource::Codex, ArchiveHistoryChoice::AllHistory);
    prepare(home.path(), &spool, std::slice::from_ref(&auth), 10);
    let mut state = spool.history_state(ArchiveSource::Codex).unwrap().unwrap();
    state.version += 1;
    spool.commit_history_state(&state).unwrap();
    let path = spool_dir.path().join("history/codex.bin");
    let before = fs::read(&path).unwrap();

    let prepared = prepare(home.path(), &spool, &[auth], 11);

    assert!(prepared.snapshots.is_empty());
    assert_eq!(prepared.plan.failed_sources(), &[ArchiveSource::Codex]);
    assert!(prepared
        .errors
        .iter()
        .any(|error| error == "archive_history_unsupported_version"));
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn a_part_larger_than_the_read_budget_is_still_scheduled() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let dir = home.path().join(".codex/sessions");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("large.jsonl");
    let record = codex("large-session", "2020-01-01T00:00:00Z", "one");
    let mut prefix = Vec::new();
    while prefix.len() <= super::window::ARCHIVE_IDENTITY_PROBE_BYTES {
        prefix.extend_from_slice(record.as_bytes());
    }
    fs::write(&path, prefix).unwrap();
    let mut file = OpenOptions::new().write(true).open(&path).unwrap();
    file.set_len(super::window::ARCHIVE_BASELINE_READ_BUDGET_BYTES + 1)
        .unwrap();
    file.seek(SeekFrom::End(-1)).unwrap();
    file.write_all(b"\n").unwrap();

    let spool = open_spool(&spool_dir, &keys);
    let prepared = prepare(
        home.path(),
        &spool,
        &[authorization(
            ArchiveSource::Codex,
            ArchiveHistoryChoice::AllHistory,
        )],
        10,
    );

    assert_eq!(prepared.snapshots.len(), 1);
    assert!(prepared.snapshots[0].bytes.is_empty());
    assert!(prepared.snapshots[0].deferred_file.is_some());
}

#[test]
fn baseline_part_budget_defers_without_losing_targets() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    for index in 0..129 {
        write_codex(
            &home,
            "sessions",
            &format!("{index}.jsonl"),
            &codex(&format!("session-{index}"), "2020-01-01T00:00:00Z", "one"),
        );
    }
    let spool = open_spool(&spool_dir, &keys);
    let prepared = prepare(
        home.path(),
        &spool,
        &[authorization(
            ArchiveSource::Codex,
            ArchiveHistoryChoice::AllHistory,
        )],
        10,
    );

    assert_eq!(prepared.snapshots.len(), 128);
    assert!(prepared
        .snapshots
        .iter()
        .all(|snapshot| snapshot.bytes.is_empty() && snapshot.deferred_file.is_some()));
    assert!(prepared.errors.is_empty());
    assert_eq!(
        spool
            .history_state(ArchiveSource::Codex)
            .unwrap()
            .unwrap()
            .targets()
            .len(),
        129
    );
}

#[test]
fn corrupt_history_state_is_not_rebaselined() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    write_codex(
        &home,
        "sessions",
        "session.jsonl",
        &codex("session", "2020-01-01T00:00:00Z", "one"),
    );
    let spool = open_spool(&spool_dir, &keys);
    let auth = authorization(ArchiveSource::Codex, ArchiveHistoryChoice::AllHistory);
    prepare(home.path(), &spool, std::slice::from_ref(&auth), 10);
    let path = spool_dir.path().join("history/codex.bin");
    fs::write(&path, b"corrupt encrypted state").unwrap();
    let before = fs::read(&path).unwrap();

    let prepared = prepare(home.path(), &spool, &[auth], 11);

    assert!(prepared.snapshots.is_empty());
    assert_eq!(prepared.plan.failed_sources(), &[ArchiveSource::Codex]);
    assert!(prepared
        .errors
        .iter()
        .any(|error| error == "archive_history_corrupt"));
    assert_eq!(fs::read(path).unwrap(), before);
}
