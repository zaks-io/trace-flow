# Agent Pipeline Runbook

This runbook describes the required production operating model and the current limitation.

## Current Status

The agent Workers have a production environment (TRA-110): `[env.production]` blocks bind prod-named
workers to prod queue/DLQ/KV, and the Production workflow deploys them with `--env production` behind a
config guard. The default (flat) config is still the dev path used by `bun run dev:all`.

Do not ask a user, agent, or collector to submit data with a Tinybird token, Tinybird admin token,
Wrangler command, Convex dev seed, or local KV seed. Those are implementation/debug tools, not product
ingestion. The client only ever holds a Collector Credential.

## Intended Production Path

```text
collector CLI / desktop
  -> POST /v1/ingest with X-Trace-Flow-Collector-Secret
  -> agent-ingest production Worker
  -> encrypted R2 delivery and bounded registration
  -> production agent ingest queue carrying a delivery reference
  -> agent-consumer production Worker
  -> Tinybird versioned agent facts and published snapshots
  -> /app/agents via org_id-scoped JWT
```

Only the Collector Credential is present on the client. Tinybird credentials exist only as Worker
secrets.

## Required Production Resources

Provisioned for TRA-110 (recorded in `provisioned-resources.md`):

| Resource              | Name                    | ID / namespace                     |
| --------------------- | ----------------------- | ---------------------------------- |
| Ingest queue          | `agent-ingest-prod`     | `91d2320430454be6a12ac4f45f0b15b9` |
| Ingest DLQ            | `agent-ingest-dlq-prod` | `7ccf6f317c9b4c6fb0e14494b0a47724` |
| Collector Creds KV    | `COLLECTOR_CREDS_PROD`  | `67241ef9190a4f9d9ac520a347bd44b9` |
| Ingest rate limiter   | `AGENT_INGEST_LIMITER`  | namespace `2007` (dev is `2006`)   |
| Pricing KV (existing) | `MODEL_PRICING`         | `45dd0d5e619d44fc831ccab01ed428a4` |

Pricing reuses the existing prod `MODEL_PRICING` namespace the prod proxy consumer already binds — not
a new namespace, and never the dev catalog (`25a35f…`).

The production deploy workflow fails if an agent Worker is bound to a dev queue, dev KV namespace, dev
Worker name, or the dev limiter namespace `2006` — enforced by `scripts/assert-agent-prod-resources.sh`,
which renders each Worker's `--env production` config and refuses to deploy on any dev token.

### Worker secrets and deploy vars

`CONVEX_SITE_URL` is injected by the production deploy workflow from the Convex deployment output. Do not
set it as a Worker secret for normal deploys.

Run each `secret put` from **inside the app directory** with no `--config` flag. Running from the repo root
with `--config apps/<app>/wrangler.jsonc` mis-resolves the `--env production` worker name (it appends
`-production` to the top-level `-dev` name) and silently creates a junk `trace-flow-agent-ingest-dev-production`
worker instead of targeting the real `trace-flow-agent-ingest`.

```sh
# ingest — run from apps/agent-ingest/
#   AGENT_INGEST_SHARED_SECRET must match the value set in the prod Convex environment.
( cd apps/agent-ingest && \
  wrangler secret put AGENT_INGEST_SHARED_SECRET --env production && \
  wrangler secret put SENTRY_DSN                 --env production )

# consumer — run from apps/agent-consumer/. Tinybird append-only (DATASOURCE:APPEND) token, trace_flow_prod
( cd apps/agent-consumer && \
  wrangler secret put TINYBIRD_TOKEN --env production && \
  wrangler secret put SENTRY_DSN     --env production )
```

### Prod Convex environment (control plane — set in the Convex dashboard, not via this repo)

The Collector Credential mint syncs to KV via Convex. The prod Convex deployment must have:

- `AGENT_INGEST_SHARED_SECRET` — identical to the ingest Worker secret above
- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (KV write)
- `CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID` = `67241ef9190a4f9d9ac520a347bd44b9` (the prod KV)

If `CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID` is unset or points at dev, minted credentials never land in
the prod ingest Worker's KV and every ingest auths as `invalid`.

### Compatibility policy (required — ingest fails closed without it)

The ingest Worker fetches `/agent-ingest/compatibility-policy` from Convex on every request (edge-cached
60s). An **empty `collectorCompatibilityPolicy` table** makes Convex return 404, so the Worker fails
closed with `policy_unavailable` and rejects all ingest — even with correct auth and a correct
`CONVEX_SITE_URL`. Prod Convex must have one active policy row.

There is no automated prod seed (`setPolicy` requires an authenticated admin user, so `convex run` can't
call it; `agentE2eSeed:seedDevCollector` is dev-only). Seed it once via the prod Convex **dashboard** →
Data → `collectorCompatibilityPolicy` → Add document:

```json
{
  "minDesktopVersion": "0.0.0",
  "minParserVersion": "0.0.0",
  "denylistedVersions": [],
  "updatedAt": 1748563200000
}
```

`0.0.0 / 0.0.0 / []` admits every client and denylists nothing (`updatedByUserId` is optional;
`updatedAt` is any epoch-ms number — the active row is the latest by `updatedAt`). Raise the minimums or
add denylisted versions later to gate or block specific releases without a Worker deploy.

**Diagnosing `policy_unavailable`:** `wrangler tail --env production --format json` from `apps/agent-ingest`
and grep `policy_fetch`. `status:404` = empty table or wrong `CONVEX_SITE_URL` deployment; `status:401` =
`AGENT_INGEST_SHARED_SECRET` mismatch between Worker and Convex.

### Tinybird schema

**CI is the deploy path (TRA-118).** Schema (`datasources/*`, `pipes/*`) deploys to `trace_flow_prod`
automatically:

- **PR time:** `.github/workflows/ci.yml` `tinybird-schema-check` runs Tinybird's recommended CI
  sequence whenever a PR touches `datasources/**` or `pipes/**`: `tb --local build` + `tb --local test
run` (the `tests/*.yaml` fixture/output tests, offline against a `tinybirdco/tinybird-local` service
  container — catches pipe SQL that compiles but returns wrong rows), then `tb --cloud deploy --check`
  (dry-run diff against `trace_flow_prod` — catches incompatible/destructive migrations). Either failing
  blocks the PR.
- **Merge to `main`:** `deploy-tinybird-schema` deploys the repository directly after compatible Convex erasure code and before the consumers. TRA-405 removes the completed legacy overlay and its retired resources under Isaac's recorded approval `TINYBIRD_CLEANUP_APPROVED=trace_flow_prod_20261009`. This approval permits only the exact retirement inventory in `scripts/ci/tinybird-retired-resources.json`. Before applying cleanup, CI consumes the initial approval by creating a durable GitHub deployment receipt with task `tinybird-cleanup-tra-405` in `Production`. Any receipt consumes the approval, including an interrupted or failed attempt. CI records success separately after Tinybird applies the changes. Later destructive changes require a fresh dated approval supplied through the production workflow input.

Schema deployment uses the `TINYBIRD_DEPLOY_TOKEN` repository secret with `WORKSPACE:DEPLOY`. Token provisioning and read-only resource verification use the separate `TINYBIRD_OPERATOR_TOKEN` with `ADMIN`. Neither credential enters Workers or clients. The consumer append token covers only the six versioned fact datasources.

### Tinybird schema rollout

The production workflow deploys compatible Convex erasure code, deploys the repository schema, deploys the Agent Consumer, verifies live Tinybird resource names, and then deploys Agent Ingest. Ingestion uses encrypted R2 delivery references and versioned canonical facts. The legacy write mode and producer maintenance settings are retired.

After the approved production deploy, require green `Deployment Status`, run `scripts/assert-agent-prod-resources.sh` for Worker bindings, and verify all live Tinybird resources are present and every retired resource and token is absent. CI runs `bun scripts/ci/verify-tinybird-resources.mjs` using read-only GET requests. Agents can obtain the corresponding inventories with `sbx-tinybird prod datasource ls --format json` and `sbx-tinybird prod pipe ls --format json` and compare against repository resources and the retirement inventory. These checks do not apply a deployment or delete rows.

### Agent canonical facts and snapshots

Agent deliveries write six versioned fact tables. Later accepted revisions replace the same natural
fact identity, and an event-date correction writes an old-day tombstone plus a new-day live row.
Pricing runs once per delivery, and the encrypted row plan remains stable across retries.

Nine snapshot targets read canonical facts for captured dirty dates. Product endpoints select the
latest published generation per date. The coordinator publishes one manifest only after every target
and captured date succeeds. Uncertain delivery writes and unresolved Copy starts need receipt-based
reconciliation before affected dates can be published.

Deploy schema changes through the normal CI path. For a repair or backfill, verify a bounded dev
operation first, then promote the reviewed change through CI with production approval. Any
repo-backed repair pipe must live under `copies/`, be unscheduled, and use a `repair_*` name.

Verify canonical identities, event-date corrections, published snapshot totals, and org-scoped
endpoint results before calling a rollout healthy. Legacy fact-ledger rebuild and replay commands
are retired. Agent DLQ payloads live in the shared `AgentDeadLetters` store, instance `__dlq__`.
Use shardId `"__dlq__"` for inspection and explicit `retire-dead-letter` reconciliation, which
retains the payload. Agent recovery rejects organization IDs and does not replay dead letters.
The retirement migration deletes the old fact-ledger class and all its stored records.

### Snapshot scheduling and recovery

Snapshot admission closure is normal backpressure. A pending registration retains its encrypted
delivery, receipt, and recovery alarm without publishing a queue reference until a revision is
reserved. Agent Ingest returns `503 enqueue_failed` with `Retry-After: 60` for known admission
closure, including a gate that closes after the admission check. The Collector honors bounded
numeric admission delays within its retry budget. When that budget is spent, or the failure has no
usable delay, the Collector stops the pass with cursors unchanged and skips periodic passes for
`Retry-After` (60 seconds when absent, capped at one hour) plus up to 50% jitter. Unknown
reservation failures and mismatched delivery references remain errors.

A `400 invalid_envelope` on a multi-session batch does not fail its healthy sessions. The Collector
re-sends the sessions named in `vendor_session_ids` alone (or every session alone when the body
names none) in the same pass. A session still rejected on its own is quarantined locally until its
transcript file or the parser version changes, so it no longer blocks pass completion. When the
body does not name the session and no other session from the same source was accepted during the
pass, the session counts as failed instead, because that points at the client or server. Desktop
logs each quarantined vendor session id once.

Ordinary snapshot batches wait one minute, then check each Copy through the Tinybird Jobs API after
15 seconds, with subsequent checks after 30 and then 60 seconds. Two generations may run globally.
Nine promptly completed Copies publish in at least three minutes and fifteen seconds including batching; queue delivery adds latency.
Large corrections and slow jobs take longer. `agent_snapshot.check` records the persisted check
counts; `agent_snapshot.published` records `dirtyAgeMs` and `gateDurationMs`.

Snapshot exceptions in Sentry include a safe error classification, provider HTTP status when known,
the runner stage, generation, Copy cursor and target, and elapsed time. Known source filenames and
line/column coordinates are retained; arbitrary error messages, causes, provider responses and
stack text are removed. Check-budget failures include the persisted status and recovery counts.
The diagnostics use a [scoped Sentry event processor](https://docs.sentry.io/platforms/javascript/guides/cloudflare/enriching-events/event-processors/)
so other operations retain their existing error scrubbing.

After 15 status checks or three missing-receipt recovery queries, scheduling stops with an
`agent_snapshot_recovery` error. The generation keeps its ingestion gate and capacity slot because
an unobserved Copy may still be running. Do not clear its intent or start a replacement Copy.

A terminal Copy error, definitively rejected Copy start, or expired captured day reopens ingestion
but records `snapshotSchedule.failure` with the failed generation and reason. Dirty days within
retention remain queued, the capacity slot is released, and queue retries or new deliveries cannot start another
generation until an operator resumes it. Inspect the failure and resolve the provider or retention
problem before resuming. `/resumeSnapshot` accepts that failed generation while the gate is open;
it clears the failure and schedules the retained dirty days as a new generation. A second failure
blocks again and needs another investigation.

Use the existing localhost ingest-recovery bridge, connected to the intended environment:

1. POST `/inspectDeliveryStatus` with
   `{"pipeline":"agent","shardId":"<org-id>","options":{}}`.
   Inspect `snapshotSchedule.check` or `snapshotSchedule.failure`, the generation, and outstanding
   Copy receipts.
2. Resolve the provider failure or verify that the existing job can be observed again.
3. POST `/resumeSnapshot` with
   `{"pipeline":"agent","shardId":"<org-id>","confirm":"apply-recovery","options":{"generation":123,"reason":"Provider access restored; existing job verified"}}`.
   Use the inspected generation. For blocked checks, resume replenishes the check budget and does
   not submit another Copy for an unresolved intent. For a failed generation, resume schedules the
   eligible dirty days as a new generation. The reason is retained in coordinator storage.
4. Inspect again and verify publication. A repeat budget failure requires investigation rather than
   an automated resume loop.

If a saved intent has no receipt because the Copy POST was never submitted, ordinary resume cannot
recover it. Before retiring that intent, verify the original invocation failed before the POST,
query the matching Tinybird job history and snapshot target, and record the evidence in the reason.
An empty job history alone does not prove non-submission. Read-only `/inspectDeliveryStatus` accepts
`options: {"discoverCopies":true}` to query the provider with the consumer's existing scoped token.

With explicit production approval, call `/resumeSnapshot` with the inspected generation, reason,
and `abandonUnstartedCopy: {"target":"<target>","copyAttempt":123,"startedAt":<epoch-ms>}` inside
`options`. The private service refuses this option when provider discovery finds a job. The
coordinator requires an expired runner claim, receipt-recovery exhaustion, and exactly one matching
jobless intent. It atomically retires the unpublished generation, reopens ingestion, retains dirty
days, and records a failure with the operator's reason. It does not submit another Copy. Inspect the
failure, then use ordinary `/resumeSnapshot` for that failed generation to schedule a new generation.
The retired generation can never be published, even if a late provider job appears.

## Release Gate

A production release is valid only if all checks pass:

1. `tb --local build` + `tb --local test run` + Tinybird deploy `--check` against `trace_flow_prod` —
   PR-time gate, `ci.yml` `tinybird-schema-check`
2. Compatible Convex erasure deploy, then Tinybird schema apply to `trace_flow_prod` — `deploy.yml` `deploy-tinybird-schema`, before consumers
3. production Worker config assertion (`scripts/assert-agent-prod-resources.sh`)
4. Worker deploy (`deploy --env production`, both agent jobs in `.github/workflows/deploy.yml`)
5. synthetic Collector Credential mint through the real authenticated control plane
6. synthetic envelope POST to production ingest
7. queue drain verification
8. Tinybird row visibility
9. `/app/agents` read through org-scoped JWT

Steps 5-9 are `scripts/agent-ingest-smoke.sh` (see Smoke Envelope Rules). No manual admin-token insert
can satisfy this gate.

## DLQ

The DLQ is inspect-only by default. A non-empty DLQ means malformed messages, contract drift, or
repeated Tinybird insert failure.

Inspect:

```sh
wrangler queues info agent-ingest-dlq-prod
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

`scripts/agent-ingest-smoke.mjs` (run via `scripts/agent-ingest-smoke.sh`) is the harness. It posts a
valid gzip envelope and asserts `202`, polls the prod queue to zero, asserts the run's `session_pk`
appears through an agent read pipe under an `org_id`-scoped JWT, and asserts a malformed envelope is
rejected (4xx) without enqueuing. It never holds a Tinybird admin token.

Obtain the two real inputs from the authenticated control plane (not from KV or an admin token):

```sh
# 1. Mint a Collector Credential as a normal user via the production CLI device flow.
#    The CLI defaults to production URLs — no env vars required:
trace-flow login
#    The CLI stores the secret in the OS keychain. For the headless smoke, export it (or read it back):
export TRACE_FLOW_SMOKE_COLLECTOR_SECRET=<the minted secret>

# 2. Mint an agent-scoped Tinybird JWT for the smoke org the same way the app does
#    (Convex api.tinybird.generateToken) and export it:
export TRACE_FLOW_SMOKE_ORG_JWT=<org-scoped agent JWT>

# 3. Run the smoke (CLOUDFLARE_API_TOKEN/ACCOUNT_ID in env for queue-depth checks):
TRACE_FLOW_INGEST_URL=https://collector.trace-flow.dev \
TRACE_FLOW_TINYBIRD_HOST=https://api.us-west-2.aws.tinybird.co \
scripts/agent-ingest-smoke.sh
```

**Advanced / dev only:** override CLI endpoints when pointing at a local worker or the dev environment (see
`apps/cli/README.md`):

```sh
TRACE_FLOW_CONVEX_SITE_URL=https://<deployment>.convex.site trace-flow login
TRACE_FLOW_INGEST_URL=http://127.0.0.1:8787 trace-flow sync --since 24h
```

## Teardown

This teardown covers the **dev** resources in `provisioned-resources.md` only. Remove them only when the
dev agent ingest path is intentionally retired or being rebuilt. The production resources (the Required
Production Resources table above) are live and out of scope here — see the carve-out below.

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
