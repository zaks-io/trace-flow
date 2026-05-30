// SPDX-License-Identifier: MIT
// Trace Flow Collector embedder: production endpoint defaults.

//! The production endpoints, baked in so a normal user never has to know or set a URL.
//!
//! Both URLs resolve the same way: an environment override wins (so a dev box, a smoke run, or
//! Cloud-Dev can retarget by env alone), else the baked production default. This is the zero-config
//! path — `trace-flow login` and the desktop app reach production out of the box, and only an explicit
//! env var points them elsewhere (TRA-120).
//!
//! The baked values are the production resources stood up in TRA-110:
//! - ingest: the `collector.trace-flow.dev/*` route on the prod `trace-flow-agent-ingest` Worker
//!   (`apps/agent-ingest/wrangler.jsonc`, `env.production.routes`).
//! - Convex site: the prod deployment's `*.convex.site` origin (the device-flow / compatibility-policy
//!   host — see `docs/guides/agent-conversation-analytics/runbook.md`).

/// Env override for the ingest Worker base URL. Mirrors the var the CLI's `sync` and the
/// `agent-ingest-smoke` harness read.
const INGEST_URL_ENV: &str = "TRACE_FLOW_INGEST_URL";

/// Env override for the Convex *site* origin the device flow drives against.
const CONVEX_SITE_URL_ENV: &str = "TRACE_FLOW_CONVEX_SITE_URL";

/// Production ingest Worker base URL (`POST /v1/ingest`).
pub const PROD_INGEST_URL: &str = "https://collector.trace-flow.dev";

/// Production Convex site origin (`/collector/authorize`, `/agent-ingest/compatibility-policy`).
pub const PROD_CONVEX_SITE_URL: &str = "https://laudable-bison-427.convex.site";

/// The ingest Worker base URL: `$TRACE_FLOW_INGEST_URL` if set and non-empty, else production.
pub fn ingest_url() -> String {
    resolve(INGEST_URL_ENV, PROD_INGEST_URL)
}

/// The Convex site origin: `$TRACE_FLOW_CONVEX_SITE_URL` if set and non-empty, else production.
pub fn convex_site_url() -> String {
    resolve(CONVEX_SITE_URL_ENV, PROD_CONVEX_SITE_URL)
}

fn resolve(env_key: &str, baked: &str) -> String {
    match std::env::var(env_key) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => baked.to_string(),
    }
}
