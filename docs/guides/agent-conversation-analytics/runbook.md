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
  -> production agent ingest queue
  -> agent-consumer production Worker
  -> Tinybird production agent_* datasources
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

### Worker secrets (set out of band, never committed, never in CI)

Run each `secret put` from **inside the app directory** with no `--config` flag. Running from the repo
root with `--config apps/<app>/wrangler.jsonc` mis-resolves the `--env production` worker name (it
appends `-production` to the top-level `-dev` name) and silently creates a junk
`trace-flow-agent-ingest-dev-production` worker instead of targeting the real `trace-flow-agent-ingest`.

```sh
# ingest — run from apps/agent-ingest/
#   CONVEX_SITE_URL MUST be the prod Convex *site* origin (https://laudable-bison-427.convex.site).
#   If it points at any other deployment, the compatibility-policy fetch 404s and ingest fails closed
#   with policy_unavailable even though auth is correct.
#   AGENT_INGEST_SHARED_SECRET must match the value set in the prod Convex environment.
( cd apps/agent-ingest && \
  wrangler secret put CONVEX_SITE_URL            --env production && \
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

- **PR time:** `.github/workflows/ci.yml` `tinybird-schema-check` runs `tb build` + dry-run diff
  (`tb --cloud deploy --check`) against `trace_flow_prod` whenever a PR touches `datasources/**` or
  `pipes/**`. An incompatible/destructive migration fails the PR before merge.
- **Merge to `main`:** `.github/workflows/deploy.yml` `deploy-tinybird-schema` runs the apply, and the
  consumer deploys (`deploy-proxy-consumer`, `deploy-agent-consumer`) `needs:` it — so the schema always
  lands before any consumer ships the new shape.

CI authenticates headless via the `TINYBIRD_DEPLOY_TOKEN` secret (Production environment), a
workspace-level deploy token — never the append-only `TINYBIRD_TOKEN` the consumer uses, and never on
the client/collector path. The token resolves to `trace_flow_prod`; the script refuses to deploy
anywhere else.

**Break-glass (manual fallback only):** if CI is unavailable, deploy from a local `tb` cloud login.
This is the opt-in escape hatch, not the normal path:

```sh
TB_TARGET_WORKSPACE=trace_flow_prod scripts/deploy-agent-tinybird.sh --check   # validate only
TB_TARGET_WORKSPACE=trace_flow_prod scripts/deploy-agent-tinybird.sh           # deploy
```

## Release Gate

A production release is valid only if all checks pass:

1. `tb build` + Tinybird deploy `--check` against `trace_flow_prod` — PR-time gate, `ci.yml`
   `tinybird-schema-check`
2. Tinybird schema apply to `trace_flow_prod` — `deploy.yml` `deploy-tinybird-schema`, before consumers
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

**Advanced / dev only:** override CLI endpoints when pointing at a local worker or cloud-dev (see
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
