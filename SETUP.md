# Setup Instructions

This file is the setup map. For architecture details, read `specs/architecture/overview.md` and
`specs/architecture/workers.md`. For agent analytics production gates, read
`docs/guides/agent-conversation-analytics/ROADMAP.md` and
`docs/guides/agent-conversation-analytics/runbook.md`.

## Local Development

The scripted contract provisions **Self-Contained Local**. It does not connect to a Cloud-Dev data
plane unless you explicitly supply the Cloud-Dev endpoints and tokens described in
`docs/agents/local-environment.md`.

```bash
scripts/dev/install.sh
scripts/dev/start.sh
scripts/dev/workers.sh
scripts/dev/web.sh
scripts/dev/smoke.sh
scripts/dev/verify.sh
```

`scripts/dev/start.sh` provisions Self-Contained Local by default:

- Tinybird Local with committed `datasources/`, `materializations/`, `pipes/`, and `tests/`
- generated ignored Worker `.dev.vars`
- generated `apps/web/.env.local`
- generated `.trace-flow/dev.env`

`scripts/dev/workers.sh` runs the six non-Web Workers together with shared local state:

- `apps/proxy`
- `apps/proxy-consumer`
- `apps/api` (Raw API)
- `apps/pipes-api`
- `apps/agent-ingest`
- `apps/agent-consumer`

It does not start Web, Convex, MCP, Analyst Sandbox, or Archive API. Archive API is an intentionally
disabled authorization scaffold with no persistence or production environment.

Run Convex and Web separately:

```bash
scripts/dev/convex.sh
scripts/dev/web.sh
```

For day-to-day Cloud-Dev collector testing, run Web locally but point the collector at the deployed
cloud `-dev` Agent Ingest Worker and the Convex Cloud dev site. The collector embeds production URLs,
so both `TRACE_FLOW_INGEST_URL` and `TRACE_FLOW_CONVEX_SITE_URL` must be set for Cloud-Dev. See
`docs/agents/local-environment.md` and `CONTEXT.md` for the exact environment vocabulary and script
switches.

## Cloudflare Resources

The production runtime uses these Cloudflare resource families:

| Resource         | Model request path                          | Agent conversation path                        | Shared/read path                                    |
| ---------------- | ------------------------------------------- | ---------------------------------------------- | --------------------------------------------------- |
| Workers          | `proxy`, `proxy-consumer`                   | `agent-ingest`, `agent-consumer`               | `web`, `pipes-api`, `api`, `mcp`, `analyst-sandbox` |
| Queues           | `trace-flow-requests-*` + DLQ               | `agent-ingest-*` + DLQ                         | None                                                |
| R2               | `trace-flow-storage-*` Body Objects         | None in fact ingest; sandbox workspace backups | Archive bucket is not enabled                       |
| KV               | `API_KEYS`, `MODEL_PRICING`                 | `COLLECTOR_CREDS`, `MODEL_PRICING`             | None                                                |
| Durable Objects  | `USAGE_TRACKER`, `TRACE_BATCHER`            | `AGENT_FACT_BATCHER`                           | `Sandbox`                                           |
| Rate limiters    | org and IP ingest limits                    | `AGENT_INGEST_LIMITER`                         | read and token-refresh limits                       |
| Analytics Engine | proxy and consumer operational measurements | Worker logs and Sentry                         | Worker logs and Sentry                              |

The agent production resource IDs and smoke-test contract live in
`docs/guides/agent-conversation-analytics/provisioned-resources.md` and
`docs/guides/agent-conversation-analytics/runbook.md`.

## Tinybird

The Tinybird project is committed in the repo:

- `otel_trace_spans` plus derived LLM usage datasources
- `agent_*` fact, rollup, repository, and session-summary datasources
- trace, usage, operations, MCP, and agent dashboard pipes
- Tinybird Local tests under `tests/`

Validate locally:

```bash
tb build
tb test run
```

The production deploy workflow runs `scripts/deploy-agent-tinybird.sh` before consumer Workers deploy,
so the proxy and agent consumers never ship ahead of the live schema.

## Secrets

Set secrets through the owning platform only. Do not commit them.

### Worker Secrets

| Worker            | Secrets                                                                           |
| ----------------- | --------------------------------------------------------------------------------- |
| `proxy`           | `USAGE_SYNC_SECRET`, `SENTRY_DSN`, `AXIOM_TOKEN`, `BODY_ENCRYPTION_ROOT_KEY`      |
| `proxy-consumer`  | `TINYBIRD_TOKEN`, `SENTRY_DSN`, `AXIOM_TOKEN`                                     |
| `pipes-api`       | `SENTRY_DSN`, `AXIOM_TOKEN`                                                       |
| `api`             | `SENTRY_DSN`, `AXIOM_TOKEN`, `BODY_ENCRYPTION_ROOT_KEY`, `BODY_ACCESS_JWT_SECRET` |
| `web`             | Auth0, Sentry, LaunchDarkly, and app URL values supplied during build/deploy      |
| `mcp`             | Convex JWKS/read-side runtime values for MCP access                               |
| `agent-ingest`    | `AGENT_INGEST_SHARED_SECRET`, `SENTRY_DSN`                                        |
| `agent-consumer`  | `TINYBIRD_TOKEN`, `SENTRY_DSN`                                                    |
| `analyst-sandbox` | `ANALYST_SANDBOX_SHARED_SECRET`, `OPENROUTER_API_KEY`                             |

`archive-api` is not a production service and has no production secret setup. Its development-only
authorization scaffold expects `ARCHIVE_API_SHARED_SECRET` and `SENTRY_DSN`; do not provision it as
if archive persistence were available.

### Convex Environment

Convex owns user/org state, API keys, Collector Credentials, compatibility policy, session ownership,
subscriptions, and Tinybird JWT signing. Required environment values include:

- Auth0 config
- Stripe config
- Tinybird admin/workspace config. Convex is the only holder of `TINYBIRD_ADMIN_TOKEN` for user Pipe Token minting.
- Cloudflare account/API config for KV sync
- `CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID` for Collector Credential KV sync
- `AGENT_INGEST_SHARED_SECRET` for the ingest control-plane endpoints
- `ANALYST_SANDBOX_URL` and `ANALYST_SANDBOX_SHARED_SECRET` for Analyst sandbox orchestration
- `OPENROUTER_API_KEY` for Analyst model calls
- `BODY_ACCESS_JWT_SECRET` for short-lived Body Object access tokens shared with the Raw API Worker

Use `convex dev` for local/dev control-plane work. Do not run `convex deploy` or production secret
changes without explicit approval.

## Production Deployment

Production deploys are automated by `.github/workflows/deploy.yml` on merge to `main`.

The workflow:

1. runs CI checks
2. deploys Convex and exports `.convex.cloud` / `.convex.site` URLs through `GITHUB_OUTPUT`
3. deploys Tinybird schema before consumer Workers
4. deploys Proxy, Proxy Consumer, Pipes API, Raw API, MCP, Web, Agent Ingest, Agent Consumer, and Analyst Sandbox
5. fails agent deploys if production config resolves to dev queues or KV namespaces

The workflow does not deploy Archive API. Desktop distribution is handled independently by
`.github/workflows/desktop-release.yml`. It signs and notarizes the macOS arm64 app, builds the
Windows x64 installer, signs both platforms' updater artifacts with Tauri, and publishes the updater
manifest last.

Never manually deploy production without explicit approval.

## Verification

Use the narrowest verification that covers the change:

- `scripts/dev/smoke.sh` for local proxy/queue/Tinybird flow
- `scripts/dev/verify.sh` for local Tinybird tests, type checks, and tests
- `scripts/dev/verify.sh full` for lint and build as well
- `scripts/agent-ingest-smoke.sh` only for the explicit agent-ingest smoke contract described in the runbook

Agent Conversation Analytics is not production-ready until the roadmap gates are green. The Rust CI,
CLI build, Cursor reader, signed desktop updater, and production-shaped Worker configuration exist in
the repo. A normal-user production sync, authenticated dashboard walkthrough, and live observability
evidence remain separate gates and must not be inferred from those implementations.
