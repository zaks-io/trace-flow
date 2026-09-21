use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};

use collector_archive::{default_transcript_part_id, rewrite_transcript_part_id, ArchiveSource};
use collector_archive_sync::{
    capture_archive_snapshots, ArchiveAuthorizedSource, ArchiveHistoryChoice, ArchivePolicy,
    ArchiveSpool, ArchiveWorkClass, MemoryKeyStore,
};
use tempfile::TempDir;

use super::{prepare, prepare_configured, prepare_configured_incremental};
use crate::sources::SourceHomes;

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
fn new_only_admits_post_enrollment_session_on_first_cycle() {
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
    assert_eq!(first.snapshots.len(), 1);
    assert_eq!(first.snapshots[0].source_session_id, "existing");
    assert_eq!(first.snapshots[0].class, ArchiveWorkClass::Live);
    assert!(!spool
        .history_state(ArchiveSource::Codex)
        .unwrap()
        .unwrap()
        .excludes_session("existing"));
}

#[test]
fn new_only_excludes_pre_enrollment_session_on_first_cycle() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    write_codex(
        &home,
        "sessions",
        "existing.jsonl",
        &codex("existing", "2020-01-01T00:00:00Z", "one"),
    );
    let spool = open_spool(&spool_dir, &keys);
    let auth = authorization(ArchiveSource::Codex, ArchiveHistoryChoice::NewOnly);
    let first = prepare(home.path(), &spool, &[auth], 10);

    assert!(first.snapshots.is_empty());
    assert!(spool
        .history_state(ArchiveSource::Codex)
        .unwrap()
        .unwrap()
        .excludes_session("existing"));
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
    assert!(second.plan.rank_of(ArchiveSource::Codex, "new").is_some());
    assert_eq!(
        second.plan.class_for(ArchiveSource::Codex, "old"),
        ArchiveWorkClass::Baseline
    );
}

#[test]
fn codex_roots_dedupe_prefixes_and_preserve_divergence() {
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
    assert_eq!(divergent.snapshots.len(), 2);
    assert_ne!(
        divergent.snapshots[0].source_transcript_part_id,
        divergent.snapshots[1].source_transcript_part_id
    );
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
fn divergent_copies_in_three_agent_homes_get_distinct_lineages() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let codex_homes = (0..3)
        .map(|index| {
            let root = home.path().join(format!("codex-{index}"));
            let sessions = root.join("sessions");
            fs::create_dir_all(&sessions).unwrap();
            fs::write(
                sessions.join("shared.jsonl"),
                codex(
                    "shared-three-homes",
                    "2020-01-01T00:00:00Z",
                    &format!("different-{index}"),
                ),
            )
            .unwrap();
            root
        })
        .collect::<Vec<_>>();
    let homes = SourceHomes {
        claude_config_dirs: Vec::new(),
        codex_homes,
    };
    let spool = open_spool(&spool_dir, &keys);
    let auth = authorization(ArchiveSource::Codex, ArchiveHistoryChoice::AllHistory);

    let prepared = prepare_configured(&homes, &spool, &[auth], 10);
    let parts = prepared
        .snapshots
        .iter()
        .map(|snapshot| snapshot.source_transcript_part_id.as_str())
        .collect::<std::collections::HashSet<_>>();

    assert_eq!(prepared.snapshots.len(), 3);
    assert_eq!(parts.len(), 3);
    assert!(prepared
        .errors
        .iter()
        .any(|error| error == "archive_history_divergent_copy"));
}

#[test]
fn added_earlier_divergent_home_does_not_take_captured_lineage() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut codex_homes = [home.path().join("codex-a"), home.path().join("codex-b")];
    codex_homes.sort_by_key(|path| super::source_home_namespace(&path.join("sessions")));
    let earlier_home = codex_homes[0].clone();
    let captured_home = codex_homes[1].clone();
    let captured_path = captured_home.join("sessions/shared.jsonl");
    fs::create_dir_all(captured_path.parent().unwrap()).unwrap();
    let captured_bytes = codex("stable-lineage", "2020-01-01T00:00:00Z", "captured");
    fs::write(&captured_path, &captured_bytes).unwrap();
    let auth = authorization(ArchiveSource::Codex, ArchiveHistoryChoice::AllHistory);
    let mut spool = open_spool(&spool_dir, &keys);

    let first = prepare_configured(
        &SourceHomes {
            claude_config_dirs: Vec::new(),
            codex_homes: vec![captured_home.clone()],
        },
        &spool,
        std::slice::from_ref(&auth),
        10,
    );
    let base_part = first.snapshots[0].base_transcript_part_id.clone();
    let report = capture_archive_snapshots(
        &mut spool,
        &keys,
        &first.snapshots,
        ArchivePolicy::Enrolled,
        &first.plan,
        10,
        None,
    );
    assert_eq!(report.captured, 1);
    let captured_part = spool
        .current_part(ArchiveSource::Codex, "stable-lineage", &base_part)
        .unwrap();

    fs::write(
        &captured_path,
        codex("stable-lineage", "2020-01-01T00:00:00Z", "rewritten"),
    )
    .unwrap();
    let earlier_path = earlier_home.join("sessions/shared.jsonl");
    fs::create_dir_all(earlier_path.parent().unwrap()).unwrap();
    fs::write(
        &earlier_path,
        format!(
            "{captured_bytes}{{\"type\":\"event_msg\",\"payload\":{{\"id\":\"divergent\"}}}}\n"
        ),
    )
    .unwrap();

    let second = prepare_configured(
        &SourceHomes {
            claude_config_dirs: Vec::new(),
            codex_homes: vec![captured_home, earlier_home],
        },
        &spool,
        &[auth],
        11,
    );
    assert_eq!(second.snapshots.len(), 2, "{:?}", second.errors);
    let captured = second
        .snapshots
        .iter()
        .find(|snapshot| snapshot.deferred_file.as_ref().unwrap().path == captured_path)
        .unwrap();
    let added = second
        .snapshots
        .iter()
        .find(|snapshot| snapshot.deferred_file.as_ref().unwrap().path == earlier_path)
        .unwrap();
    assert_eq!(captured.source_transcript_part_id, captured_part);
    assert_eq!(
        captured.deferred_file.as_ref().unwrap().prior_offset,
        captured_bytes.len() as u64
    );
    assert_ne!(added.source_transcript_part_id, captured_part);
    assert_eq!(added.deferred_file.as_ref().unwrap().prior_offset, 0);
}

#[test]
fn new_only_copy_keeps_its_lineage_after_original_disappears() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let codex_homes = vec![home.path().join("codex-a"), home.path().join("codex-b")];
    let paths = codex_homes
        .iter()
        .enumerate()
        .map(|(index, home)| {
            let path = home.join("sessions/shared.jsonl");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(
                &path,
                codex(
                    "new-only-copy",
                    "2026-01-01T00:00:00Z",
                    &format!("divergent-{index}"),
                ),
            )
            .unwrap();
            path
        })
        .collect::<Vec<_>>();
    let homes = SourceHomes {
        claude_config_dirs: Vec::new(),
        codex_homes,
    };
    let auth = authorization(ArchiveSource::Codex, ArchiveHistoryChoice::NewOnly);
    let mut spool = open_spool(&spool_dir, &keys);

    let first = prepare_configured(&homes, &spool, std::slice::from_ref(&auth), 10);
    assert_eq!(first.snapshots.len(), 2, "{:?}", first.errors);
    let original_base = default_transcript_part_id(ArchiveSource::Codex);
    let copy = first
        .snapshots
        .iter()
        .find(|snapshot| snapshot.base_transcript_part_id != original_base)
        .unwrap();
    let copy_base = copy.base_transcript_part_id.clone();
    let copy_path = copy.deferred_file.as_ref().unwrap().path.clone();
    let original_path = paths
        .iter()
        .find(|path| **path != copy_path)
        .unwrap()
        .clone();
    let report = capture_archive_snapshots(
        &mut spool,
        &keys,
        &first.snapshots,
        ArchivePolicy::Enrolled,
        &first.plan,
        10,
        None,
    );
    assert_eq!(report.captured, 2);
    let captured_copy_part = spool
        .current_part(ArchiveSource::Codex, "new-only-copy", &copy_base)
        .unwrap();

    fs::remove_file(original_path).unwrap();
    OpenOptions::new()
        .append(true)
        .open(&copy_path)
        .unwrap()
        .write_all(b"{\"type\":\"event_msg\",\"payload\":{\"id\":\"continued\"}}\n")
        .unwrap();

    let second = prepare_configured(&homes, &spool, &[auth], 11);
    assert_eq!(second.snapshots.len(), 1, "{:?}", second.errors);
    assert_eq!(
        second.snapshots[0].source_transcript_part_id,
        captured_copy_part
    );
    assert_eq!(second.snapshots[0].base_transcript_part_id, copy_base);
}

#[test]
fn registered_extent_includes_an_unfinished_tail() {
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
    assert_eq!(
        target.registered_complete_byte_offset,
        target.registered_size_bytes
    );

    fs::write(home.path().join(".codex/sessions/partial.jsonl"), complete).unwrap();
    prepare(home.path(), &spool, &[auth], 11);
    let second = spool.history_state(ArchiveSource::Codex).unwrap().unwrap();
    assert_eq!(second.targets()[0], target);
}

#[test]
fn same_length_rewrite_is_scheduled_after_hash_verification() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let original = codex("same-size", "2020-01-01T00:00:00Z", "aaa");
    let rewritten = codex("same-size", "2020-01-01T00:00:00Z", "bbb");
    assert_eq!(original.len(), rewritten.len());
    write_codex(&home, "sessions", "same.jsonl", &original);
    let spool = open_spool(&spool_dir, &keys);
    let base_part = default_transcript_part_id(ArchiveSource::Codex);
    let checkpoint = collector_archive_sync::scan_snapshot_part(
        ArchiveSource::Codex,
        "same-size",
        &base_part,
        original.as_bytes(),
        10,
        None,
    )
    .unwrap()
    .checkpoint;
    spool
        .persist_progress(ArchiveSource::Codex, "same-size", &checkpoint)
        .unwrap();
    write_codex(&home, "sessions", "same.jsonl", &rewritten);

    let prepared = prepare(
        home.path(),
        &spool,
        &[authorization(
            ArchiveSource::Codex,
            ArchiveHistoryChoice::AllHistory,
        )],
        11,
    );

    assert_eq!(prepared.snapshots.len(), 1);
    assert_eq!(prepared.snapshots[0].class, ArchiveWorkClass::Live);
}

#[test]
fn incremental_capture_verifies_the_changed_same_length_path_only() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let original = codex("same-size-incremental", "2020-01-01T00:00:00Z", "aaa");
    let rewritten = codex("same-size-incremental", "2020-01-01T00:00:00Z", "bbb");
    assert_eq!(original.len(), rewritten.len());
    write_codex(&home, "sessions", "same.jsonl", &original);
    let path = home.path().join(".codex/sessions/same.jsonl");
    let spool = open_spool(&spool_dir, &keys);
    let part = default_transcript_part_id(ArchiveSource::Codex);
    let checkpoint = collector_archive_sync::scan_snapshot_part(
        ArchiveSource::Codex,
        "same-size-incremental",
        &part,
        original.as_bytes(),
        10,
        None,
    )
    .unwrap()
    .checkpoint;
    spool
        .persist_progress(ArchiveSource::Codex, "same-size-incremental", &checkpoint)
        .unwrap();
    fs::write(&path, rewritten).unwrap();
    let homes = SourceHomes::standard(home.path());
    let auth = authorization(ArchiveSource::Codex, ArchiveHistoryChoice::AllHistory);

    let unchanged_hint = prepare_configured_incremental(
        &homes,
        &spool,
        std::slice::from_ref(&auth),
        11,
        &std::collections::HashSet::new(),
    );
    let changed = prepare_configured_incremental(
        &homes,
        &spool,
        &[auth],
        11,
        &std::collections::HashSet::from([path]),
    );

    assert!(unchanged_hint.snapshots.is_empty());
    assert_eq!(changed.snapshots.len(), 1);
    assert_eq!(changed.snapshots[0].class, ArchiveWorkClass::Live);
}

#[test]
fn a_shrunk_candidate_is_scheduled_as_live_rewrite_work() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let original = format!(
        "{}{{\"type\":\"event_msg\",\"payload\":{{\"id\":\"two\"}}}}\n",
        codex("shrunk", "2020-01-01T00:00:00Z", "one")
    );
    write_codex(&home, "sessions", "shrunk.jsonl", &original);
    let spool = open_spool(&spool_dir, &keys);
    let base_part = default_transcript_part_id(ArchiveSource::Codex);
    let checkpoint = collector_archive_sync::scan_snapshot_part(
        ArchiveSource::Codex,
        "shrunk",
        &base_part,
        original.as_bytes(),
        10,
        None,
    )
    .unwrap()
    .checkpoint;
    spool
        .persist_progress(ArchiveSource::Codex, "shrunk", &checkpoint)
        .unwrap();
    let compacted = codex("shrunk", "2020-01-01T00:00:00Z", "compacted");
    write_codex(&home, "sessions", "shrunk.jsonl", &compacted);

    let prepared = prepare(
        home.path(),
        &spool,
        &[authorization(
            ArchiveSource::Codex,
            ArchiveHistoryChoice::AllHistory,
        )],
        11,
    );

    assert_eq!(prepared.snapshots.len(), 1);
    assert_eq!(prepared.snapshots[0].class, ArchiveWorkClass::Live);
    assert_eq!(prepared.snapshots[0].base_transcript_part_id, base_part);
}

#[test]
fn a_candidate_resolves_to_the_current_generation_part() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let bytes = codex("generation", "2026-01-01T00:00:00Z", "one");
    write_codex(&home, "sessions", "generation.jsonl", &bytes);
    let spool = open_spool(&spool_dir, &keys);
    let base_part = default_transcript_part_id(ArchiveSource::Codex);
    let current_part =
        rewrite_transcript_part_id(ArchiveSource::Codex, &base_part, bytes.as_bytes()).unwrap();
    spool
        .fork_part(
            ArchiveSource::Codex,
            "generation",
            &base_part,
            &base_part,
            &current_part,
            "prefix_changed",
            10,
        )
        .unwrap();

    let prepared = prepare(
        home.path(),
        &spool,
        &[authorization(
            ArchiveSource::Codex,
            ArchiveHistoryChoice::AllHistory,
        )],
        11,
    );

    assert_eq!(prepared.snapshots.len(), 1);
    assert_eq!(prepared.snapshots[0].base_transcript_part_id, base_part);
    assert_eq!(
        prepared.snapshots[0].source_transcript_part_id,
        current_part
    );
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
    let sources = [
        authorization(ArchiveSource::Claude, ArchiveHistoryChoice::AllHistory),
        authorization(ArchiveSource::Codex, ArchiveHistoryChoice::AllHistory),
    ];
    let spool = open_spool(&spool_dir, &keys);
    let initial = prepare(home.path(), &spool, &sources, 10);
    assert!(initial.errors.is_empty(), "{:?}", initial.errors);
    let history = spool_dir.path().join("history");
    let codex_baseline_bytes = fs::metadata(history.join("codex.bin")).unwrap().len();
    assert!(fs::metadata(history.join("claude.bin")).unwrap().len() > codex_baseline_bytes);
    fs::remove_file(history.join("claude.bin")).unwrap();
    fs::remove_file(history.join("codex.bin")).unwrap();
    // Identity sizes vary by platform. Reserve exactly the measured small baseline.
    let cap = spool.on_disk_bytes().unwrap() + codex_baseline_bytes;
    drop(spool);
    let spool = ArchiveSpool::open_with_cap(spool_dir.path(), "org_1", &keys, cap).unwrap();
    let prepared = prepare(home.path(), &spool, &sources, 10);

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
fn new_only_reports_unknown_timestamp_as_an_ambiguous_exclusion() {
    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    write_codex(
        &home,
        "sessions",
        "unknown.jsonl",
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"unknown\"}}\n",
    );
    let spool = open_spool(&spool_dir, &keys);
    let auth = authorization(ArchiveSource::Codex, ArchiveHistoryChoice::NewOnly);

    let prepared = prepare(home.path(), &spool, &[auth], 10);

    assert!(prepared.snapshots.is_empty());
    assert!(prepared.errors.is_empty());
    assert_eq!(prepared.plan.ambiguous_excluded(ArchiveSource::Codex), 1);
    assert!(prepared
        .plan
        .state(ArchiveSource::Codex)
        .unwrap()
        .excludes_session("unknown"));
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

#[cfg(unix)]
#[test]
fn unreadable_subtree_marks_archive_discovery_incomplete_without_paths() {
    use std::os::unix::fs::PermissionsExt;

    let home = TempDir::new().unwrap();
    let spool_dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    write_codex(
        &home,
        "sessions",
        "visible.jsonl",
        &codex("visible", "2026-01-01T00:00:00Z", "one"),
    );
    let locked = home.path().join(".codex").join("sessions").join("locked");
    fs::create_dir(&locked).unwrap();
    fs::write(
        locked.join("hidden.jsonl"),
        codex("hidden", "2026-01-01T00:00:00Z", "two"),
    )
    .unwrap();
    struct RestorePerms(std::path::PathBuf);
    impl Drop for RestorePerms {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
        }
    }
    let restore = RestorePerms(locked.clone());
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::read_dir(&locked).is_ok() {
        let uid = std::process::Command::new("id")
            .arg("-u")
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok());
        if uid.as_deref().map(str::trim) == Some("0") {
            return;
        }
        panic!("chmod 000 did not deny listing on a non-root process");
    }

    let spool = open_spool(&spool_dir, &keys);
    let auth = authorization(ArchiveSource::Codex, ArchiveHistoryChoice::AllHistory);
    let prepared = prepare(home.path(), &spool, std::slice::from_ref(&auth), 10);
    let _ = fs::set_permissions(&restore.0, fs::Permissions::from_mode(0o755));
    drop(restore);

    assert!(prepared
        .errors
        .iter()
        .any(|error| error == collector_sync::DISCOVERY_INCOMPLETE));
    assert!(prepared
        .errors
        .iter()
        .all(|error| !error.contains('/') && !error.contains("hidden") && !error.contains('{')));
    assert_eq!(prepared.snapshots.len(), 1);
    assert_eq!(prepared.snapshots[0].source_session_id, "visible");
}
