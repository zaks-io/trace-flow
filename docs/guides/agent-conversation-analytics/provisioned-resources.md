# Provisioned Cloudflare resources (task 0d)

The agent-ingest path needs Cloudflare resources that are **not code** and must exist before the
workers can bind them. Task 0d provisions them in the **dev** account only; 2b/2c/2e wire the IDs
below into the worker `wrangler.jsonc` files, and 2f turns the teardown section into the runbook.

Blast radius is confined to `*-dev`. No production resources are created by this feature until the
end-to-end path lands and a `main` deploy is intentional.

## Account

| Field      | Value                              |
| ---------- | ---------------------------------- |
| Account    | Isaac@zaks.io's Account            |
| Account ID | `a461d640900eb3905d7b6619c8c0da91` |

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

## Deploy gate (until 2e)

`deploy.yml` and `preview.yml` use explicit per-worker jobs (no matrix / auto-discovery), so the
agent-ingest and agent-consumer workers are **gated by absence**: neither workflow references them,
so a mid-phase self-merge to `main` leaves the agent path inert and deploy-safe. Task 2e adds the
deploy + preview jobs (and the `deploy-status.needs` entries) only after wiring the full path.

Verify the gate holds:

```sh
grep -nE 'agent-ingest|agent-consumer' .github/workflows/deploy.yml .github/workflows/preview.yml
# expect: no matches
```

## Teardown (extended into the 2f runbook)

Dev resources are disposable. To remove everything 0d created:

```sh
wrangler queues delete agent-ingest-dev
wrangler queues delete agent-ingest-dlq-dev
wrangler kv namespace delete --namespace-id f945ee3d71954ffabd364e3db385d3ab
```
