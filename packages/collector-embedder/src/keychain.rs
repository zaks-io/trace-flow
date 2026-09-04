// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector CLI: Collector Credential storage in the OS keychain.

//! The Collector Credential store.
//!
//! The raw credential (`tfc_…`) is the only sensitive material the CLI holds. It is kept in the OS
//! keychain (Keychain on macOS, Secret Service on Linux, Credential Manager on Windows) via the
//! `keyring` crate, keyed by Organization id so disconnecting one org never touches another. It is
//! never written to the config dir, never logged, never passed on argv.
//!
//! `TRACE_FLOW_COLLECTOR_SECRET` overrides the keychain when set. That is the headless/CI path (the
//! same var `collector-sync`'s `headless_e2e` reads) — a box with no keychain, or an automated run,
//! supplies the credential through the environment instead. An env override is read but never
//! persisted.

use anyhow::{Context, Result};

/// The keychain service name. One service, one entry per org (the account).
const SERVICE: &str = "trace-flow-collector";

/// Env override for headless/CI use. Mirrors `collector-sync`'s E2E harness var.
const ENV_OVERRIDE: &str = "TRACE_FLOW_COLLECTOR_SECRET";

/// Store the `credential` for `org_id` in the OS keychain, replacing any existing entry.
pub fn store(org_id: &str, credential: &str) -> Result<()> {
    let entry = keyring::Entry::new(SERVICE, org_id).context("open keychain entry")?;
    entry
        .set_password(credential)
        .context("write Collector Credential to OS keychain")
}

/// Load the credential for `org_id`. Prefers `$TRACE_FLOW_COLLECTOR_SECRET` (headless/CI), else the OS
/// keychain. `Ok(None)` means none is available — the caller surfaces a "log in first" message.
pub fn load(org_id: &str) -> Result<Option<String>> {
    if let Some(env) = std::env::var_os(ENV_OVERRIDE) {
        let value = env.to_string_lossy().into_owned();
        if !value.is_empty() {
            return Ok(Some(value));
        }
    }
    let entry = keyring::Entry::new(SERVICE, org_id).context("open keychain entry")?;
    match entry.get_password() {
        Ok(credential) => Ok(Some(credential)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err).context("read Collector Credential from OS keychain"),
    }
}

/// Remove the keychain entry for `org_id`. Missing entry is not an error (disconnect is idempotent).
/// Does not clear an env override — that is the operator's to unset.
pub fn delete(org_id: &str) -> Result<()> {
    let entry = keyring::Entry::new(SERVICE, org_id).context("open keychain entry")?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err).context("remove Collector Credential from OS keychain"),
    }
}

/// Whether a credential is currently available for `org_id` (env override or keychain), without
/// copying it out. Used by `status`.
pub fn is_present(org_id: &str) -> bool {
    load(org_id).ok().flatten().is_some()
}
