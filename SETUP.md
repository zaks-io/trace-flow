# Setup Instructions

This file is the setup map. For architecture details, read `specs/architecture/overview.md` and
`specs/architecture/workers.md`. For agent analytics production gates, read
`docs/guides/agent-conversation-analytics/ROADMAP.md` and
`docs/guides/agent-conversation-analytics/runbook.md`.

## Local Development

Use the scripted local contract:

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

`scripts/dev/workers.sh` runs the five non-Web Workers together with shared local state:

- `apps/proxy`
- `apps/proxy-consumer`
- `apps/api`
- `apps/agent-ingest`
- `apps/agent-consumer`

Run Convex and Web separately:

```bash
scripts/dev/convex.sh
scripts/dev/web.sh
```

See `docs/agents/local-environment.md` for the environment vocabulary and script switches.

## Cloudflare Resources

The production runtime uses these Cloudflare resource families:

| Resource         | LLM request path                         | Agent conversation path                 |
| ---------------- | ---------------------------------------- | --------------------------------------- |
| Workers          | `proxy`, `proxy-consumer`, `api`, `web`  | `agent-ingest`, `agent-consumer`, `web` |
| Queues           | `trace-flow-requests-*` + DLQ            | `agent-ingest-*` + DLQ                  |
| R2               | `trace-flow-storage-*` body bucket       | raw transcript storage deferred         |
| KV               | `API_KEYS`, `MODEL_PRICING`              | `COLLECTOR_CREDS`, `MODEL_PRICING`      |
| Durable Objects  | `USAGE_TRACKER`, `TRACE_BATCHER`         | `AGENT_FACT_BATCHER`                    |
| Rate limiters    | org, IP, API read, token refresh budgets | `AGENT_INGEST_LIMITER`                  |
| Analytics Engine | proxy/consumer operational metrics       | Worker logs and Sentry for now          |

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

| Worker           | Secrets                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `proxy`          | `CONVEX_SITE_URL`, `USAGE_SYNC_SECRET`, `SENTRY_DSN`, `AXIOM_TOKEN`, `BODY_ENCRYPTION_ROOT_KEY` |
| `proxy-consumer` | `TINYBIRD_TOKEN`, `SENTRY_DSN`, `AXIOM_TOKEN`                                                   |
| `api`            | `TINYBIRD_ADMIN_TOKEN`, `SENTRY_DSN`, `AXIOM_TOKEN`, `BODY_ENCRYPTION_ROOT_KEY`                 |
| `web`            | Auth0, Sentry, LaunchDarkly, and app URL values supplied during build/deploy                    |
| `mcp`            | Convex JWKS/read-side runtime values for MCP access                                             |
| `agent-ingest`   | `CONVEX_SITE_URL`, `AGENT_INGEST_SHARED_SECRET`, `SENTRY_DSN`                                   |
| `agent-consumer` | `TINYBIRD_TOKEN`, `SENTRY_DSN`                                                                  |

### Convex Environment

Convex owns user/org state, API keys, Collector Credentials, compatibility policy, session ownership,
subscriptions, and Tinybird JWT signing. Required environment values include:

- Auth0 config
- Stripe config
- Tinybird admin/workspace config
- Cloudflare account/API config for KV sync
- `CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID` for Collector Credential KV sync
- `AGENT_INGEST_SHARED_SECRET` for the ingest control-plane endpoints

Use `convex dev` for local/dev control-plane work. Do not run `convex deploy` or production secret
changes without explicit approval.

## Production Deployment

Production deploys are automated by `.github/workflows/deploy.yml` on merge to `main`.

The workflow:

1. runs CI checks
2. deploys Convex and builds Web in one job
3. deploys Tinybird schema before consumer Workers
4. deploys proxy, proxy-consumer, API, MCP, Web, Agent Ingest, and Agent Consumer
5. fails agent deploys if production config resolves to dev queues or KV namespaces

Never manually deploy production without explicit approval.

## Verification

Use the narrowest verification that covers the change:

- `scripts/dev/smoke.sh` for local proxy/queue/Tinybird flow
- `scripts/dev/verify.sh` for local Tinybird tests, type checks, and tests
- `scripts/dev/verify.sh full` for lint and build as well
- `scripts/agent-ingest-smoke.sh` only for the explicit agent-ingest smoke contract described in the runbook

Agent Conversation Analytics is not production-ready until the roadmap gates are green, including a
normal user collector flow, production queue/consumer smoke, dashboard truth states, Rust CI, and live
observability alerts.
