// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector CLI: the hidden `cursor-dryrun` verification command.

use anyhow::{Context, Result};
use collector_contracts::AgentSource;
use collector_embedder::sources;

use crate::scope::Layout;

/// Read the local Cursor `state.vscdb` read-only and print aggregate counts only. A verification aid for
/// the Cursor reader: it never uploads, and its report holds no transcript text, file paths, model
/// names, or ids, only totals and a token-coverage histogram, so it is safe to paste. Errors still name
/// the local path that failed, so the user can fix it.
pub fn run(layout: &Layout) -> Result<()> {
    use collector_contracts::enums::TokenCoverage;
    use collector_parser::assemble::session_facts;
    use collector_sync::{assemble_cursor_units, CursorStore, ImportWindow};

    let Some(db) = sources::cursor_db_path(&layout.home).filter(|p| p.exists()) else {
        println!("No Cursor state.vscdb found (Cursor not installed, or unsupported platform).");
        return Ok(());
    };

    let paths = &layout.paths;
    paths.ensure()?;
    // An ephemeral in-memory store means every composer reads as "changed", so the dry-run sees the
    // whole DB without touching or advancing the real per-org cursor state.
    let store = CursorStore::open_in_memory("dryrun").context("open scratch cursor store")?;
    // Admit every composer regardless of age: cutoff 0 via a first-incremental window at +24h.
    let window = ImportWindow::first_incremental(24 * 60 * 60 * 1000);

    let units = assemble_cursor_units(&db, &paths.scratch_dir(), &store, window, false)
        .context("assemble cursor units")?;

    let (mut messages, mut tools, mut files, mut prs) = (0usize, 0usize, 0usize, 0usize);
    let (mut partial, mut missing, mut full) = (0usize, 0usize, 0usize);
    for unit in &units {
        let facts = session_facts(AgentSource::Cursor, &unit.records, &unit.ctx);
        messages += facts.messages.len();
        tools += facts.tool_events.len();
        files += facts.file_events.len();
        prs += facts.pull_request_links.len();
        for m in &facts.messages {
            match m.token_coverage {
                TokenCoverage::Partial => partial += 1,
                TokenCoverage::Missing => missing += 1,
                TokenCoverage::Full => full += 1,
            }
        }
    }

    let pct = |n: usize| {
        if messages == 0 {
            0.0
        } else {
            100.0 * n as f64 / messages as f64
        }
    };
    println!("Cursor state.vscdb dry-run (read-only, counts only):");
    println!("  composers (sessions): {}", units.len());
    println!("  messages:             {messages}");
    println!("  tool events:          {tools}");
    println!("  file events:          {files}");
    println!("  pr links:             {prs}");
    println!("  token coverage:");
    println!("    partial: {partial:>7}  ({:.1}%)", pct(partial));
    println!("    missing: {missing:>7}  ({:.1}%)", pct(missing));
    println!(
        "    full:    {full:>7}  ({:.1}%)   (expected 0 — Cursor never reports full coverage)",
        pct(full)
    );
    Ok(())
}
