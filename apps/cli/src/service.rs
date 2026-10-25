// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector CLI: `trace-flow service install|uninstall`.

//! Install the Collector as a systemd service, per-user or host-wide.
//!
//! `install` is the service's explicit "start syncing" step, matching the desktop's egress gate: it
//! shows exactly which agent homes will be read and asks before anything is uploaded. It writes the
//! config (only when none exists, so edits survive a reinstall), writes the unit, and restarts the
//! service so a reinstall after an upgrade runs the new binary. `uninstall` stops and removes the
//! unit but keeps the config, state, and credential; `disconnect` removes those.

use std::io::{BufRead, Write};
use std::path::Path;
use std::process::Command;

use anyhow::{bail, Context, Result};

use crate::config::Config;
use crate::report;
use crate::scope::{Layout, Scope, UNIT_NAME};

const USER_UNIT: &str = include_str!("../systemd/user.service");
const SYSTEM_UNIT: &str = include_str!("../systemd/system.service");

pub fn install(layout: &Layout, assume_yes: bool) -> Result<()> {
    // The per-user config lives in the state dir, so make that private and refuse planted entries
    // before reading or writing the config.
    layout.paths.ensure()?;
    let config = layout.config()?;
    let Some(conn) = layout.paths.load_connection()? else {
        bail!(
            "not logged in; run `trace-flow{} login` first",
            layout.scope.flag()
        );
    };
    let credentials = conn.credentials(&layout.paths);
    if !credentials.is_present(&conn.org_id) {
        bail!(
            "no Collector Credential in the {}; run `trace-flow{} login` first",
            credentials.kind().label(),
            layout.scope.flag()
        );
    }

    let new_config = match &config {
        Some(_) => None,
        None => Some(match layout.scope {
            Scope::User => Config::for_user(&layout.home, &layout.source_homes(None)?),
            Scope::System => Config::for_host(),
        }),
    };
    let effective = config
        .as_ref()
        .or(new_config.as_ref())
        .expect("one of the two is set");
    let unit_file = layout.unit_file()?;

    println!("Organization: {}", conn.org_id);
    println!(
        "Config:       {}{}",
        layout.config_file.display(),
        if new_config.is_some() { " (new)" } else { "" }
    );
    println!("Unit:         {}", unit_file.display());
    println!(
        "\nEvery {} min, these agent homes will be parsed locally and their redacted facts uploaded:",
        effective.interval_minutes
    );
    report::print_inputs(&effective.inputs, &layout.home, true);
    if !assume_yes && !confirm("\nStart syncing? [y/N] ")? {
        bail!("not installed");
    }

    if let Some(new_config) = &new_config {
        create_file(&layout.config_file, &new_config.render()?)?;
    }
    write_file(&unit_file, &render_unit(layout)?)?;
    systemctl(layout.scope, &["daemon-reload"])?;
    systemctl(layout.scope, &["enable", UNIT_NAME])?;
    systemctl(layout.scope, &["restart", UNIT_NAME])?;

    println!("\nSyncing. Edit the config to change inputs, then restart the service.");
    println!(
        "Logs:   {}",
        layout.scope.hint("journalctl", "-u trace-flow -f")
    );
    println!("Status: trace-flow{} status", layout.scope.flag());
    Ok(())
}

pub fn uninstall(layout: &Layout) -> Result<()> {
    let unit_file = layout.unit_file()?;
    if !unit_file.exists() {
        println!("Not installed ({} does not exist).", unit_file.display());
        return Ok(());
    }
    systemctl(layout.scope, &["disable", "--now", UNIT_NAME])?;
    std::fs::remove_file(&unit_file).with_context(|| format!("remove {}", unit_file.display()))?;
    systemctl(layout.scope, &["daemon-reload"])?;
    println!("Stopped and removed {}.", unit_file.display());
    println!(
        "Kept the config, sync state, and credential; `trace-flow{} disconnect` removes the login.",
        layout.scope.flag()
    );
    Ok(())
}

fn render_unit(layout: &Layout) -> Result<String> {
    let binary = std::env::current_exe()
        .and_then(|path| path.canonicalize())
        .context("locate the trace-flow binary")?;
    let template = match layout.scope {
        Scope::User => USER_UNIT,
        Scope::System => {
            ensure_root_controlled(&binary)?;
            SYSTEM_UNIT
        }
    };
    Ok(render_unit_with(template, &binary, &layout.global_args()))
}

/// The host-wide unit runs this binary as root with read access to every file, so nobody but root
/// may be able to replace it: neither the file nor any directory above it may belong to another
/// user or be group- or world-writable. A binary in a user's build or Cargo directory fails this.
#[cfg(unix)]
fn ensure_root_controlled(binary: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    for path in binary.ancestors() {
        let meta = std::fs::metadata(path).with_context(|| format!("stat {}", path.display()))?;
        if meta.uid() != 0 || meta.mode() & 0o022 != 0 {
            bail!(
                "the host-wide service runs {} as root, but {} can be changed by a non-root user; \
                 install a root-owned copy first (for example `sudo install -m 0755 {} \
                 /usr/local/bin/trace-flow`) and run `service install` from that copy",
                binary.display(),
                path.display(),
                binary.display()
            );
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_root_controlled(_binary: &Path) -> Result<()> {
    bail!("the host-wide service needs systemd on Linux")
}

fn render_unit_with(template: &str, binary: &Path, global_args: &[String]) -> String {
    let mut args = vec![binary.display().to_string()];
    args.extend_from_slice(global_args);
    args.extend(["sync".to_string(), "--watch".to_string()]);
    let exec_start = args
        .iter()
        .map(|arg| systemd_quote(arg))
        .collect::<Vec<_>>()
        .join(" ");
    template.replace("@EXEC_START@", &exec_start)
}

/// Quote one `ExecStart=` argument. systemd expands `%` specifiers even inside quotes.
fn systemd_quote(arg: &str) -> String {
    let escaped = arg
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%");
    format!("\"{escaped}\"")
}

fn systemctl(scope: Scope, args: &[&str]) -> Result<()> {
    let mut command: Command = scope.manager_command("systemctl");
    let output = command
        .args(args)
        .output()
        .context("run systemctl (is systemd running?)")?;
    if !output.status.success() {
        bail!(
            "`{}` failed: {}",
            scope.hint("systemctl", &args.join(" ")),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

/// Create `path`, which must not exist yet. `O_EXCL` also refuses a symlink planted there, so the
/// config is never written through one.
fn create_file(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => bail!(
            "{} already exists, perhaps as a dangling symlink; inspect it and run install again",
            path.display()
        ),
        Err(err) => return Err(err).with_context(|| format!("create {}", path.display())),
    };
    file.write_all(contents.as_bytes())
        .with_context(|| format!("write {}", path.display()))
}

fn write_file(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    std::fs::write(path, contents).with_context(|| format!("write {}", path.display()))
}

fn confirm(prompt: &str) -> Result<bool> {
    print!("{prompt}");
    std::io::stdout().flush()?;
    let mut answer = String::new();
    std::io::stdin().lock().read_line(&mut answer)?;
    Ok(matches!(answer.trim(), "y" | "Y" | "yes" | "Yes"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_start_arguments_are_quoted_for_systemd() {
        assert_eq!(
            systemd_quote("/opt/trace flow/bin"),
            "\"/opt/trace flow/bin\""
        );
        assert_eq!(systemd_quote("100%\"\\"), "\"100%%\\\"\\\\\"");
    }

    #[cfg(unix)]
    #[test]
    fn host_wide_refuses_a_binary_a_non_root_user_can_replace() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("trace-flow");
        std::fs::write(&binary, b"").unwrap();
        let err = ensure_root_controlled(&binary).unwrap_err().to_string();
        assert!(err.contains("non-root user"), "{err}");
    }

    #[test]
    fn rendered_units_run_the_watch_loop_with_the_same_layout() {
        let args = ["--system".to_string()];
        for template in [USER_UNIT, SYSTEM_UNIT] {
            let unit = render_unit_with(template, Path::new("/usr/bin/trace-flow"), &args);
            let exec: Vec<_> = unit
                .lines()
                .filter(|l| l.starts_with("ExecStart="))
                .collect();
            assert_eq!(
                exec,
                ["ExecStart=\"/usr/bin/trace-flow\" \"--system\" \"sync\" \"--watch\""]
            );
        }
    }
}
