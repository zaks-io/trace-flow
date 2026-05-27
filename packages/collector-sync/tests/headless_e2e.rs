// SPDX-License-Identifier: MIT
// Original Trace Flow code. otto-sync had no standalone end-to-end harness; this exercises the full
// Trace Flow read path (discovery -> assemble -> envelope -> live POST -> cursor) against a real
// ~/.claude corpus and the dev ingest worker. Trace Flow owns the contract, IDs, pricing, redaction,
// and storage around this code.

//! Headless end-to-end run (3d leaf 3) — the live-infra leaf, `#[ignore]` by default.
//!
//! This walks the **real** `~/.claude/projects` corpus, assembles each in-window changed file into a
//! [`SyncUnit`], and drives the production [`run_sync_cycle`] against a live dev ingest worker,
//! asserting a file's cursor advances only after its POST is accepted (`2xx`). It is `#[ignore]` so
//! `cargo test` compiles but never runs it; the unit tests across the crate cover the offline logic.
//!
//! ## Running it
//!
//! Stand up the workers (`bun run dev:all`) and the Tinybird **dev** workspace first, then:
//!
//! ```text
//! TRACE_FLOW_INGEST_URL=http://127.0.0.1:8787 \
//! TRACE_FLOW_COLLECTOR_SECRET=<a dev Collector credential> \
//! cargo test -p collector-sync --test headless_e2e -- --ignored --nocapture
//! ```
//!
//! `TRACE_FLOW_ORG_ID` is optional (the local cursor namespace; the worker derives the real org from
//! the credential). A missing required var panics with the name, since the test only runs on demand.
//!
//! ## What it proves, and what stays manual
//!
//! Client-side this asserts the bytes that leave the machine carry no home dir, username, or
//! `cost_usd`, and that cursors move only on acceptance. The **server-side** half — that real rows
//! land in `agent_messages` / `agent_file_events` / `agent_tool_events`, that no `agent_file_events`
//! path contains `/Users/`, and that `cost_usd` stays null until the consumer prices it — is a manual
//! Tinybird **dev** check (never prod); the run prints the reminder. 3d is done only once that
//! server-side check passes, not on `cargo build`.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use collector_api_client::{CollectorApiClient, CollectorApiClientConfig};
use collector_contracts::AgentSource;
use collector_parser::assemble::session_facts;
use collector_sync::{
    assemble_sync_unit, build_envelope, run_sync_cycle, select_changed, walk_transcripts,
    BatchMeta, CursorStore, GitRemoteCache, HistoryPreset, ImportWindow, Orchestrator, Trigger,
};

/// Cap the live POST volume: the corpus can hold thousands of sessions, and the most recent handful
/// is enough to prove the path end to end.
const MAX_FILES: usize = 10;

fn claude_projects_root() -> PathBuf {
    let home = std::env::var("HOME").expect("HOME is set");
    PathBuf::from(home).join(".claude").join("projects")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as i64
}

fn env_or_panic(key: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| {
        panic!(
            "{key} is required for the headless E2E. Set TRACE_FLOW_INGEST_URL and \
             TRACE_FLOW_COLLECTOR_SECRET (and optionally TRACE_FLOW_ORG_ID), then re-run with \
             `--ignored`. See this file's module docs."
        )
    })
}

#[tokio::test]
#[ignore = "live infra: needs `bun run dev:all` + a dev Collector credential; see module docs"]
async fn headless_run_posts_real_claude_transcripts_and_advances_cursors() {
    let ingest_url = env_or_panic("TRACE_FLOW_INGEST_URL");
    let secret = env_or_panic("TRACE_FLOW_COLLECTOR_SECRET");
    let org_id = std::env::var("TRACE_FLOW_ORG_ID").unwrap_or_else(|_| "e2e".to_string());

    let root = claude_projects_root();
    assert!(
        root.is_dir(),
        "no Claude transcript root at {root:?}; this E2E needs a box with real ~/.claude history"
    );

    let files = walk_transcripts(&root);
    assert!(
        !files.is_empty(),
        "discovery found no .jsonl under {root:?}"
    );

    // A throwaway cursor store: every file is unseen, so selection mirrors a first history import.
    let store = CursorStore::open_in_memory(&org_id).expect("open cursor store");
    // Widest preset so any box with history in the retention horizon yields data; MAX_FILES still
    // bounds the live POST to the most recent handful.
    let window = ImportWindow::history(HistoryPreset::LastYear, now_ms());
    let mut selected =
        select_changed(files, &store, AgentSource::Claude, window).expect("selection");
    assert!(
        !selected.is_empty(),
        "no in-window changed files; widen the window or use a box with recent history"
    );
    // `walk_transcripts` sorts ascending by mtime, so the tail is the most recent. `split_off(n)`
    // returns `self[n..]` (the recent tail we keep) and leaves the older prefix in the discarded `self`.
    if selected.len() > MAX_FILES {
        selected = selected.split_off(selected.len() - MAX_FILES);
    }

    let cache = GitRemoteCache::new();
    let meta = BatchMeta {
        source: AgentSource::Claude,
        desktop_version: "e2e".to_string(),
        parser_version: "e2e".to_string(),
        raw_upload_requested: false,
    };

    let mut units = Vec::with_capacity(selected.len());
    for file in &selected {
        units.push(
            assemble_sync_unit(file, &cache)
                .await
                .expect("assemble unit"),
        );
    }

    // Redaction gate, before any POST: the bytes that would leave the machine carry no home dir,
    // username, or cost. We inspect a structurally identical envelope — `session_facts` and
    // `build_envelope` are pure, so the only field that differs from the one `run_sync_cycle` POSTs is
    // the `collector_batch_id` string we supply here, which carries no path or cost. `repo_root` may be
    // a local `/Users/` path because it is never emitted, so the gate checks the facts, not the ctx.
    // `home` empty (e.g. a hermetic env) intentionally skips only its own check; the `/Users/` literal
    // below still runs.
    let home = std::env::var("HOME").unwrap_or_default();
    for unit in &units {
        let facts = session_facts(meta.source, &unit.records, &unit.ctx);
        let envelope = build_envelope(&meta, "e2e-preflight", facts);
        let json = serde_json::to_string(&envelope).expect("serialize envelope");
        assert!(
            !json.contains("/Users/"),
            "a fact carried a /Users/ path: redaction breach in {}",
            unit.next_cursor.file_path
        );
        assert!(
            home.is_empty() || !json.contains(&home),
            "a fact carried the home dir in {}",
            unit.next_cursor.file_path
        );
        assert!(
            !json.contains("cost_usd"),
            "a fact carried cost_usd; pricing is server-side only"
        );
        assert!(
            !unit.ctx.repo_path_fallback.contains('/'),
            "repo_path_fallback must be a bare label, got {:?}",
            unit.ctx.repo_path_fallback
        );
    }

    // Drive the production cycle against the live worker. Cursor discipline (cursor.rs): a unit's
    // cursor advances on, and only on, a `2xx`.
    let client = CollectorApiClient::new(CollectorApiClientConfig::new(ingest_url, secret))
        .expect("build api client");
    let mut orch = Orchestrator::new();
    orch.apply(Trigger::Resume);
    orch.apply(Trigger::SyncNow);
    let mut n = 0u32;
    let mut mint = || {
        n += 1;
        format!("e2e-batch-{n}")
    };

    let (report, _actions) =
        run_sync_cycle(&client, &store, &mut orch, &meta, &units, &mut mint, None)
            .await
            .expect("cursor store ok");

    assert_eq!(report.failed, 0, "a POST failed: {:?}", report.first_error);
    assert_eq!(
        report.advanced as usize,
        units.len(),
        "not every accepted unit advanced its cursor"
    );
    for unit in &units {
        let stored = store
            .get(AgentSource::Claude, &unit.next_cursor.file_path)
            .expect("cursor read")
            .expect("cursor advanced after a 2xx");
        assert_eq!(stored.byte_offset, unit.next_cursor.byte_offset);
        assert_eq!(stored.content_hash_head, unit.next_cursor.content_hash_head);
    }

    eprintln!(
        "headless E2E POSTed {} Claude session(s). Now confirm in the Tinybird DEV workspace (never \
         prod): rows landed in agent_messages / agent_file_events / agent_tool_events for this batch, \
         no agent_file_events path contains '/Users/', and cost_usd is null until the consumer prices \
         it (the Collector never sets it).",
        report.advanced
    );
}
