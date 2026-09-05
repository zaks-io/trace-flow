// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector embedder: production endpoint defaults.

//! The production endpoints, baked in so a normal user never has to know or set a URL.
//!
//! Both URLs resolve the same way: an environment override wins (so a local dev box, a smoke run, or
//! deployed dev can retarget by env alone), else the baked production default. This is the zero-config
//! path — `trace-flow login` and the desktop app reach production out of the box, and only an explicit
//! env var points them elsewhere.
//!
//! The baked values target the production resources:
//! - ingest: the `collector.trace-flow.dev/*` route on the prod `trace-flow-agent-ingest` Worker
//!   (`apps/agent-ingest/wrangler.jsonc`, `env.production.routes`).
//! - Convex site: the prod deployment's `*.convex.site` origin (the device-flow / compatibility-policy
//!   host — see `docs/guides/agent-conversation-analytics/runbook.md`).

/// Env override for the ingest Worker base URL. Mirrors the var the CLI's `sync` and the
/// `agent-ingest-smoke` harness read.
const INGEST_URL_ENV: &str = "TRACE_FLOW_INGEST_URL";

/// Env override for the Convex *site* origin the device flow drives against.
const CONVEX_SITE_URL_ENV: &str = "TRACE_FLOW_CONVEX_SITE_URL";

/// Env override for the Archive API base URL. Distinct from ingest; never a second auth path.
const ARCHIVE_URL_ENV: &str = "TRACE_FLOW_ARCHIVE_URL";

/// Production ingest Worker base URL (`POST /v1/ingest`).
pub const PROD_INGEST_URL: &str = "https://collector.trace-flow.dev";

/// Production Convex site origin (`/collector/authorize`, `/agent-ingest/compatibility-policy`).
pub const PROD_CONVEX_SITE_URL: &str = "https://laudable-bison-427.convex.site";

/// Deployed non-prod ingest Worker used by the hosted dev Convex deployment.
pub const DEV_INGEST_URL: &str = "https://trace-flow-agent-ingest-dev.isaac-a46.workers.dev";

/// Deployed non-prod Convex site origin used by the desktop/CLI dev flow.
pub const DEV_CONVEX_SITE_URL: &str = "https://hardy-iguana-812.convex.site";

/// Production Archive API base URL (`POST /v1/archive/uploads`).
pub const PROD_ARCHIVE_URL: &str = "https://archive.trace-flow.dev";

/// The ingest Worker base URL: `$TRACE_FLOW_INGEST_URL` if set and non-empty, else production.
pub fn ingest_url() -> String {
    resolve(INGEST_URL_ENV, PROD_INGEST_URL)
}

/// The Convex site origin: `$TRACE_FLOW_CONVEX_SITE_URL` if set and non-empty, else production.
pub fn convex_site_url() -> String {
    resolve(CONVEX_SITE_URL_ENV, PROD_CONVEX_SITE_URL)
}

/// The Archive API base URL: `$TRACE_FLOW_ARCHIVE_URL` if set and non-empty, else production.
pub fn archive_url() -> String {
    resolve(ARCHIVE_URL_ENV, PROD_ARCHIVE_URL)
}

pub fn ingest_url_for_convex(convex_url: &str) -> Option<&'static str> {
    let normalized = convex_url.trim_end_matches('/');
    match normalized {
        PROD_CONVEX_SITE_URL => Some(PROD_INGEST_URL),
        DEV_CONVEX_SITE_URL => Some(DEV_INGEST_URL),
        _ => None,
    }
}

fn resolve(env_key: &str, baked: &str) -> String {
    match std::env::var(env_key) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => baked.to_string(),
    }
}
