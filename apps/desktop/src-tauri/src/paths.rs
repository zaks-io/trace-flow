// SPDX-License-Identifier: Apache-2.0
// Trace Flow Desktop: app config + log directory resolution. Adapted from otto-desktop's paths.rs.

//! Where the desktop app keeps its own files (logs, and the Tauri app-config dir).
//!
//! Note this is the *app's* dir, not the Collector state dir: the Collector Credential and connection
//! state live where `collector-embedder` puts them (the shared `<config_dir>/trace-flow` dir, or
//! `$TRACE_FLOW_STATE_DIR`), so a CLI login and a desktop login are interchangeable. The app dir here
//! only holds desktop-local logs.

use std::{fs, path::PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use crate::error::{DesktopError, Result};

pub fn app_config_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| DesktopError::Message(err.to_string()))?;
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn logs_dir_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let dir = app_config_dir(app)?.join("logs");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}
