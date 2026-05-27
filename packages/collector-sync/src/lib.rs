// SPDX-License-Identifier: MIT
// Crate root adapted from otto-sync/src/lib.rs (~/src/otto, 2026-05-25); the substance is vendored
// per-module (see each file's header). otto-sync's `pricing` and `provider_usage` modules are
// deliberately NOT carried over: provider-usage cost tracking is a separate Trace Flow feature, and
// pricing is server-side (the consumer prices facts, the Collector never does). Trace Flow owns the
// contract, IDs, pricing, redaction, and storage around this code.

//! Trace Flow Collector sync engine.
//!
//! The headless half of the Collector: it turns parsed `collector-parser` facts into POSTed
//! `AgentIngestEnvelope`s and advances a per-source cursor only on a `2xx`. It is decoupled from any
//! embedder (Tauri desktop, CLI) — the orchestrator state machine, FSEvents/poll watcher, and SQLite
//! cursor store are seams the embedder wires up; the SQLite, filesystem-watch, and live-POST paths
//! are exercised by the 3d headless end-to-end run, not by this crate's unit tests.
//!
//! Landed so far (3b): [`git`] — git remote resolution with a process-lifetime freeze cache.

pub mod git;

pub use git::{resolve_git_metadata, GitMetadata, GitRemoteCache};
