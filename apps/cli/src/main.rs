// SPDX-License-Identifier: MIT
// Trace Flow Collector CLI (`trace-flow`). The user-facing collector embedder over the
// collector-parser / collector-sync / collector-api-client crates (Linear TRA-112).

//! `trace-flow` — the Collector CLI.
//!
//! Five commands: `login` (browser device flow → Collector Credential in the OS keychain),
//! `sources list` (which agent transcript Sources are present), `sync` / its `--since` history
//! window (parse + redact + upload local transcripts to the ingest Worker), `status` (connection +
//! source counts, no secrets), and `disconnect` (revoke local material). Parsing and redaction are
//! always local; only redacted facts leave the machine, authenticated by the Collector Credential.
//!
//! Runtime configuration is env-resolved, never baked in:
//! - `TRACE_FLOW_CONVEX_SITE_URL` — the Convex *site* origin `login` drives the device flow against.
//! - `TRACE_FLOW_INGEST_URL` — the ingest Worker base URL `sync` POSTs to.
//! - `TRACE_FLOW_COLLECTOR_SECRET` — optional headless/CI override for the keychain credential.
//!
//! This is what lets the same binary target Cloud-Dev or a local Worker by environment alone.

mod config;
mod keychain;
mod login;
mod sources;
mod sync;

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use collector_contracts::AgentSource;

use config::Paths;
use sources::Support;

#[derive(Parser)]
#[command(name = "trace-flow", version, about = "Trace Flow Collector CLI")]
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
        /// How far back to scan: 24h (default incremental), 7d, 30d, or 1y (history import).
        #[arg(long, default_value = "24h")]
        since: String,
    },
    /// Show connection state and per-source counts. Prints no secrets.
    Status,
    /// Revoke the local Collector Credential and remove local state.
    Disconnect,
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
    }
}

fn cmd_login() -> Result<()> {
    let convex_site_url = std::env::var("TRACE_FLOW_CONVEX_SITE_URL").context(
        "set TRACE_FLOW_CONVEX_SITE_URL to your Convex site origin (e.g. https://<deployment>.convex.site)",
    )?;
    let conn = login::run(&convex_site_url)?;
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
            Support::Unsupported => "unsupported",
        };
        let files = match d.support {
            Support::Ready => d.file_count.to_string(),
            Support::Unsupported => "-".to_string(),
        };
        println!(
            "{:<10} {:<14} {:<26} {}",
            source_label(d.source),
            support,
            d.display_root(),
            files,
        );
    }
    println!("\nCursor is not supported yet (tracked in TRA-108).");
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

    let ingest_url = std::env::var("TRACE_FLOW_INGEST_URL").context(
        "set TRACE_FLOW_INGEST_URL to the ingest Worker base URL (e.g. http://127.0.0.1:8787)",
    )?;

    let home = home_dir()?;
    println!("Syncing (since {since}) to {ingest_url} ...");

    let reports = sync::run(sync::RunConfig {
        ingest_url,
        credential,
        org_id: &conn.org_id,
        home: &home,
        window,
        now_ms: now_ms(),
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
            Support::Ready => println!("  {:<8} {} files", source_label(d.source), d.file_count),
            Support::Unsupported => {
                println!("  {:<8} unsupported (TRA-108)", source_label(d.source))
            }
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
