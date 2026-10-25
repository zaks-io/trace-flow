// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector CLI (`trace-flow`). A thin clap + stdout shim over `collector-embedder`, the
// shared embedder the desktop app also links.

//! `trace-flow` — the Collector CLI.
//!
//! `login` (browser sign-in → Collector Credential in the credential store), `sources list` (which
//! agent transcript Sources are present), `sync` (parse + redact + upload once, or `--watch` to keep
//! syncing as a service), `service install|uninstall` (run `sync --watch` under systemd), `status`
//! (connection, sources, and service state, no secrets), and `disconnect` (remove local material).
//! Parsing and redaction are always local; only redacted facts leave the machine.
//!
//! `--system` switches every command to the host-wide layout (see [`scope`]); `--config` points at a
//! `collector.toml` other than the scope's default (see [`config`]). Endpoints resolve through
//! [`collector_embedder::defaults`]: production by default, overridable per environment:
//! - `TRACE_FLOW_CONVEX_SITE_URL` — the Convex *site* origin `login` drives the device flow against.
//! - `TRACE_FLOW_INGEST_URL` — the ingest Worker base URL a new login binds to.
//! - `TRACE_FLOW_COLLECTOR_SECRET` — optional CI override for the stored credential.

mod config;
mod cursor_dryrun;
mod report;
mod scope;
mod service;
mod watch;

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use collector_embedder::keychain::CredentialStore;
use collector_embedder::login::{self, Callback};
use collector_embedder::sources::{self, Support};
use collector_embedder::{defaults, sync};

use crate::config::{Config, ConfigError};
use crate::scope::{Layout, Scope};

const ENV_HELP: &str = "\
Environment (optional — production URLs are the default):\n  \
TRACE_FLOW_CONVEX_SITE_URL  Convex site origin for login (default: production deployment)\n  \
TRACE_FLOW_INGEST_URL       Ingest Worker base URL a new login binds to (default: https://collector.trace-flow.dev)\n  \
TRACE_FLOW_COLLECTOR_SECRET CI credential override (normally kept in the credential store)\n\
\n\
Local/dev: set TRACE_FLOW_CONVEX_SITE_URL and TRACE_FLOW_INGEST_URL to your dev endpoints.\n\
See apps/cli/README.md for details.";

/// `EX_CONFIG`: the unit files tell systemd not to restart on it.
const EXIT_CONFIG: i32 = 78;

#[derive(Parser)]
#[command(
    name = "trace-flow",
    version,
    about = "Trace Flow Collector CLI",
    after_help = ENV_HELP
)]
struct Cli {
    /// Use the host-wide layout: /etc/trace-flow/collector.toml, state in /var/lib/trace-flow, and
    /// a system service that reads every configured user's agent homes. Run as root.
    #[arg(long, global = true)]
    system: bool,
    /// Read this collector.toml instead of the default for the chosen layout.
    #[arg(long, global = true, env = "TRACE_FLOW_CONFIG")]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Sign in through the browser and mint a Collector Credential.
    Login {
        /// Sign in from a browser on another machine, then paste the address it ends on here.
        #[arg(long)]
        no_browser: bool,
    },
    /// Inspect detected agent transcript sources.
    Sources {
        #[command(subcommand)]
        action: SourcesAction,
    },
    /// Parse, redact, and upload local transcripts to Trace Flow.
    Sync {
        /// How far back to scan: 24h (default incremental; resumes from the last complete sync),
        /// 7d, 30d, or 1y (history import).
        #[arg(long, default_value = "24h", conflicts_with = "watch")]
        since: String,
        /// Resend facts from every supported source in this window, preserving local cursor evidence.
        #[arg(long, conflicts_with = "watch")]
        replay: bool,
        /// Keep syncing every few minutes until stopped. This is what the service runs.
        #[arg(long)]
        watch: bool,
    },
    /// Run `sync --watch` as a systemd service.
    Service {
        #[command(subcommand)]
        action: ServiceAction,
    },
    /// Show connection, source, and service state. Prints no secrets.
    Status,
    /// Remove the local Collector Credential and sync state.
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

#[derive(Subcommand)]
enum ServiceAction {
    /// Show the agent homes the service will read, confirm, then install and start it.
    Install {
        /// Skip the confirmation prompt.
        #[arg(long)]
        yes: bool,
    },
    /// Stop and remove the service, keeping its config, state, and login.
    Uninstall,
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        // One clean error line plus the cause chain; no panics, no secrets (errors never carry the
        // credential — see CollectorApiClientConfig's manual Debug).
        eprintln!("error: {err:#}");
        let code = if err.downcast_ref::<ConfigError>().is_some() {
            EXIT_CONFIG
        } else {
            1
        };
        std::process::exit(code);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();
    let scope = if cli.system {
        Scope::System
    } else {
        Scope::User
    };
    let config_override = cli
        .config
        .map(|path| std::path::absolute(&path).context("resolve --config path"))
        .transpose()?;
    let layout = Layout::resolve(scope, config_override)?;
    let creates_config = matches!(
        cli.command,
        Command::Service {
            action: ServiceAction::Install { .. }
        }
    );
    let config = layout.load_config(creates_config)?;
    let credentials = layout.credentials(config.as_ref());

    match cli.command {
        Command::Login { no_browser } => cmd_login(&layout, &credentials, no_browser),
        Command::Sources { action } => match action {
            SourcesAction::List => cmd_sources_list(&layout, config.as_ref()),
        },
        Command::Sync { watch: true, .. } => {
            watch::run(&layout, config.as_ref(), &credentials).await
        }
        Command::Sync { since, replay, .. } => {
            cmd_sync(&layout, config.as_ref(), &credentials, &since, replay).await
        }
        Command::Service { action } => match action {
            ServiceAction::Install { yes } => {
                service::install(&layout, config.as_ref(), &credentials, yes)
            }
            ServiceAction::Uninstall => service::uninstall(&layout),
        },
        Command::Status => cmd_status(&layout, config.as_ref(), &credentials),
        Command::Disconnect => cmd_disconnect(&layout, &credentials),
        Command::CursorDryrun => cursor_dryrun::run(&layout),
    }
}

fn cmd_login(layout: &Layout, credentials: &CredentialStore, no_browser: bool) -> Result<()> {
    let callback = if no_browser {
        Callback::Pasted
    } else {
        Callback::Loopback
    };
    let conn = login::run(
        &defaults::convex_site_url(),
        &defaults::ingest_url(),
        &layout.paths,
        credentials,
        callback,
    )?;
    println!("\nConnected to organization {}.", conn.org_id);
    println!(
        "Credential stored in the {}. Next: `trace-flow{} service install` to keep syncing, or \
         `trace-flow{} sync --since 7d` once.",
        credentials.kind().label(),
        layout.scope.flag(),
        layout.scope.flag()
    );
    Ok(())
}

fn cmd_sources_list(layout: &Layout, config: Option<&Config>) -> Result<()> {
    if let Some(config) = config {
        println!("Inputs from {}:", layout.config_file.display());
        report::print_inputs(&config.inputs, &layout.home, false);
        return Ok(());
    }
    let homes = layout.source_homes(None)?;
    println!(
        "{:<10} {:<14} {:<26} FILES",
        "SOURCE", "SUPPORT", "LOCATION"
    );
    for d in sources::detect_configured(&homes, &layout.home) {
        let support = match d.support {
            Support::Ready => "ready",
        };
        println!(
            "{:<10} {:<14} {:<26} {}",
            report::source_label(d.source),
            support,
            d.display_root(),
            d.file_count,
        );
    }
    Ok(())
}

async fn cmd_sync(
    layout: &Layout,
    config: Option<&Config>,
    credentials: &CredentialStore,
    since: &str,
    replay: bool,
) -> Result<()> {
    let window = sync::window_from_since(since)?;

    let login_hint = format!("run `trace-flow{} login`", layout.scope.flag());
    let Some(conn) = layout.paths.load_connection()? else {
        anyhow::bail!("not logged in. {login_hint} first.");
    };
    let credential = credentials.load(&conn.org_id)?.ok_or_else(|| {
        anyhow::anyhow!(
            "no Collector Credential found for org {}; {login_hint}",
            conn.org_id
        )
    })?;
    let ingest_url = conn.sync_ingest_url()?;
    let source_homes = layout.source_homes(config)?;
    println!("Syncing (since {since}) to {ingest_url} ...");

    let reports = sync::run(sync::RunConfig {
        ingest_url,
        credential,
        org_id: &conn.org_id,
        home: &layout.home,
        source_homes: Some(&source_homes),
        window,
        replay,
        now_ms: watch::now_ms(),
        batch_id_prefix: "cli",
        state_dir: Some(layout.paths.root()),
    })
    .await?;

    let (total_advanced, total_failed) = report::print_reports(&reports);
    println!("\nUploaded {total_advanced} session(s); {total_failed} failed.");
    if total_failed > 0 {
        println!("Failed sessions kept their cursor and will retry on the next sync.");
    }
    ensure_sync_succeeded(total_failed)
}

fn ensure_sync_succeeded(total_failed: u32) -> Result<()> {
    if total_failed > 0 {
        anyhow::bail!("sync failed for {total_failed} session(s)");
    }
    Ok(())
}

fn cmd_status(
    layout: &Layout,
    config: Option<&Config>,
    credentials: &CredentialStore,
) -> Result<()> {
    let Some(conn) = layout.paths.load_connection()? else {
        println!(
            "Not connected. Run `trace-flow{} login` to get started.",
            layout.scope.flag()
        );
        return Ok(());
    };

    println!("Organization:  {}", conn.org_id);
    println!("Collector:     {}", conn.collector_id);
    println!("Convex:        {}", conn.convex_url);
    let ingest_url = conn
        .sync_ingest_url()
        .unwrap_or_else(|_| "MISSING (log in again)".to_string());
    println!("Ingest:        {ingest_url}");
    let credential = if credentials.is_present(&conn.org_id) {
        "present"
    } else {
        "MISSING (log in again)"
    };
    println!(
        "Credential:    {credential} ({})",
        credentials.kind().label()
    );

    let installed = layout.unit_file()?.exists();
    println!(
        "Service:       {}",
        if installed {
            "installed"
        } else {
            "not installed"
        }
    );
    let state = watch::load_state(&watch::state_file(layout.paths.root()))?.for_org(&conn.org_id);
    if let Some(cycle) = &state.last_cycle {
        let age_min = (watch::now_ms() - cycle.finished_at_ms).max(0) / 60_000;
        let result = match &cycle.error {
            Some(err) => format!("failed: {err}"),
            None => format!("uploaded {}, failed {}", cycle.uploaded, cycle.failed),
        };
        println!("Last cycle:    {age_min} min ago, {result}");
    }

    match config {
        Some(config) => {
            println!("\nInputs:");
            report::print_inputs(&config.inputs, &layout.home, false);
        }
        None => {
            println!("\nSources (default homes; no collector.toml):");
            for d in sources::detect_configured(&layout.source_homes(None)?, &layout.home) {
                match d.support {
                    Support::Ready => println!(
                        "  {:<8} {} items",
                        report::source_label(d.source),
                        d.file_count
                    ),
                }
            }
        }
    }
    Ok(())
}

fn cmd_disconnect(layout: &Layout, credentials: &CredentialStore) -> Result<()> {
    let Some(conn) = layout.paths.load_connection()? else {
        println!("Already disconnected.");
        return Ok(());
    };

    // Best-effort server-side revoke is a follow-up (needs an authenticated revoke endpoint or the
    // credential id); for now we remove the local credential and state so the secret can no longer be
    // used from this machine.
    credentials.delete(&conn.org_id)?;
    layout.paths.clear_connection(&conn.org_id)?;
    // The cursors are gone, so a later login must run the first-run backfill again.
    match std::fs::remove_file(watch::state_file(layout.paths.root())) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err).context("remove service state"),
    }
    println!(
        "Disconnected. Local credential and cursors removed for org {}.",
        conn.org_id
    );
    if layout.unit_file()?.exists() {
        println!(
            "The service is still installed; `trace-flow{} service uninstall` removes it.",
            layout.scope.flag()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ensure_sync_succeeded;

    #[test]
    fn failed_sessions_make_sync_return_an_error() {
        assert!(ensure_sync_succeeded(0).is_ok());
        assert_eq!(
            ensure_sync_succeeded(2).unwrap_err().to_string(),
            "sync failed for 2 session(s)"
        );
    }
}
