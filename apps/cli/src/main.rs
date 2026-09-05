// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector CLI (`trace-flow`). A thin clap + stdout shim over `collector-embedder`, the
// shared embedder the desktop app also links (Linear TRA-112, TRA-115).

//! `trace-flow` — the Collector CLI.
//!
//! Five commands: `login` (browser device flow → Collector Credential in the OS keychain),
//! `sources list` (which agent transcript Sources are present), `sync` / its `--since` history
//! window (parse + redact + upload local transcripts to the ingest Worker), `status` (connection +
//! source counts, no secrets), and `disconnect` (revoke local material). Parsing and redaction are
//! always local; only redacted facts leave the machine, authenticated by the Collector Credential.
//!
//! All of that logic lives in [`collector_embedder`]; this binary is only argument parsing and the
//! `println!` reporting. Endpoints resolve through [`collector_embedder::defaults`] — production by
//! default, overridable per environment:
//! - `TRACE_FLOW_CONVEX_SITE_URL` — the Convex *site* origin `login` drives the device flow against.
//! - `TRACE_FLOW_INGEST_URL` — the ingest Worker base URL `sync` POSTs to.
//! - `TRACE_FLOW_COLLECTOR_SECRET` — optional headless/CI override for the keychain credential.
//!
//! With none set, the binary targets production out of the box; an env var points it at deployed dev or
//! a local Worker instead.

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use collector_contracts::AgentSource;

use collector_embedder::connection::Paths;
use collector_embedder::sources::Support;
use collector_embedder::{defaults, keychain, login, sources, sync};

use std::time::{SystemTime, UNIX_EPOCH};

const ENV_HELP: &str = "\
Environment (optional — production URLs are the default):\n  \
TRACE_FLOW_CONVEX_SITE_URL  Convex site origin for login (default: production deployment)\n  \
TRACE_FLOW_INGEST_URL       Ingest Worker base URL for sync (default: https://collector.trace-flow.dev)\n  \
TRACE_FLOW_COLLECTOR_SECRET Headless/CI credential override (normally stored in OS keychain)\n\
\n\
Local/cloud-dev: set TRACE_FLOW_CONVEX_SITE_URL and TRACE_FLOW_INGEST_URL to your dev endpoints.\n\
See apps/cli/README.md for details.";

#[derive(Parser)]
#[command(
    name = "trace-flow",
    version,
    about = "Trace Flow Collector CLI",
    after_help = ENV_HELP
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Sign in through the browser and mint a Collector Credential.
    Login,
    /// Inspect detected agent transcript sources.
    Sources {
        #[command(subcommand)]
        action: SourcesAction,
    },
    /// Parse, redact, and upload local transcripts to Trace Flow.
    Sync {
        /// How far back to scan: 24h (default incremental; resumes from the last complete sync),
        /// 7d, 30d, or 1y (history import).
        #[arg(long, default_value = "24h")]
        since: String,
    },
    /// Show connection state and per-source counts. Prints no secrets.
    Status,
    /// Revoke the local Collector Credential and remove local state.
    Disconnect,
    /// Read the local Cursor `state.vscdb` read-only and print aggregate counts only (no upload, no
    /// transcript text, paths, model names, or ids). A local verification aid for the Cursor reader.
    #[command(hide = true)]
    CursorDryrun,
}

#[derive(Subcommand)]
enum SourcesAction {
    /// List detected sources and their support status.
    List,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn home_dir() -> Result<std::path::PathBuf> {
    dirs::home_dir().context("could not resolve home directory")
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        // One clean error line plus the cause chain; no panics, no secrets (errors never carry the
        // credential — see CollectorApiClientConfig's manual Debug).
        eprintln!("error: {err:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Login => cmd_login(),
        Command::Sources { action } => match action {
            SourcesAction::List => cmd_sources_list(),
        },
        Command::Sync { since } => cmd_sync(&since).await,
        Command::Status => cmd_status(),
        Command::Disconnect => cmd_disconnect().await,
        Command::CursorDryrun => cmd_cursor_dryrun(),
    }
}

fn cmd_login() -> Result<()> {
    let conn = login::run(&defaults::convex_site_url(), &defaults::ingest_url())?;
    println!("\nConnected to organization {}.", conn.org_id);
    println!("Credential stored in the OS keychain. Next: `trace-flow sync --since 7d`.");
    Ok(())
}

fn cmd_sources_list() -> Result<()> {
    let home = home_dir()?;
    let detected = sources::detect(&home);
    println!(
        "{:<10} {:<14} {:<26} FILES",
        "SOURCE", "SUPPORT", "LOCATION"
    );
    for d in &detected {
        let support = match d.support {
            Support::Ready => "ready",
        };
        println!(
            "{:<10} {:<14} {:<26} {}",
            source_label(d.source),
            support,
            d.display_root(),
            d.file_count,
        );
    }
    Ok(())
}

async fn cmd_sync(since: &str) -> Result<()> {
    let window = sync::window_from_since(since)?;

    let paths = Paths::resolve()?;
    let Some(conn) = paths.load_connection()? else {
        anyhow::bail!("not logged in. Run `trace-flow login` first.");
    };

    let credential = keychain::load(&conn.org_id)?.ok_or_else(|| {
        anyhow::anyhow!(
            "no Collector Credential found for org {}; run `trace-flow login`",
            conn.org_id
        )
    })?;

    let ingest_url = conn.sync_ingest_url()?;

    let home = home_dir()?;
    println!("Syncing (since {since}) to {ingest_url} ...");

    let reports = sync::run(sync::RunConfig {
        ingest_url,
        credential,
        org_id: &conn.org_id,
        home: &home,
        window,
        now_ms: now_ms(),
        batch_id_prefix: "cli",
        archive: None,
        state_dir: None,
    })
    .await?;

    let mut total_advanced = 0u32;
    let mut total_failed = 0u32;
    for (source, r) in &reports {
        total_advanced += r.advanced;
        total_failed += r.failed;
        let note = if r.aborted_early {
            "  (stopped early)"
        } else {
            ""
        };
        println!(
            "  {:<8} scanned {:>4}  selected {:>4}  uploaded {:>4}  failed {:>3}{}",
            source_label(*source),
            r.source_files_scanned,
            r.selected,
            r.advanced,
            r.failed,
            note,
        );
        if let Some(err) = &r.first_error {
            println!("           reason: {err}");
        }
    }
    println!("\nUploaded {total_advanced} session(s); {total_failed} failed.");
    if total_failed > 0 {
        println!("Failed sessions kept their cursor and will retry on the next sync.");
    }
    Ok(())
}

fn cmd_status() -> Result<()> {
    let paths = Paths::resolve()?;
    let Some(conn) = paths.load_connection()? else {
        println!("Not connected. Run `trace-flow login` to get started.");
        return Ok(());
    };

    let has_credential = keychain::is_present(&conn.org_id);
    let expired = conn.expires_at <= now_ms();

    println!("Organization:  {}", conn.org_id);
    println!("Collector:     {}", conn.collector_id);
    println!("Convex:        {}", conn.convex_url);
    let ingest_url = conn
        .sync_ingest_url()
        .unwrap_or_else(|_| "MISSING (run `trace-flow login`)".to_string());
    println!("Ingest:        {ingest_url}");
    println!(
        "Credential:    {}",
        match (has_credential, expired) {
            (false, _) => "MISSING (run `trace-flow login`)",
            (true, true) => "EXPIRED (run `trace-flow login` to rotate)",
            (true, false) => "present",
        }
    );

    let home = home_dir()?;
    println!("\nSources:");
    for d in sources::detect(&home) {
        match d.support {
            Support::Ready => println!("  {:<8} {} items", source_label(d.source), d.file_count),
        }
    }
    Ok(())
}

async fn cmd_disconnect() -> Result<()> {
    let paths = Paths::resolve()?;
    let Some(conn) = paths.load_connection()? else {
        println!("Already disconnected.");
        return Ok(());
    };

    // Best-effort server-side revoke is a follow-up (needs an authenticated revoke endpoint or the
    // credential id); for now we remove the local credential and state so the secret can no longer be
    // used from this machine. The credential also expires server-side at `expires_at`.
    keychain::delete(&conn.org_id)?;
    paths.clear_connection(&conn.org_id)?;
    println!(
        "Disconnected. Local credential and cursors removed for org {}.",
        conn.org_id
    );
    Ok(())
}

fn source_label(source: AgentSource) -> &'static str {
    match source {
        AgentSource::Claude => "claude",
        AgentSource::Codex => "codex",
        AgentSource::Cursor => "cursor",
    }
}

/// Read the local Cursor `state.vscdb` read-only and print aggregate counts only. A verification aid for
/// the Cursor reader: it never uploads, and prints no transcript text, file paths, model names, or ids —
/// only totals and a token-coverage histogram, so it is safe to run and paste.
fn cmd_cursor_dryrun() -> Result<()> {
    use collector_contracts::enums::TokenCoverage;
    use collector_parser::assemble::session_facts;
    use collector_sync::{assemble_cursor_units, CursorStore, ImportWindow};

    let home = home_dir()?;
    let Some(db) = sources::cursor_db_path(&home).filter(|p| p.exists()) else {
        println!("No Cursor state.vscdb found (Cursor not installed, or unsupported platform).");
        return Ok(());
    };

    let paths = Paths::resolve()?;
    paths.ensure()?;
    // An ephemeral in-memory store means every composer reads as "changed", so the dry-run sees the
    // whole DB without touching or advancing the real per-org cursor state.
    let store = CursorStore::open_in_memory("dryrun").context("open scratch cursor store")?;
    // Admit every composer regardless of age: cutoff 0 via a first-incremental window at +24h.
    let window = ImportWindow::first_incremental(24 * 60 * 60 * 1000);

    let units = assemble_cursor_units(&db, &paths.scratch_dir(), &store, window)
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
