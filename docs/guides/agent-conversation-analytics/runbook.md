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

- **PR time:** `.github/workflows/ci.yml` `tinybird-schema-check` runs Tinybird's recommended CI
  sequence whenever a PR touches `datasources/**` or `pipes/**`: `tb --local build` + `tb --local test
run` (the `tests/*.yaml` fixture/output tests, offline against a `tinybirdco/tinybird-local` service
  container — catches pipe SQL that compiles but returns wrong rows), then `tb --cloud deploy --check`
  (dry-run diff against `trace_flow_prod` — catches incompatible/destructive migrations). Either failing
  blocks the PR.
- **Merge to `main`:** `.github/workflows/deploy.yml` `deploy-tinybird-schema` runs the non-destructive
  `expand` apply, and the consumer deploys (`deploy-proxy-consumer`, `deploy-agent-consumer`) `needs:` it
  — so clean schema exists before any consumer ships the new shape. The automatic merge deploy does not
  delete legacy Tinybird resources.

The cloud steps authenticate headless via the `TINYBIRD_DEPLOY_TOKEN` repo secret (also exposed to the
Production environment), a `WORKSPACE:DEPLOY`-scoped token — never the append-only `TINYBIRD_TOKEN` the
consumer uses, and never on the client/collector path. The token resolves to `trace_flow_prod`; the
script refuses to deploy anywhere else. The local build/test steps need no token. When adding or
changing a pipe, add a matching `tests/<pipe>.yaml` so the PR gate verifies its output.

### Tinybird cost-refactor rollout

The cost refactor is an expand/contract rollout. `main` keeps clean final resource names, but the deploy
script can generate temporary deploy trees that preserve legacy prod resources during rollout.

1. Expansion deploy: automatic on merge.
   - `TINYBIRD_DEPLOY_PHASE=expand`
   - Adds clean fact/serving resources.
   - Preserves legacy datasources, legacy endpoint pipe definitions, and legacy copy pipes.
   - Does not pass `--allow-destructive-operations`.
2. Backfill clean facts:
   - `TINYBIRD_BACKFILL_APPROVED=trace_flow_prod_YYYYMMDD TB_TARGET_WORKSPACE=trace_flow_prod bun run tinybird:backfill`
   - The script only exports legacy rows missing from clean targets by stable identity, so it is safe
     after dual-write starts.
3. Parity:
   - `TB_TARGET_WORKSPACE=trace_flow_prod bun run tinybird:parity -- 24`
   - Missing clean identities must be zero for the soak window.
   - Serving aggregate totals must match clean fact totals.
   - Copy jobs are still expected before the read switch.
4. Read switch:
   - `TINYBIRD_DEPLOY_PHASE=switch TB_TARGET_WORKSPACE=trace_flow_prod scripts/deploy-agent-tinybird.sh`
   - Deploys clean endpoint pipe definitions.
   - Keeps legacy datasources and non-copy legacy pipes for rollback/parity.
   - Stops restoring legacy copy pipes, so rebuild CPU should drop during soak.
5. Soak:
   - Keep agent and proxy consumers in `dual` write mode for 24-48h.
   - Copy job CPU should be zero after the switch deploy.
   - Rollback remains a schema deploy back to legacy endpoint pipe definitions; if rollback is needed,
     run the expansion deploy and refresh legacy rollups before treating old dashboards as current.
6. Cleanup:
   - Set consumer write modes to `clean`.
   - Run final parity and performance reports.
   - `TINYBIRD_DEPLOY_PHASE=cleanup TINYBIRD_CLEANUP_APPROVED=trace_flow_prod_YYYYMMDD TB_TARGET_WORKSPACE=trace_flow_prod scripts/deploy-agent-tinybird.sh`
   - This is the only phase allowed to pass `--allow-destructive-operations`.

### Agent incremental rollups

`agent_usage_hourly`, `agent_usage_daily`, `agent_tool_usage_hourly`, and
`agent_tool_usage_daily` are canonical incremental serving tables. They are maintained by
materialized pipes from append-clean fact tables. There are no scheduled replacement copy jobs in the
steady-state path.

Deploy schema changes through the normal PR/merge Tinybird path. For a repair or backfill, use a
bounded, explicitly approved Tinybird branch/cloud-dev operation first, then promote through CI. Any
repo-backed repair pipe must live under `copies/`, be unscheduled, and use a `repair_*` name.

Verify before calling the rollout healthy:

- canonical datasources have expected row counts and bucket bounds.
- materialized totals match clean fact totals for the same window.
- changed endpoints return data for a real org and match serving-table totals where exact.
- scheduled `COPY_MODE replace` job count is zero.
- `agent_session_summaries` remains canonical after the daily cleanup (`count() = uniqExact(session_pk)`).

### Rollup cleanup

The rolling snapshot rollout passed production soak on 2026-06-08 and the canonical rollup names now
own the optimized serving schemas. The follow-up cost refactor removes scheduled replacement copies
from the steady-state design.

Done: endpoints read canonical rollup names, raw fact tables are append-clean, and replacement-copy CPU
is zero in the normal path.

**Break-glass (manual fallback only):** if CI is unavailable, deploy from a local `tb` cloud login.
This is the opt-in escape hatch, not the normal path:

```sh
TB_TARGET_WORKSPACE=trace_flow_prod scripts/deploy-agent-tinybird.sh --check   # validate only
TB_TARGET_WORKSPACE=trace_flow_prod scripts/deploy-agent-tinybird.sh           # expansion deploy
TINYBIRD_DEPLOY_PHASE=switch TB_TARGET_WORKSPACE=trace_flow_prod scripts/deploy-agent-tinybird.sh
```

## Release Gate

A production release is valid only if all checks pass:

1. `tb --local build` + `tb --local test run` + Tinybird deploy `--check` against `trace_flow_prod` —
   PR-time gate, `ci.yml` `tinybird-schema-check`
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
