# Provisioned Cloudflare resources (task 0d)

The agent-ingest path needs Cloudflare resources that are **not code** and must exist before the
workers can bind them. Task 0d provisions them in the **dev** account only; 2b/2c/2e wire the IDs
below into the worker `wrangler.jsonc` files, and 2f turns the teardown section into the runbook.

Blast radius is confined to `*-dev`. No production resources are created by this feature until the
end-to-end path lands and a `main` deploy is intentional.

## Account

The dev account ID is **not** committed here — like the existing workers, it comes from the
`CLOUDFLARE_ACCOUNT_ID` CI secret / your local `wrangler` login (`wrangler whoami`), never from
source. The queue and KV IDs below are ordinary resource identifiers (useless without an auth token)
and follow the same convention as the committed `id = …` values in `apps/*/wrangler.toml`.

## Queues

Mirror the proxy's `trace-flow-requests*` queue pattern: a main ingest queue plus a dead-letter
queue. `agent-ingest-dev` is the consumer source for `apps/agent-consumer`; failed batches land in
`agent-ingest-dlq-dev`.

| Binding (planned) | Queue name             | Queue ID                           |
| ----------------- | ---------------------- | ---------------------------------- |
| `AGENT_QUEUE`     | `agent-ingest-dev`     | `0ff3e1668a604c30be4b4f80c0dde54c` |
| `AGENT_DLQ`       | `agent-ingest-dlq-dev` | `1c94dd85ae294c6abdecf8d0bc82b108` |

## KV

Separate namespace from the API-key store (`API_KEYS`); holds Collector Credentials managed by the
Convex control plane starting in **2a** (`collectorCredentials` mint/revoke/list + `syncKeyToKV`-style
KV sync). The Phase 5 desktop connect flow is one consumer that mints a credential through that
control plane, not the sole minting mechanism.

| Binding           | Namespace name    | Namespace ID                       |
| ----------------- | ----------------- | ---------------------------------- |
| `COLLECTOR_CREDS` | `COLLECTOR_CREDS` | `f945ee3d71954ffabd364e3db385d3ab` |

## Config-only (no provisioning call)

- `AGENT_INGEST_LIMITER` — rate-limit binding, namespace **2006**. Declared in the agent-ingest
  worker's `wrangler.jsonc` `[[unsafe.bindings]]`; Cloudflare allocates it at deploy time, so there
  is no `wrangler` create command and no ID to record here.

## Production status

These are **dev resources only**. They are not a production ingest path.

The current `deploy.yml` has `deploy-agent-ingest` and `deploy-agent-consumer` jobs, but the worker
configs are flat dev configs. That means a Production workflow can deploy dev-named agent workers and
dev resources. This is not acceptable for launch and is tracked by:

- TRA-110 — production cloud ingest path
- TRA-111 — CI and production release guardrails

Production readiness requires separate production queues, DLQ, KV namespace, rate limiter, Worker
names, secrets, Tinybird deploy gate, and post-deploy smoke test. Do not treat these IDs as production
credentials or production evidence.

## Teardown

See the [ops runbook](./runbook.md#teardown) for dev teardown. These 0d resources are dev-only;
production resources created by TRA-110 require the production change process.
