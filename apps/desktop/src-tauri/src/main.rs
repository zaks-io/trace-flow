// SPDX-License-Identifier: MIT
// Trace Flow Desktop entry point. The app lives in the library so the Tauri mobile/test harnesses can
// reuse it; `main` just runs it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    trace_flow_desktop_lib::run()
}
