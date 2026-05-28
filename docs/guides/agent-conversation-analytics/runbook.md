# Agent Pipeline Runbook

This runbook describes the required production operating model and the current limitation.

## Current Limitation

The checked-in agent Workers currently use dev resource names and dev bindings. The previous runbook
called the path "dev only"; that remains true until the production cloud ingest task lands.

Do not ask a user, agent, or collector to submit data with a Tinybird token, Tinybird admin token,
Wrangler command, Convex dev seed, or local KV seed. Those are implementation/debug tools, not product
ingestion.

## Intended Production Path

```text
collector CLI / desktop
  -> POST /v1/ingest with X-Trace-Flow-Collector-Secret
  -> agent-ingest production Worker
  -> production agent ingest queue
  -> agent-consumer production Worker
  -> Tinybird production agent_* datasources
  -> /app/agents via org_id-scoped JWT
```

Only the Collector Credential is present on the client. Tinybird credentials exist only as Worker
secrets.

## Required Production Resources

Before production launch, provision and record:

- production agent ingest queue
- production agent ingest DLQ
- production `COLLECTOR_CREDS` KV namespace
- production ingest rate limiter namespace
- production pricing KV binding or a safe shared pricing source
- production Sentry projects or alert routing for ingest and consumer
- production Tinybird agent datasources and pipes
- scoped Tinybird append token for the consumer Worker

The production deploy workflow must fail if an agent Worker is bound to a dev queue, dev KV namespace,
or dev Worker name.

## Release Gate

A production release is valid only if all checks pass:

1. `tb build`
2. Tinybird deploy dry-run against the target workspace
3. production Worker config assertion
4. Worker deploy
5. synthetic Collector Credential mint
6. synthetic envelope POST to production ingest
7. queue drain verification
8. Tinybird row visibility
9. `/app/agents` read through org-scoped JWT

No manual admin-token insert can satisfy this gate.

## DLQ

The DLQ is inspect-only by default. A non-empty DLQ means malformed messages, contract drift, or
repeated Tinybird insert failure.

Inspect:

```sh
wrangler queues info <production-agent-dlq>
```

Recover only after fixing the root cause. Re-drive through the ingest path or a controlled internal
tool that preserves idempotency; do not write rows directly to Tinybird.

## Alerts

Production must alert on:

- ingest auth rejection spike
- compatibility policy unavailable
- queue backlog depth or age
- DLQ non-empty
- consumer insert failures
- Tinybird quarantine rows
- priced-token coverage regression
- repeated collector sync failures

Each alert needs:

- threshold
- owner
- dashboard link
- runbook action
- test procedure

## Smoke Envelope Rules

Smoke tests must:

- use a real Collector Credential
- submit through `POST /v1/ingest`
- never receive Tinybird credentials
- use a synthetic org/session that is safe to delete
- assert read visibility through the same dashboard token path used by the app

## Teardown

The resources in `provisioned-resources.md` are dev-only. Remove them only when the dev agent ingest
path is intentionally retired or being rebuilt.

Before deleting dev resources:

- stop dev deployments that reference the queue, DLQ, and KV namespace
- confirm no active development issue depends on the current resource IDs
- export or discard DLQ messages deliberately
- remove matching dev secrets from Cloudflare after the workers no longer bind them
- remove Tinybird dev datasources only through the Tinybird deploy workflow with destructive
  operations explicitly enabled

Production resources created by TRA-110 require the production change process. Do not delete or
recreate them as part of dev teardown.

## Done

The runbook is production-ready when an on-call engineer can identify whether data stopped at auth,
ingest, queue, consumer, Tinybird, or dashboard read without accessing client secrets or bypassing the
product pipeline.
