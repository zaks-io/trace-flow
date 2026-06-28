# Provisioned Cloudflare resources

The agent-ingest path needs Cloudflare resources that are **not code** and must exist before the
workers can bind them. The original dev set is recorded below; the production set (TRA-110) follows in
its own section. The worker `wrangler.jsonc` files wire these IDs into the default (dev) config and the
`[env.production]` blocks respectively.

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
- `AGENT_INGEST_LIMITER` preview — rate-limit namespace **2010**. Preview reuses the dev
  `COLLECTOR_CREDS` KV and `agent-ingest-dev` queue, but keeps its Worker name and rate-limit budget
  separate from cloud-dev.

## Production resources (TRA-110)

The `[env.production]` blocks in `apps/agent-ingest/wrangler.jsonc` and
`apps/agent-consumer/wrangler.jsonc` bind these. `deploy.yml` deploys both with `--env production`
behind `scripts/assert-agent-prod-resources.sh`, which fails the deploy if any dev resource leaks in.

### Queues

| Binding       | Queue name              | Queue ID                           |
| ------------- | ----------------------- | ---------------------------------- |
| `AGENT_QUEUE` | `agent-ingest-prod`     | `91d2320430454be6a12ac4f45f0b15b9` |
| (DLQ)         | `agent-ingest-dlq-prod` | `7ccf6f317c9b4c6fb0e14494b0a47724` |

### KV

| Binding           | Namespace name          | Namespace ID                       |
| ----------------- | ----------------------- | ---------------------------------- |
| `COLLECTOR_CREDS` | `COLLECTOR_CREDS_PROD`  | `67241ef9190a4f9d9ac520a347bd44b9` |
| `MODEL_PRICING`   | (existing prod catalog) | `45dd0d5e619d44fc831ccab01ed428a4` |

`MODEL_PRICING` reuses the prod namespace the prod proxy consumer already binds — never the dev catalog
(`25a35f…`). The prod Convex deployment must set `CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID` to the
`COLLECTOR_CREDS_PROD` id so minted credentials sync to the right namespace.

### Config-only (no provisioning call)

- `AGENT_INGEST_LIMITER` — prod rate-limit namespace **2007** (dev uses 2006; never reuse a
  namespace_id, per the rate-limit budget registry).

### Tinybird

Agent datasources + pipes deploy to `trace_flow_prod` (`a0263248-b28b-49de-804f-1ec97c244b96`) through
`TB_TARGET_WORKSPACE=trace_flow_prod scripts/deploy-agent-tinybird.sh` — opt-in only; the script refuses
prod without that variable. The consumer holds a `DATASOURCE:APPEND` token for that workspace as a
Worker secret. No client or smoke test ever receives a Tinybird token.

## Teardown

See the [ops runbook](./runbook.md#teardown) for dev teardown. The dev resources at the top of this
doc are dev-only; production resources created by TRA-110 require the production change process and must
never be deleted as part of dev teardown.
