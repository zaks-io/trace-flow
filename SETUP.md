# Setup Instructions

This file documents the company development setup. It is not a verified deployment recipe for a
fresh external account. A fork must replace company domains, resource IDs, secrets, and CI deployment
settings with its own. Hosted dependencies and provider calls may incur charges.

This file is the setup map. For architecture details, read `specs/architecture/overview.md` and
`specs/architecture/workers.md`. For agent analytics production gates, read
`docs/guides/agent-conversation-analytics/ROADMAP.md` and
`docs/guides/agent-conversation-analytics/runbook.md`.

## Local Development

The scripted contract provisions **Self-Contained Local**. It does not connect to the dev
environment unless you explicitly supply the dev endpoints and tokens described in
`docs/agents/local-environment.md`. Everyday development runs only Web locally against the dev
environment: `bun run dev:web`.

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

It does not start Web, Convex, MCP, or Analyst Sandbox.

Run Convex and Web separately:

```bash
scripts/dev/convex.sh
scripts/dev/web.sh
```

For day-to-day collector testing, run Web locally but point the collector at the deployed
`-dev` Agent Ingest Worker and the Convex dev site. The collector embeds production URLs,
so both `TRACE_FLOW_INGEST_URL` and `TRACE_FLOW_CONVEX_SITE_URL` must be set for dev. See
`docs/agents/local-environment.md` and `CONTEXT.md` for the exact environment vocabulary and script
switches.

## Cloudflare Resources

The production runtime uses these Cloudflare resource families:

| Resource         | Model request path                          | Agent conversation path                                                              | Shared/read path                                    |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Workers          | `proxy`, `proxy-consumer`                   | `agent-ingest`, `agent-consumer`                                                     | `web`, `pipes-api`, `api`, `mcp`, `analyst-sandbox` |
| Queues           | `trace-flow-requests-*` + DLQ               | `agent-ingest-*` + DLQ                                                               | None                                                |
| R2               | `trace-flow-storage-*` Body Objects         | `trace-flow-agent-deliveries-*` encrypted facts                                      | Sandbox workspace backups                           |
| KV               | `API_KEYS`, `MODEL_PRICING`                 | `COLLECTOR_CREDS`, `MODEL_PRICING`                                                   | None                                                |
| Durable Objects  | `USAGE_TRACKER`, `TRACE_BATCHER`            | Delivery receipts, org coordinator, snapshot capacity, retained `AGENT_FACT_BATCHER` | `Sandbox`                                           |
| Rate limiters    | org and IP ingest limits                    | `AGENT_INGEST_LIMITER`                                                               | read and token-refresh limits                       |
| Analytics Engine | proxy and consumer operational measurements | Worker logs and Sentry                                                               | Worker logs and Sentry                              |

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
| `pipes-api`       | `PIPES_API_SHARED_SECRET`, `SENTRY_DSN`, `AXIOM_TOKEN`                            |
| `api`             | `SENTRY_DSN`, `AXIOM_TOKEN`, `BODY_ENCRYPTION_ROOT_KEY`, `BODY_ACCESS_JWT_SECRET` |
| `web`             | Auth0, Sentry, and app URL values supplied during build/deploy                    |
| `mcp`             | Convex JWKS/read-side runtime values for MCP access                               |
| `agent-ingest`    | `AGENT_INGEST_SHARED_SECRET`, `SENTRY_DSN`                                        |
| `agent-consumer`  | `TINYBIRD_TOKEN`, `SENTRY_DSN`                                                    |
| `analyst-sandbox` | `ANALYST_SANDBOX_SHARED_SECRET`, `OPENROUTER_API_KEY`                             |

Convex Tinybird queries also require `SENTRY_DSN` and `SENTRY_ENVIRONMENT` in the
Convex deployment. Use `development` for dev, `preview` for PR previews, and
`prod` for production. CI configures these for previews and production from the
existing `NEXT_PUBLIC_SENTRY_DSN` GitHub variable. The Pipes API needs its own
`SENTRY_DSN` Worker secret; browser configuration does not configure the Worker.

Tinybird reads emit `db.query` spans named `tinybird.pipe <pipe>` or `tinybird.sql`,
including response parsing. Query spans record status, returned row count, cache
state, and available Tinybird elapsed time, rows read, and bytes read. Cache hits
omit upstream execution statistics. SQL text, query parameters, credentials, and
returned rows are excluded. Convex uses a separate client and scope per operation
and flushes before returning. Search Sentry for `span.op:db.query
span.description:tinybird.*` in the relevant environment.

### Convex Environment

Convex owns user/org state, API keys, Collector Credentials, compatibility policy, session ownership,
subscriptions, and Tinybird JWT signing. Required environment values include:

- Auth0 config
- Stripe config
- `SPLITCH_API_KEY` for the matching Splitch Environment
- Tinybird admin/workspace config. Convex is the only holder of `TINYBIRD_ADMIN_TOKEN` for user Pipe Token minting.
- Cloudflare account/API config for KV sync
- `CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID` for Collector Credential KV sync
- `AGENT_INGEST_SHARED_SECRET` for the ingest control-plane endpoints
- `ANALYST_SANDBOX_URL` and `ANALYST_SANDBOX_SHARED_SECRET` for Analyst sandbox orchestration
- `OPENROUTER_API_KEY` for Analyst model calls
- `BODY_ACCESS_JWT_SECRET` for short-lived Body Object access tokens shared with the Raw API Worker

Use `convex dev` for local/dev control-plane work. Do not run `convex deploy` or production secret
changes without explicit approval.

### Splitch feature flags

The `trace-flow` Splitch App owns `pro-subscription-enabled`, with `off=false` as
its default and `on=true` as its alternative. Keep the flag disabled until Pro
subscriptions are explicitly enabled. Dev and previews use the Splitch
`dev` Environment; production uses `prod`.

The official [`@splitch/convex` component](https://splitch.dev/docs/sdk/convex)
syncs configuration into Convex and evaluates the flag locally. The billing UI
subscribes to an authenticated Convex query; checkout enforces the same decision
on the server. No browser Splitch credential is needed.

Before deploying the component, set `SPLITCH_API_KEY` in the target Convex
deployment to a key from the matching Splitch Environment with
the `data-plane:evaluate` scope. Configure the same variable
in Convex's preview deployment defaults before creating a PR preview. Keep the
key in the platform's secret configuration, never in frontend build variables.

After a dev deployment, run the internal installation action:

```bash
bunx convex run integrations/splitch:install --deployment hardy-iguana-812
```

Run it again after component upgrades. The action is idempotent. Preview and
production workflows run it after deploying Convex and fail if installation
fails. Verify the intended flag with `splitch flags verify` using explicit
`--app trace-flow --env dev` or `--env prod` scope.

Before the first production merge, provision the production `SPLITCH_API_KEY`
with explicit production approval. The migration does not enable Pro or start
an experiment.

## Preview Deployment

The repository owner dispatches `.github/workflows/preview.yml` for an open same-repository PR.
Update the target PR branch from `main` before dispatching so its routes and CORS settings match
the workflow. The workflow deploys the PR head to the shared Preview Workers and comments their URLs
on the PR.
The canonical Web URL is `https://preview.trace-flow.dev`; API and Collector endpoints are listed
in [CONTEXT.md](CONTEXT.md#concrete-endpoints-canonical--stop-rediscovering-these).

Each Preview Worker declares an exact [Cloudflare Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
Cloudflare creates DNS records and certificates, including nested subdomains, without a separate
Advanced Certificate Manager subscription. The Preview deployment token needs zone permissions for
Custom Domains, and the hostnames must have no conflicting CNAME records. Existing API, MCP, and
Collector `workers.dev` URLs remain available during rollout. Web sign-in uses the canonical
`https://preview.trace-flow.dev` origin.

Configure the Preview Auth0 application's allowed callback URLs with
`https://preview.trace-flow.dev/auth/callback`, and add `https://preview.trace-flow.dev` to its
allowed logout URLs and web origins. The workflow sets the branch's Convex `AGENT_INGEST_URL`,
`ANALYST_SANDBOX_URL`, and `APP_URL` to the matching Preview hosts.

Dev Tinybird must deploy the `trace_flow_proxy_spans_append` token declared in
`datasources/otel_trace_spans.datasource` before Preview runs. The workflow verifies its exact
`otel_trace_spans` append scope and gives it only to the Preview Proxy Consumer. Tinybird requires
resource-scoped tokens to be managed through datafile deployments; the workflow does not create
resource tokens through its API or migrate the shared dev schema.

Collector device login also needs the current branch Convex site's `/mcp/callback` in the selected
Auth0 application's callback allowlist. Convex recreates that site on a new Preview deployment, so
verify the current site before requesting an additive allowlist change. Preview Convex needs an
active Collector compatibility policy. Analyst execution additionally requires an active Pro
subscription and the Preview `OPENROUTER_API_KEY`.

Preview MCP uses production Connect. Its new resource URL, `https://mcp.preview.trace-flow.dev/mcp`,
requires the updated Connect resource allowlist to reach production through a separately approved
merge. Until then, use the existing MCP Preview `workers.dev` URL for OAuth.

Preview Workers and data resources are shared across PRs, so dispatch one Preview deployment at a
time. The Agent Ingest Preview still uses the dev Agent Consumer, queue, and delivery bucket;
this domain migration does not provide dedicated Preview data isolation.

## Production Deployment

Production deploys are automated by `.github/workflows/deploy.yml` on merge to `main`.

The workflow:

1. runs CI checks
2. deploys Convex and exports `.convex.cloud` / `.convex.site` URLs through `GITHUB_OUTPUT`
3. deploys Tinybird schema before consumer Workers
4. deploys Proxy, Proxy Consumer, Pipes API, Raw API, MCP, Web, Agent Ingest, Agent Consumer, and Analyst Sandbox
5. fails agent deploys if production config resolves to dev queues or KV namespaces

Desktop distribution runs independently through `.github/workflows/desktop-release.yml`. It signs
and notarizes the macOS arm64 app, builds the Windows x64 installer, signs both platforms' updater
artifacts with Tauri, and publishes the updater manifest last.

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
