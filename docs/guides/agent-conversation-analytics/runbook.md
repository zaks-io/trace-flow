# Agent pipeline ops runbook

Operating the agent-conversation-analytics ingest path: the dead-letter queue, the observability
alerts, manual teardown, and the Tinybird schema deploy that CI does not perform.

**Scope / blast radius:** dev only. Slice B has no production agent pipeline — both `deploy.yml` (on
`main`) and `preview.yml` (on PR) target the `*-dev` workers and the 0d-provisioned dev resources
(see [`provisioned-resources.md`](./provisioned-resources.md)). Tinybird inserts go to `trace_flow_dev`
only.

**Path:** Collector → `agent-ingest` (`POST /v1/ingest`) → `agent-ingest-dev` queue → `agent-consumer`
→ Tinybird `agent_*` datasources. A batch the consumer cannot insert is retried; a message that
exhausts retries (or fails the structural guard) dead-letters to `agent-ingest-dlq-dev`. Re-POST is
idempotent — every base fact is a `ReplacingMergeTree(IngestedAt)` keyed on a stable `*_pk`, so
re-driving the DLQ collapses duplicates under `FINAL`.

## Dead-letter queue

The DLQ (`agent-ingest-dlq-dev`) is inspect-only by default; nothing consumes it. A non-empty DLQ
means messages were malformed (contract drift — see Sentry `agent_consumer.message_malformed`) or the
Tinybird insert kept failing past `max_retries: 5`.

### Inspect

```sh
wrangler queues info agent-ingest-dlq-dev   # backlog size + consumer state
```

Cross-reference Sentry: malformed messages emit `captureMessage('agent_consumer.message_malformed')`;
insert failures emit `captureException(..., { tags: { operation: 'insert', datasource } })`. Use the
`datasource` tag to find which `agent_*` table is rejecting rows, then check that datasource's
`_quarantine` table in Tinybird for the schema mismatch.

### Re-drive

Once the root cause is fixed (schema mismatch corrected, pricing catalog repopulated), re-drive with a
**temporary HTTP pull consumer** on the DLQ — pull the batch, re-POST it to `agent-ingest`'s
`/v1/ingest`, ack on success. Idempotent re-POST makes this safe to repeat.

```sh
wrangler queues consumer http add agent-ingest-dlq-dev   # attach a pull consumer
# pull → re-POST to https://trace-flow-agent-ingest-dev.<account>.workers.dev/v1/ingest → ack
wrangler queues consumer http remove agent-ingest-dlq-dev # detach when drained
```

If the messages are unrecoverable (genuine contract drift that will never validate), drop them:

```sh
wrangler queues pause-delivery agent-ingest-dlq-dev   # optional: stop new arrivals first
wrangler queues purge agent-ingest-dlq-dev            # irreversible
```

## Alerts

These are **dashboard/API-provisioned** — this repo has no alert-as-code path (no Terraform, no
Cloudflare notification config in `wrangler.jsonc`, no Tinybird `TYPE ALERT` pipe). Provision them
once per environment in the Cloudflare and Sentry dashboards. The definitions below are the contract;
keep them in sync if the signal names change.

| Alert                      | Source                           | Signal                                                                              | Fires when                         |
| -------------------------- | -------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------- |
| **DLQ non-empty**          | Cloudflare Queues                | `agent-ingest-dlq-dev` backlog                                                      | backlog > 0 for 5 min              |
| **Consumer error rate**    | Sentry (project: agent-consumer) | events tagged `operation:insert` or `operation:guard`, or `agent_consumer.*` errors | > 5 events / 10 min                |
| **Priced-coverage health** | Tinybird (scheduled query)       | priced fraction of recent messages                                                  | drops sharply vs. baseline (below) |

### Priced-coverage health

`cost_usd` is the only nullable column. A message is legitimately unpriced when token coverage is
missing, so coverage is naturally below 100% — alert on a **drop versus baseline**, not an absolute
floor. A models.dev import that silently regresses to empty/gateway prices shows up as the recent
priced fraction collapsing while the 24h baseline stays put.

```sql
SELECT
  countIf(cost_usd IS NOT NULL) / count(*) AS priced_coverage,
  count(*)                                  AS total
FROM agent_messages FINAL
WHERE IngestedAt >= now() - INTERVAL 1 HOUR
```

Compare against the trailing 24h `priced_coverage`; fire if the recent ratio drops by more than ~50%
relative (guard with `total > 100` so a quiet hour does not trip it). Run it as a Tinybird scheduled
query/copy pipe feeding the dashboard alert, or poll it from an external monitor.

When it fires, check the models.dev import: `bunx convex run billing/modelPricing:listAll` should show
recent `updatedAt` timestamps for `source: 'models.dev'` rows; if stale, the daily import cron
(`06:30 UTC`) failed — re-run `bunx convex run billing/modelPricing:importFromModelsDev` and confirm
`{ imported, skipped }`.

## Teardown

Dev resources are disposable, but **`git revert` does not remove them** — the queues, KV namespace,
and Tinybird datasources are provisioned out-of-band (0d / 1d), not from code. Reverting the worker
configs only stops deploys; the resources keep existing (and the DLQ keeps any messages). To fully
remove the agent pipeline from the dev account:

```sh
# Cloudflare (0d resources)
wrangler queues delete agent-ingest-dev
wrangler queues delete agent-ingest-dlq-dev
wrangler kv namespace delete --namespace-id f945ee3d71954ffabd364e3db385d3ab

# Tinybird (1d datasources) — destructive, dev workspace only
tb workspace current                                    # MUST be trace_flow_dev
tb --cloud datasource rm agent_messages --allow-destructive-operations
# repeat for: agent_tool_events, agent_file_events, agent_capability_snapshots,
#             agent_pull_request_links, and the 1b/1c materialized/rollup datasources
```

Worker scripts themselves are removed with `wrangler delete` from each app dir if you also want the
`*-dev` Workers gone.

## Tinybird schema deploy (not in CI)

Tinybird is **not** wired into GitHub Actions — schema changes are deployed manually from
`datasources/` + `pipes/`. CI never touches Tinybird, so a merged schema change is inert until someone
runs the deploy. Always validate offline first, confirm the workspace, then deploy to dev:

```sh
tb build                          # offline validation of every .datasource / .pipe
tb workspace current              # MUST print trace_flow_dev — never `tb workspace use trace_flow_prod`
tb --cloud deploy --check         # dry-run against the live workspace
tb --cloud deploy                 # apply
tb --cloud datasource ls          # confirm agent_* datasources are present
```

Use `FORWARD_QUERY` for zero-downtime column changes; every datasource keeps a `_quarantine` table for
rows that do not match the schema (check it first when an insert alert fires).
