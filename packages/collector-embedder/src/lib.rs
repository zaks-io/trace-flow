// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector embedder: the shared library behind the CLI and the desktop app.

//! The Collector embedder.
//!
//! `collector-sync` is headless and embedder-agnostic — it owns discovery, per-file assembly, the
//! cursor store, and the drive loop, but nothing about *where* an embedder keeps its credential, which
//! Organization it is bound to, how a user logs in, or which environment it points at. This crate is
//! that embedder logic, shared so the CLI (`apps/cli`) and the desktop app (`apps/desktop`) run one
//! code path with no drift:
//!
//! - [`keychain`] — the Collector Credential in the OS keychain, keyed by Organization id.
//! - [`connection`] — the non-secret connection state + state-dir layout (shared by CLI and desktop,
//!   so a login from either is interchangeable).
//! - [`sources`] — where each agent Source writes its transcripts and which are ingestable today.
//! - [`login`] — the browser device flow that mints a Collector Credential over a loopback redirect.
//! - [`sync`] — the one-pass-per-source drive over `collector-sync` that POSTs and advances cursors
//!   only on a `2xx`. When Archive enrollment is present, the same discovery/snapshot pass feeds
//!   [`collector_archive_sync`] without a second watcher or scheduler.
//! - [`defaults`] — the production ingest + Convex-site + Archive URLs, resolved as env override →
//!   baked default so a normal user never has to know or set a URL.

pub mod archive_control;
pub mod archive_flow;
pub mod archive_http;
pub mod archive_local;
pub mod connection;
pub mod defaults;
pub mod keychain;
pub mod login;
pub mod sources;
pub mod sync;
