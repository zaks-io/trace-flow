// SPDX-License-Identifier: MIT
// Trace Flow Collector CLI: the sync embedder over collector-sync.

//! The CLI's sync embedder.
//!
//! `collector-sync` is headless and embedder-agnostic: it exposes discovery (`walk_transcripts` +
//! `select_changed`), per-file assembly (`assemble_sync_unit`), and the drive loop (`run_sync_cycle`)
//! that POSTs each unit and advances its cursor only on a `2xx`. This module is the CLI embedder that
//! wires those together against a real [`CollectorApiClient`] and a per-org SQLite [`CursorStore`].
//!
//! One pass per Source: walk the root, narrow to in-window changed files, assemble each into a
//! `SyncUnit`, then run one cycle. The window is the 24h active-session grace for `sync`, measured
//! back from the last complete pass recorded in the cursor store (or from now on the very first pass),
//! or a `HistoryPreset` for `import`/`--since`. A pass that finishes with no failures records its start
//! time as the new watermark, so time the collector spent not running is rescanned, never skipped.
//! Batch ids are minted per POST from a process counter seeded by the wall clock so they are unique
//! within a run without needing `Date.now()` at the cursor seam.

use std::path::Path;

use anyhow::{Context, Result};
use collector_api_client::{CollectorApiClient, CollectorApiClientConfig};
use collector_contracts::AgentSource;
use collector_sync::{
    assemble_cursor_units, assemble_sync_unit, run_sync_cycle, select_changed, walk_transcripts,
    BatchMeta, CursorStore, GitRemoteCache, HistoryPreset, ImportWindow, Orchestrator, SyncUnit,
    Trigger,
};

use crate::sources::{cursor_db_path, ingestable_sources, source_root};

/// The version strings the ingest worker's compatibility policy gates on. The CLI is the collector
/// "desktop" embedder; the parser version tracks the `collector-parser` crate.
pub const DESKTOP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PARSER_VERSION: &str = "0.1.0";

/// How many transcripts to assemble (read + parse + git resolve) concurrently. Bounded so a large
/// history import overlaps I/O without opening every file at once; the git freeze cache dedups the
/// per-repo `git` shell-outs across them.
const ASSEMBLY_CONCURRENCY: usize = 16;

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
    /// True when a cycle-fatal error (bad credential, too-old client, rate limit) stopped the pass.
    pub aborted_early: bool,
    /// The first ingest error class of the pass, surfaced so a failed sync says *why* (no secrets).
    pub first_error: Option<String>,
}

/// The inputs a sync run needs that don't come from saved state: where the ingest worker is and the
/// raw Collector Credential. Both are runtime-resolved (env / keychain), never persisted here.
pub struct RunConfig<'a> {
    pub ingest_url: String,
    pub credential: String,
    pub org_id: &'a str,
    pub home: &'a Path,
    pub window: Window,
    /// `now` in epoch ms, injected so the window math is testable and the cursor seam stays clock-free.
    pub now_ms: i64,
    /// Whether the user opted into raw-transcript upload for this run. Wires
    /// `BatchMeta.raw_upload_requested`; defaults off — the embedder never enables it implicitly.
    pub raw_upload: bool,
    /// A short embedder tag (e.g. `"cli"`, `"desktop"`) that prefixes the per-POST batch id, so a
    /// batch id reads as `cli-<n>` / `desktop-<n>` for audit. Not security-relevant.
    pub batch_id_prefix: &'a str,
}

/// Run a sync pass over every ingestable Source, returning one report per Source attempted.
///
/// Errors only on setup failures (bad client config, broken cursor DB). A per-envelope or cycle-fatal
/// ingest failure is captured in the [`SourceReport`], not returned as `Err`, so a bad credential on
/// Claude still lets the caller render a useful summary.
pub async fn run(cfg: RunConfig<'_>) -> Result<Vec<(AgentSource, SourceReport)>> {
    let client = CollectorApiClient::new(CollectorApiClientConfig::new(
        cfg.ingest_url.clone(),
        cfg.credential.clone(),
    ))
    .context("build ingest client")?;

    let store =
        CursorStore::open(crate_cursor_db(cfg.org_id)?, cfg.org_id).context("open cursor store")?;
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

    let mut reports = Vec::new();
    for source in ingestable_sources() {
        let report = run_source(&client, &store, &cache, source, &cfg, window, &mut mint).await?;
        reports.push((source, report));
    }
    let complete = reports
        .iter()
        .all(|(_, report)| report.failed == 0 && !report.aborted_early);
    if complete {
        // The pass started at `now_ms`; anything modified after that is caught by the next pass's
        // grace window. A pass with failures keeps the old watermark so the failed files stay in scope.
        store
            .mark_complete_sync(cfg.now_ms)
            .context("record complete sync")?;
    }
    if needs_replay_backfill && complete {
        store
            .mark_replay_backfill_complete()
            .context("mark replay backfill complete")?;
    }
    Ok(reports)
}

/// The cursor DB path. Split out so [`run`] stays focused; resolves through the CLI's [`Paths`].
fn crate_cursor_db(org_id: &str) -> Result<std::path::PathBuf> {
    let paths = crate::connection::Paths::resolve()?;
    paths.ensure()?;
    Ok(paths.cursor_db(org_id))
}

async fn run_source(
    client: &CollectorApiClient,
    store: &CursorStore,
    cache: &GitRemoteCache,
    source: AgentSource,
    cfg: &RunConfig<'_>,
    window: ImportWindow,
    mint: &mut dyn FnMut() -> String,
) -> Result<SourceReport> {
    let mut report = SourceReport::default();

    // Two source shapes: JSONL sources (Claude, Codex) walk a `.jsonl` root and assemble per file; the
    // Cursor source reads its `state.vscdb` SQLite store and assembles per composer. Both produce the
    // same `Vec<SyncUnit>` the shared cycle below POSTs.
    let units: Vec<SyncUnit> = match source_root(cfg.home, source) {
        Some(root) => {
            assemble_jsonl_units(store, cache, source, &root, window, &mut report).await?
        }
        None => assemble_cursor_source_units(store, cfg, window, &mut report)?,
    };
    if units.is_empty() {
        return Ok(report);
    }

    let meta = BatchMeta {
        source,
        desktop_version: DESKTOP_VERSION.to_string(),
        parser_version: PARSER_VERSION.to_string(),
        raw_upload_requested: cfg.raw_upload,
    };

    let mut orch = Orchestrator::new();
    orch.apply(Trigger::Resume);
    orch.apply(Trigger::SyncNow);

    let (cycle, _actions) = run_sync_cycle(client, store, &mut orch, &meta, &units, mint, None)
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
    Ok(report)
}

/// Discover + assemble units for a JSONL source (Claude, Codex): walk the root, narrow to in-window
/// changed files, then read + parse + (cached) git-resolve each into a `SyncUnit` concurrently.
async fn assemble_jsonl_units(
    store: &CursorStore,
    cache: &GitRemoteCache,
    source: AgentSource,
    root: &Path,
    window: ImportWindow,
    report: &mut SourceReport,
) -> Result<Vec<SyncUnit>> {
    let files = walk_transcripts(root);
    report.source_files_scanned = files.len();

    let selected = select_changed(files, store, source, window).context("select changed files")?;
    report.selected = selected.len();
    if selected.is_empty() {
        return Ok(Vec::new());
    }

    // Assemble sessions concurrently: each unit is a file read + parse + (cached) git resolve, so a
    // history import overlaps that I/O instead of doing it one transcript at a time. Bounded so a
    // 1000-file backfill doesn't open 1000 files at once. Order does not matter — the cursor for each
    // file is independent and the cycle re-groups units into batches.
    use futures_util::stream::{self, StreamExt};
    let assembled: Vec<_> = stream::iter(selected.iter())
        .map(|file| assemble_sync_unit(file, source, cache))
        .buffer_unordered(ASSEMBLY_CONCURRENCY)
        .collect()
        .await;
    let mut units = Vec::with_capacity(assembled.len());
    for result in assembled {
        match result {
            Ok(unit) => units.push(unit),
            // A file that fails to read is skipped this pass; its cursor never advanced, so it is
            // retried next pass. One unreadable transcript must not strand the whole Source, but it
            // does keep the pass incomplete (no watermark advance), so it must be visible: a stable
            // class, never the path or the transcript. An ingest error class, if one follows, wins.
            Err(_) => {
                report.failed += 1;
                report
                    .first_error
                    .get_or_insert_with(|| "unreadable transcript".to_string());
            }
        }
    }
    Ok(units)
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
    let paths = crate::connection::Paths::resolve()?;
    paths.ensure()?;
    let units = assemble_cursor_units(&db, &paths.scratch_dir(), store, window)
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
}
