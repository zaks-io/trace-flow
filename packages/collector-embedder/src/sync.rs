// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector CLI: the sync embedder over collector-sync.

//! The CLI's sync embedder.
//!
//! `collector-sync` is headless and embedder-agnostic: it exposes discovery (`walk_transcripts` +
//! `select_changed`), per-file assembly (`assemble_sync_unit_from_bytes`), and the drive loop
//! (`run_sync_cycle`) that POSTs each unit and advances its cursor only on a `2xx`. This module is
//! the CLI/desktop embedder that wires those together against a real [`CollectorApiClient`] and a
//! per-org SQLite [`CursorStore`].
//!
//! Fact sync walks each Source once, narrows to in-window files, and reads each needed transcript
//! once for parsed-fact assembly.
//!
//! The window is the 24h active-session grace for `sync`, measured back from the last complete pass
//! recorded in the cursor store (or from now on the very first pass), or a `HistoryPreset` for
//! `import`/`--since`. A pass that finishes with no discovery, assembly, or ingest failures records
//! its start time as the new watermark, so time the collector spent not running is rescanned, never
//! skipped. A skipped filesystem error holds the prior watermark so unread files cannot age out.
//! Batch ids are minted per POST from a process counter seeded by the wall clock so they are unique
//! within a run without needing `Date.now()` at the cursor seam.

use std::path::Path;

use anyhow::{Context, Result};
use collector_api_client::{CollectorApiClient, CollectorApiClientConfig};
use collector_contracts::AgentSource;
use collector_sync::{
    assemble_cursor_units, run_sync_cycle, BatchMeta, CursorStore, GitRemoteCache, HistoryPreset,
    ImportWindow, Orchestrator, SyncUnit, Trigger,
};

use crate::connection::Paths;
use crate::fact_sources::FactSources;
use crate::sources::{cursor_db_path, ingestable_sources, SourceHomes};

/// The version strings the ingest worker's compatibility policy gates on. The CLI is the collector
/// "desktop" embedder; the parser version tracks the `collector-parser` crate.
pub const DESKTOP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PARSER_VERSION: &str = "0.2.0";

/// How far back a sync reaches.
#[derive(Debug, Clone, Copy)]
pub enum Window {
    /// The default scan: the 24h active-session grace before the last complete pass (or before now,
    /// when no pass has completed yet).
    Incremental,
    /// An explicit history backfill of one preset.
    History(HistoryPreset),
}

impl Window {
    fn import_window(self, now_ms: i64, last_complete_sync_at_ms: Option<i64>) -> ImportWindow {
        match self {
            Window::Incremental => match last_complete_sync_at_ms {
                Some(last) => ImportWindow::resume_incremental(last, now_ms),
                None => ImportWindow::first_incremental(now_ms),
            },
            Window::History(preset) => ImportWindow::history(preset, now_ms),
        }
    }
}

/// What one Source's pass did. Aggregated across Sources for the command's summary.
#[derive(Debug, Default, Clone)]
pub struct SourceReport {
    pub source_files_scanned: usize,
    pub selected: usize,
    pub advanced: u32,
    pub failed: u32,
    /// WalkDir or metadata errors skipped while scanning this Source. Count only — no paths.
    pub discovery_errors: u32,
    /// True when a cycle-fatal error (bad credential, too-old client, rate limit) stopped the pass.
    pub aborted_early: bool,
    /// The first ingest error class of the pass, surfaced so a failed sync says *why* (no secrets).
    pub first_error: Option<String>,
}

impl SourceReport {
    /// A pass is complete when discovery, assembly, and ingest all finish without failure.
    pub fn is_complete(&self) -> bool {
        self.failed == 0 && !self.aborted_early && self.discovery_errors == 0
    }
}

/// The inputs a sync run needs that don't come from saved state: where the ingest worker is and the
/// raw Collector Credential. Both are runtime-resolved (env / keychain), never persisted here.
pub struct RunConfig<'a> {
    pub ingest_url: String,
    pub credential: String,
    pub org_id: &'a str,
    pub home: &'a Path,
    /// Resolved transcript homes. Desktop persists this list because GUI launches may not inherit
    /// the shell environment that selected a non-default agent home.
    pub source_homes: Option<&'a SourceHomes>,
    pub window: Window,
    /// Explicitly resend facts in the selected history window without deleting local cursors.
    pub replay: bool,
    /// `now` in epoch ms, injected so the window math is testable and the cursor seam stays clock-free.
    pub now_ms: i64,
    /// A short embedder tag (e.g. `"cli"`, `"desktop"`) that prefixes the per-POST batch id, so a
    /// batch id reads as `cli-<n>` / `desktop-<n>` for audit. Not security-relevant.
    pub batch_id_prefix: &'a str,
    /// Test seam for the state directory. Production embedders leave this `None` and use [`Paths`].
    pub state_dir: Option<&'a Path>,
}

#[derive(Debug, Clone)]
pub struct SyncRunOutcome {
    pub reports: Vec<(AgentSource, SourceReport)>,
    pub discovery_passes: usize,
    pub files_read: usize,
}

/// Run a sync pass over every ingestable Source, returning one report per Source attempted.
///
/// Errors only on setup failures (bad client config, broken cursor DB). A per-envelope or cycle-fatal
/// ingest failure is captured in the [`SourceReport`], not returned as `Err`, so a bad credential on
/// Claude still lets the caller render a useful summary.
pub async fn run(cfg: RunConfig<'_>) -> Result<Vec<(AgentSource, SourceReport)>> {
    Ok(run_detailed(cfg).await?.reports)
}

pub async fn run_detailed(cfg: RunConfig<'_>) -> Result<SyncRunOutcome> {
    let resolved_source_homes;
    let source_homes = match cfg.source_homes {
        Some(homes) => homes,
        None => {
            resolved_source_homes = SourceHomes::standard(cfg.home);
            &resolved_source_homes
        }
    };
    let client = CollectorApiClient::new(CollectorApiClientConfig::new(
        cfg.ingest_url.clone(),
        cfg.credential.clone(),
    ))
    .context("build ingest client")?;

    let paths = resolve_paths(&cfg)?;
    let mut store =
        CursorStore::open(paths.cursor_db(cfg.org_id), cfg.org_id).context("open cursor store")?;
    store.set_active_parser_version(PARSER_VERSION);
    let reparse_known = store.parser_version()?.as_deref() != Some(PARSER_VERSION);
    store
        .repair_legacy_cursors_without_fact_state()
        .context("repair legacy cursor state")?;
    let needs_replay_backfill = store
        .needs_replay_backfill()
        .context("read replay backfill marker")?;
    let window = if needs_replay_backfill && matches!(cfg.window, Window::Incremental) {
        Window::History(HistoryPreset::Last7Days)
    } else {
        cfg.window
    };
    let last_complete_sync_at_ms = store
        .last_complete_sync_at_ms()
        .context("read last complete sync")?;
    let window = window.import_window(cfg.now_ms, last_complete_sync_at_ms);

    let cache = GitRemoteCache::new();
    let mut batch_seq: u64 = cfg.now_ms.max(0) as u64;
    let prefix = cfg.batch_id_prefix.to_string();
    let mut mint = move || {
        batch_seq = batch_seq.wrapping_add(1);
        format!("{prefix}-{batch_seq}")
    };

    let mut discovery_passes = 0usize;
    let mut files_read = 0usize;
    let mut reports = Vec::new();
    for source in ingestable_sources() {
        let mut report = SourceReport::default();
        let roots = source_homes.roots(source);
        store.set_replay_facts(cfg.replay);
        if roots.is_empty() {
            let units = assemble_cursor_source_units(&store, &cfg, window, &mut report)?;
            if !units.is_empty() {
                apply_fact_cycle(&client, &store, source, &units, &mut mint, &mut report).await?;
            }
        } else {
            discovery_passes += 1;
            let mut files = FactSources::discover(
                &roots,
                source,
                &store,
                window,
                cfg.replay,
                reparse_known,
                &mut report,
            )
            .context("select changed files")?;
            while let Some(units) = files.next_batch(&cache, &mut report, &mut files_read).await {
                if !units.is_empty() {
                    apply_fact_cycle(&client, &store, source, &units, &mut mint, &mut report)
                        .await?;
                }
                if report.aborted_early {
                    break;
                }
            }
        }
        let aborted_early = report.aborted_early;
        reports.push((source, report));
        if aborted_early {
            break;
        }
    }

    let complete = reports.iter().all(|(_, report)| report.is_complete());
    if complete {
        store.mark_parser_version(PARSER_VERSION)?;
        // The pass started at `now_ms`; anything modified after that is caught by the next pass's
        // grace window. A pass with discovery, assembly, or ingest failures keeps the old watermark
        // so unread or failed files stay in the next incremental window.
        store
            .mark_complete_sync(cfg.now_ms)
            .context("record complete sync")?;
    }
    if needs_replay_backfill && complete {
        store
            .mark_replay_backfill_complete()
            .context("mark replay backfill complete")?;
    }
    Ok(SyncRunOutcome {
        reports,
        discovery_passes,
        files_read,
    })
}

fn resolve_paths(cfg: &RunConfig<'_>) -> Result<Paths> {
    let paths = match cfg.state_dir {
        Some(dir) => Paths::at(dir.to_path_buf()),
        None => Paths::resolve()?,
    };
    paths.ensure()?;
    Ok(paths)
}

async fn apply_fact_cycle(
    client: &CollectorApiClient,
    store: &CursorStore,
    source: AgentSource,
    units: &[SyncUnit],
    mint: &mut dyn FnMut() -> String,
    report: &mut SourceReport,
) -> Result<()> {
    let meta = BatchMeta {
        source,
        desktop_version: DESKTOP_VERSION.to_string(),
        parser_version: PARSER_VERSION.to_string(),
    };

    let mut orch = Orchestrator::new();
    orch.apply(Trigger::Resume);
    orch.apply(Trigger::SyncNow);

    let (cycle, _actions) = run_sync_cycle(client, store, &mut orch, &meta, units, mint, None)
        .await
        .context("run sync cycle")?;

    report.advanced += cycle.advanced;
    report.failed += cycle.failed;
    report.aborted_early = cycle.aborted_early;
    if let Some(err) = &cycle.first_error {
        // The IngestError Display is a stable error class (e.g. "unauthorized", "upgrade required"),
        // never the credential or transcript text — safe to surface.
        report.first_error = Some(err.to_string());
    }
    Ok(())
}

/// Discover + assemble units for the Cursor source: snapshot `state.vscdb` read-only and assemble each
/// changed composer. A missing DB (Cursor not installed, or a non-macOS host) is a clean no-op.
fn assemble_cursor_source_units(
    store: &CursorStore,
    cfg: &RunConfig<'_>,
    window: ImportWindow,
    report: &mut SourceReport,
) -> Result<Vec<SyncUnit>> {
    let Some(db) = cursor_db_path(cfg.home).filter(|p| p.exists()) else {
        return Ok(Vec::new());
    };
    let paths = resolve_paths(cfg)?;
    let units = assemble_cursor_units(&db, &paths.scratch_dir(), store, window, cfg.replay)
        .context("assemble cursor units")?;
    // For the Cursor source, "files scanned" is the single state.vscdb; "selected" is the changed
    // composers the snapshot assembled.
    report.source_files_scanned = 1;
    report.selected = units.len();
    Ok(units)
}

/// Parse a `--since` value into a [`Window`]. Accepts the ADR presets only; an unknown value is a
/// hard error so a typo can't silently widen or narrow the import.
pub fn window_from_since(since: &str) -> Result<Window> {
    let w = match since {
        "24h" | "1d" => Window::Incremental,
        "7d" => Window::History(HistoryPreset::Last7Days),
        "30d" => Window::History(HistoryPreset::Last30Days),
        "1y" | "365d" => Window::History(HistoryPreset::LastYear),
        other => anyhow::bail!("unknown --since '{other}'; use one of: 24h, 7d, 30d, 1y"),
    };
    Ok(w)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const CLAUDE: &[u8] = br#"{"uuid":"claude-record-001","type":"user","sessionId":"claude-session-001","message":{"role":"user","content":"Inspect src/lib.rs"}}
{"uuid":"claude-record-002","type":"assistant","sessionId":"claude-session-001","message":{"id":"msg-001","role":"assistant","content":[{"type":"text","text":"I will inspect it."}]}}
"#;
    const CODEX: &[u8] = br#"{"type":"session_meta","timestamp":"2026-09-01T12:00:00.000Z","payload":{"id":"codex-session-001","cwd":"project","git":{"branch":"main","commit_hash":"0123456789abcdef0123456789abcdef01234567"}}}
{"type":"response_item","timestamp":"2026-09-01T12:00:01.000Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Inspect src/lib.rs"}]}}
"#;

    #[test]
    fn since_maps_to_the_adr_presets() {
        assert!(matches!(
            window_from_since("24h").unwrap(),
            Window::Incremental
        ));
        assert!(matches!(
            window_from_since("7d").unwrap(),
            Window::History(HistoryPreset::Last7Days)
        ));
        assert!(matches!(
            window_from_since("30d").unwrap(),
            Window::History(HistoryPreset::Last30Days)
        ));
        assert!(matches!(
            window_from_since("1y").unwrap(),
            Window::History(HistoryPreset::LastYear)
        ));
    }

    #[test]
    fn an_unknown_since_is_rejected() {
        assert!(window_from_since("2w").is_err());
        assert!(window_from_since("").is_err());
    }

    #[test]
    fn first_incremental_window_is_the_24h_grace_ending_now() {
        let now = 1_779_840_000_000;
        let w = Window::Incremental.import_window(now, None);
        assert_eq!(w.cutoff_ms(), now - 24 * 60 * 60 * 1000);
    }

    #[test]
    fn later_incremental_windows_resume_from_the_last_complete_sync() {
        let now = 1_779_840_000_000;
        let thirteen_days = 13 * 24 * 60 * 60 * 1000;
        let w = Window::Incremental.import_window(now, Some(now - thirteen_days));
        assert_eq!(w.cutoff_ms(), now - thirteen_days - 24 * 60 * 60 * 1000);
    }

    #[test]
    fn history_windows_ignore_the_watermark() {
        let now = 1_779_840_000_000;
        let w = Window::History(HistoryPreset::Last7Days).import_window(now, Some(now - 1));
        assert_eq!(w.cutoff_ms(), now - 7 * 24 * 60 * 60 * 1000);
    }

    fn write_home_transcripts(home: &Path) {
        let claude_dir = home.join(".claude").join("projects").join("p1");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(claude_dir.join("claude-session-001.jsonl"), CLAUDE).unwrap();
        let codex_dir = home.join(".codex").join("sessions").join("p1");
        std::fs::create_dir_all(&codex_dir).unwrap();
        std::fs::write(codex_dir.join("codex-session-001.jsonl"), CODEX).unwrap();
    }

    fn raw_response(status: u16, reason: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    async fn spawn_http(handler: impl Fn(Vec<u8>) -> String + Send + Sync + 'static) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = stream.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if request_complete(&buf) || buf.len() > (1 << 20) {
                        break;
                    }
                }
                let response = handler(buf);
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        format!("http://{addr}")
    }

    fn request_complete(buf: &[u8]) -> bool {
        let Some(header_end) = buf.windows(4).position(|window| window == b"\r\n\r\n") else {
            return false;
        };
        let headers = String::from_utf8_lossy(&buf[..header_end]);
        let content_length = headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        });
        match content_length {
            Some(length) => buf.len() >= header_end + 4 + length,
            None => true,
        }
    }

    async fn run_with_servers(home: &Path, state: &Path, ingest_url: String) -> SyncRunOutcome {
        run_detailed(RunConfig {
            ingest_url,
            credential: "tfc_secret".to_string(),
            org_id: "org_1",
            home,
            source_homes: None,
            window: Window::Incremental,
            replay: false,
            now_ms: 1_779_840_000_000,
            batch_id_prefix: "test",
            state_dir: Some(state),
        })
        .await
        .unwrap()
    }

    fn last_complete_sync_at_ms(state: &Path) -> Option<i64> {
        let path = Paths::at(state.to_path_buf()).cursor_db("org_1");
        CursorStore::open(path, "org_1")
            .unwrap()
            .last_complete_sync_at_ms()
            .unwrap()
    }

    fn cursor_store(state: &Path) -> CursorStore {
        CursorStore::open(Paths::at(state.to_path_buf()).cursor_db("org_1"), "org_1").unwrap()
    }

    async fn run_fact_sync(
        home: &Path,
        state: &Path,
        ingest_url: String,
        replay: bool,
        now_ms: i64,
    ) -> SyncRunOutcome {
        run_detailed(RunConfig {
            ingest_url,
            credential: "tfc_secret".to_string(),
            org_id: "org_1",
            home,
            source_homes: None,
            window: Window::Incremental,
            replay,
            now_ms,
            batch_id_prefix: "test",
            state_dir: Some(state),
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn archived_codex_transcripts_are_ingested_by_the_normal_fact_cycle() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        let archived = home.path().join(".codex").join("archived_sessions");
        std::fs::create_dir_all(&archived).unwrap();
        let transcript = archived.join("codex-session-001.jsonl");
        std::fs::write(&transcript, CODEX).unwrap();
        let hits = Arc::new(Mutex::new(0u32));
        let ingest_url = spawn_http({
            let hits = Arc::clone(&hits);
            move |_raw| {
                *hits.lock().unwrap() += 1;
                raw_response(
                    202,
                    "Accepted",
                    r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
                )
            }
        })
        .await;

        let outcome = run_fact_sync(
            home.path(),
            state.path(),
            ingest_url,
            false,
            1_779_840_000_000,
        )
        .await;
        let codex = outcome
            .reports
            .iter()
            .find(|(source, _)| *source == AgentSource::Codex)
            .unwrap();
        assert_eq!(codex.1.source_files_scanned, 1);
        assert_eq!(codex.1.selected, 1);
        assert_eq!(codex.1.advanced, 1);
        assert_eq!(*hits.lock().unwrap(), 1);
        assert!(cursor_store(state.path())
            .get(AgentSource::Codex, transcript.to_str().unwrap())
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn cycle_fatal_ingest_error_stops_before_later_sources() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        write_home_transcripts(home.path());
        let hits = Arc::new(Mutex::new(0u32));
        let ingest_url = spawn_http({
            let hits = Arc::clone(&hits);
            move |_raw| {
                *hits.lock().unwrap() += 1;
                raw_response(401, "Unauthorized", r#"{"reason":"credential_revoked"}"#)
            }
        })
        .await;

        let outcome = run_fact_sync(
            home.path(),
            state.path(),
            ingest_url,
            false,
            1_779_840_000_000,
        )
        .await;

        assert_eq!(*hits.lock().unwrap(), 1);
        assert_eq!(outcome.reports.len(), 1);
        assert_eq!(outcome.reports[0].0, AgentSource::Claude);
        assert!(outcome.reports[0].1.aborted_early);
    }

    #[tokio::test]
    async fn fact_failure_does_not_advance_the_complete_sync_watermark() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        write_home_transcripts(home.path());
        let ingest_url =
            spawn_http(|_raw| raw_response(500, "Error", r#"{"error":"ingest_failed"}"#)).await;

        let outcome = run_with_servers(home.path(), state.path(), ingest_url).await;

        assert!(outcome.reports.iter().any(|(_, report)| report.failed > 0));
        assert_eq!(last_complete_sync_at_ms(state.path()), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn discovery_errors_hold_the_watermark_so_later_passes_still_see_older_files() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{Duration, UNIX_EPOCH};

        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        let claude_dir = home.path().join(".claude/projects/p1");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(claude_dir.join("visible.jsonl"), CLAUDE).unwrap();

        let ingest_url = spawn_http(|_raw| {
            raw_response(
                202,
                "Accepted",
                r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
            )
        })
        .await;

        let t0 = 1_779_840_000_000;
        let first = run_fact_sync(home.path(), state.path(), ingest_url.clone(), false, t0).await;
        assert!(first.reports.iter().all(|(_, report)| report.is_complete()));
        assert_eq!(last_complete_sync_at_ms(state.path()), Some(t0));

        let locked = claude_dir.join("locked");
        std::fs::create_dir(&locked).unwrap();
        let hidden = locked.join("hidden.jsonl");
        std::fs::write(&hidden, CLAUDE).unwrap();
        let hidden_mtime_ms = t0 + 2 * 60 * 60 * 1000;
        std::fs::File::open(&hidden)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_millis(hidden_mtime_ms as u64))
            .unwrap();
        struct RestorePerms(std::path::PathBuf);
        impl Drop for RestorePerms {
            fn drop(&mut self) {
                let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
            }
        }
        let restore = RestorePerms(locked.clone());
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read_dir(&locked).is_ok() {
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

        let t_later = t0 + 48 * 60 * 60 * 1000;
        let blocked = run_fact_sync(
            home.path(),
            state.path(),
            ingest_url.clone(),
            false,
            t_later,
        )
        .await;
        let claude = blocked
            .reports
            .iter()
            .find(|(source, _)| *source == AgentSource::Claude)
            .unwrap()
            .1
            .clone();
        assert!(claude.discovery_errors >= 1);
        assert!(!claude.is_complete());
        assert_eq!(
            claude.first_error.as_deref(),
            Some(collector_sync::DISCOVERY_INCOMPLETE)
        );
        assert!(!claude.first_error.as_deref().unwrap_or("").contains('/'));
        assert!(!claude
            .first_error
            .as_deref()
            .unwrap_or("")
            .contains("hidden"));
        assert_eq!(last_complete_sync_at_ms(state.path()), Some(t0));
        assert!(cursor_store(state.path())
            .get(AgentSource::Claude, hidden.to_str().unwrap())
            .unwrap()
            .is_none());

        std::fs::set_permissions(&restore.0, std::fs::Permissions::from_mode(0o755)).unwrap();
        drop(restore);

        // If the blocked pass had advanced the watermark to t_later, resume_incremental would cut
        // at t_later - 24h (t0 + 24h) and drop hidden (mtime t0 + 2h). Holding t0 keeps it in scope.
        let recovered = run_fact_sync(home.path(), state.path(), ingest_url, false, t_later).await;
        let claude = recovered
            .reports
            .iter()
            .find(|(source, _)| *source == AgentSource::Claude)
            .unwrap()
            .1
            .clone();
        assert_eq!(claude.discovery_errors, 0);
        assert_eq!(claude.selected, 1);
        assert_eq!(claude.advanced, 1);
        assert!(cursor_store(state.path())
            .get(AgentSource::Claude, hidden.to_str().unwrap())
            .unwrap()
            .is_some());
        assert_eq!(last_complete_sync_at_ms(state.path()), Some(t_later));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unreadable_root_ancestor_holds_the_watermark_so_later_passes_still_see_older_files() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{Duration, UNIX_EPOCH};

        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        let claude_dir = home.path().join(".claude/projects/p1");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(claude_dir.join("visible.jsonl"), CLAUDE).unwrap();

        let ingest_url = spawn_http(|_raw| {
            raw_response(
                202,
                "Accepted",
                r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
            )
        })
        .await;

        let t0 = 1_779_840_000_000;
        let first = run_fact_sync(home.path(), state.path(), ingest_url.clone(), false, t0).await;
        assert!(first.reports.iter().all(|(_, report)| report.is_complete()));
        assert_eq!(last_complete_sync_at_ms(state.path()), Some(t0));

        let delayed = claude_dir.join("delayed.jsonl");
        std::fs::write(&delayed, CLAUDE).unwrap();
        let delayed_mtime_ms = t0 + 2 * 60 * 60 * 1000;
        std::fs::File::open(&delayed)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_millis(delayed_mtime_ms as u64))
            .unwrap();

        struct RestorePerms(std::path::PathBuf);
        impl Drop for RestorePerms {
            fn drop(&mut self) {
                let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
            }
        }
        let ancestor = home.path().join(".claude");
        let restore = RestorePerms(ancestor.clone());
        std::fs::set_permissions(&ancestor, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read_dir(&ancestor).is_ok() {
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

        let t_later = t0 + 48 * 60 * 60 * 1000;
        let blocked = run_fact_sync(
            home.path(),
            state.path(),
            ingest_url.clone(),
            false,
            t_later,
        )
        .await;
        let claude = blocked
            .reports
            .iter()
            .find(|(source, _)| *source == AgentSource::Claude)
            .unwrap()
            .1
            .clone();
        assert!(claude.discovery_errors >= 1);
        assert!(!claude.is_complete());
        assert_eq!(
            claude.first_error.as_deref(),
            Some(collector_sync::DISCOVERY_INCOMPLETE)
        );
        assert!(!claude.first_error.as_deref().unwrap_or("").contains('/'));
        assert_eq!(last_complete_sync_at_ms(state.path()), Some(t0));

        std::fs::set_permissions(&restore.0, std::fs::Permissions::from_mode(0o755)).unwrap();
        drop(restore);

        // If the blocked pass had treated the unreadable ancestor as a missing root, the watermark
        // would have advanced to t_later and resume_incremental would drop delayed (mtime t0+2h).
        let recovered = run_fact_sync(home.path(), state.path(), ingest_url, false, t_later).await;
        let claude = recovered
            .reports
            .iter()
            .find(|(source, _)| *source == AgentSource::Claude)
            .unwrap()
            .1
            .clone();
        assert_eq!(claude.discovery_errors, 0);
        assert_eq!(claude.selected, 1);
        assert_eq!(claude.advanced, 1);
        assert!(cursor_store(state.path())
            .get(AgentSource::Claude, delayed.to_str().unwrap())
            .unwrap()
            .is_some());
        assert_eq!(last_complete_sync_at_ms(state.path()), Some(t_later));
    }

    #[tokio::test]
    async fn parser_migration_reparses_known_old_transcripts_without_importing_unknown_ones() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        let claude_dir = home.path().join(".claude/projects/p1");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(claude_dir.join("known.jsonl"), CLAUDE).unwrap();
        let hits = Arc::new(Mutex::new(0u32));
        let ingest_url = spawn_http({
            let hits = Arc::clone(&hits);
            move |_raw| {
                *hits.lock().unwrap() += 1;
                raw_response(
                    202,
                    "Accepted",
                    r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
                )
            }
        })
        .await;
        run_fact_sync(
            home.path(),
            state.path(),
            ingest_url.clone(),
            false,
            1_779_840_000_000,
        )
        .await;
        std::fs::write(claude_dir.join("unknown.jsonl"), CLAUDE).unwrap();
        let mut old_store = cursor_store(state.path());
        old_store.set_active_parser_version("0.1.0");
        for cursor in old_store.list(AgentSource::Claude).unwrap() {
            old_store.advance(AgentSource::Claude, &cursor).unwrap();
        }
        old_store.mark_parser_version("0.1.0").unwrap();

        let migrated = run_fact_sync(
            home.path(),
            state.path(),
            ingest_url,
            false,
            9_000_000_000_000,
        )
        .await;
        let claude = migrated
            .reports
            .iter()
            .find(|(source, _)| *source == AgentSource::Claude)
            .unwrap()
            .1
            .clone();
        assert_eq!(claude.source_files_scanned, 2);
        assert_eq!(claude.selected, 1);
        assert_eq!(migrated.files_read, 1);
        assert_eq!(claude.advanced, 1);
        assert_eq!(*hits.lock().unwrap(), 2);
        assert_eq!(
            cursor_store(state.path())
                .parser_version()
                .unwrap()
                .as_deref(),
            Some(PARSER_VERSION)
        );
    }

    #[tokio::test]
    async fn failed_parser_migration_keeps_the_old_version_for_retry() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        let claude_dir = home.path().join(".claude/projects/p1");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(claude_dir.join("known.jsonl"), CLAUDE).unwrap();
        let accepted = spawn_http(|_raw| {
            raw_response(
                202,
                "Accepted",
                r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
            )
        })
        .await;
        run_fact_sync(
            home.path(),
            state.path(),
            accepted,
            false,
            1_779_840_000_000,
        )
        .await;
        let mut old_store = cursor_store(state.path());
        old_store.set_active_parser_version("0.1.0");
        for cursor in old_store.list(AgentSource::Claude).unwrap() {
            old_store.advance(AgentSource::Claude, &cursor).unwrap();
        }
        old_store.mark_parser_version("0.1.0").unwrap();
        let rejected =
            spawn_http(|_raw| raw_response(500, "Error", r#"{"error":"ingest_failed"}"#)).await;

        let outcome = run_fact_sync(
            home.path(),
            state.path(),
            rejected,
            false,
            9_000_000_000_000,
        )
        .await;
        assert!(outcome.reports.iter().any(|(_, report)| report.failed > 0));
        assert_eq!(
            cursor_store(state.path())
                .parser_version()
                .unwrap()
                .as_deref(),
            Some("0.1.0")
        );
    }

    #[tokio::test]
    async fn replay_resends_accepted_facts_without_deleting_cursor_state() {
        let home = tempfile::TempDir::new().unwrap();
        let state = tempfile::TempDir::new().unwrap();
        let claude_dir = home.path().join(".claude/projects/p1");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(claude_dir.join("session.jsonl"), CLAUDE).unwrap();
        let hits = Arc::new(Mutex::new(0u32));
        let ingest_url = spawn_http({
            let hits = Arc::clone(&hits);
            move |_raw| {
                *hits.lock().unwrap() += 1;
                raw_response(
                    202,
                    "Accepted",
                    r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
                )
            }
        })
        .await;
        run_fact_sync(
            home.path(),
            state.path(),
            ingest_url.clone(),
            false,
            1_779_840_000_000,
        )
        .await;
        let before = cursor_store(state.path())
            .list(AgentSource::Claude)
            .unwrap();

        let replayed = run_fact_sync(
            home.path(),
            state.path(),
            ingest_url,
            true,
            1_779_840_000_000,
        )
        .await;
        let after = cursor_store(state.path())
            .list(AgentSource::Claude)
            .unwrap();
        let claude = replayed
            .reports
            .iter()
            .find(|(source, _)| *source == AgentSource::Claude)
            .unwrap();
        assert_eq!(claude.1.advanced, 1);
        assert_eq!(*hits.lock().unwrap(), 2);
        assert_eq!(after, before);
    }
}
