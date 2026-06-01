// SPDX-License-Identifier: MIT
// Trace Flow Desktop: "Start at login", with a macOS-specific LaunchAgent writer.

//! Cross-platform facade over autostart so the tray and setup code stay platform-agnostic.
//!
//! - **Windows**: delegate to `tauri-plugin-autostart` (registry Run key) unchanged.
//! - **macOS**: write the LaunchAgent plist ourselves instead of using the plugin. `auto-launch` (what
//!   the plugin wraps) emits a minimal plist with only `Label`, `ProgramArguments`, and `RunAtLoad`.
//!   macOS runs that at login, but with no `AssociatedBundleIdentifiers` key it can't tie the agent to
//!   our visible `.app`, so the toggle never appears in System Settings → Login Items — to the user
//!   that reads as "Start at login does nothing". Adding `AssociatedBundleIdentifiers` is the
//!   documented fix, and the plugin gives us no hook to inject it, so on macOS we own the file.

use tauri::{AppHandle, Runtime};

use crate::error::Result;

/// Whether autostart is currently enabled. Source of truth for the menu checkbox.
pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> Result<bool> {
    imp::is_enabled(app)
}

/// Enable autostart (run at next login).
pub fn enable<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    imp::enable(app)
}

/// Disable autostart.
pub fn disable<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    imp::disable(app)
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::{AppHandle, Runtime};
    use tauri_plugin_autostart::ManagerExt;

    use crate::error::{DesktopError, Result};

    fn map(err: tauri_plugin_autostart::Error) -> DesktopError {
        DesktopError::Message(err.to_string())
    }

    pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> Result<bool> {
        app.autolaunch().is_enabled().map_err(map)
    }

    pub fn enable<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
        app.autolaunch().enable().map_err(map)
    }

    pub fn disable<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
        app.autolaunch().disable().map_err(map)
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::fs;
    use std::path::PathBuf;

    use tauri::{AppHandle, Runtime};

    use crate::error::{DesktopError, Result};

    /// Absolute path to the per-user LaunchAgents directory. Errors if `$HOME` can't be resolved,
    /// rather than silently writing somewhere unexpected.
    fn launch_agents_dir() -> Result<PathBuf> {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| DesktopError::Message("could not resolve $HOME".into()))?;
        Ok(PathBuf::from(home).join("Library").join("LaunchAgents"))
    }

    /// The plist filename is the bundle identifier (`dev.traceflow.desktop.plist`) — the macOS
    /// convention, and stable across renames of the user-facing product name.
    fn plist_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
        let identifier = &app.config().identifier;
        Ok(launch_agents_dir()?.join(format!("{identifier}.plist")))
    }

    /// Absolute path to the running executable. launchd needs the binary inside the bundle
    /// (`…/Trace Flow Desktop.app/Contents/MacOS/trace-flow-desktop`), which is exactly what
    /// `current_exe` returns for a bundled app.
    fn executable_path() -> Result<String> {
        let exe = std::env::current_exe()
            .map_err(|err| DesktopError::Message(format!("resolve current exe: {err}")))?;
        let exe = exe
            .canonicalize()
            .map_err(|err| DesktopError::Message(format!("canonicalize exe path: {err}")))?;
        exe.into_os_string()
            .into_string()
            .map_err(|_| DesktopError::Message("executable path is not valid UTF-8".into()))
    }

    fn plist_contents(identifier: &str, exe_path: &str) -> String {
        // `AssociatedBundleIdentifiers` surfaces this agent under the app's name in Login Items.
        // `ProcessType = Interactive` marks it as a user-facing GUI agent, not a background daemon.
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{identifier}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{exe_path}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>AssociatedBundleIdentifiers</key>
    <array>
        <string>{identifier}</string>
    </array>
</dict>
</plist>
"#
        )
    }

    pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> Result<bool> {
        Ok(plist_path(app)?.exists())
    }

    pub fn enable<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
        let dir = launch_agents_dir()?;
        if !dir.exists() {
            fs::create_dir_all(&dir)
                .map_err(|err| DesktopError::Message(format!("create LaunchAgents dir: {err}")))?;
        }
        let identifier = app.config().identifier.clone();
        let contents = plist_contents(&identifier, &executable_path()?);
        let path = plist_path(app)?;
        fs::write(&path, contents)
            .map_err(|err| DesktopError::Message(format!("write LaunchAgent plist: {err}")))?;
        Ok(())
    }

    pub fn disable<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
        let path = plist_path(app)?;
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|err| DesktopError::Message(format!("remove LaunchAgent plist: {err}")))?;
        }
        Ok(())
    }
}
