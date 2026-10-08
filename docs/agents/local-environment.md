# Local Agent Environment

> **Vocabulary:** "dev" means the deployed **Dev Environment**. See the **Environments** section of `CONTEXT.md` for the
> shared terms used here: **Dev Environment**, **Local Workers**, **Self-Contained Local**, and
> the **Control Plane** / **Data Plane** split. This document describes the **Self-Contained Local**
> stack. Everyday development uses the **Dev Environment** instead: deployed `*-dev` Workers, Convex
> dev, and Tinybird dev, with only Web running locally. These scripts do not provision it.

This repo exposes one local-development contract for humans, Cursor background agents, and other
coding agents:

```bash
scripts/dev/install.sh
scripts/dev/start.sh
scripts/dev/verify.sh
```

Cursor uses the same commands through `.cursor/environment.json`. Keep Cursor-specific setup thin;
the scripts are the source of truth.

## Which environment these scripts build

By default these scripts provision **Self-Contained Local**: **Local Workers** plus **Convex local**
and **Tinybird Local** in Docker, with generated local-only tokens and no cloud credentials. This is
the right target for Cursor Background Agents and CI, which cannot hold cloud access.

It is **not** the **Dev Environment**, where a developer's data lands day to day. To run Local
Workers against the dev data instead, point the **Data Plane** and **Control Plane** at cloud via
env vars (`TRACE_FLOW_TINYBIRD_HOST` + `TINYBIRD_TOKEN`, `TRACE_FLOW_CONVEX_URL` /
`CONVEX_SITE_URL`) instead of the local defaults. Each plane can be pointed independently.

## What Setup Does

- Installs workspace dependencies with Bun.
- Starts Tinybird Local in Docker and builds the committed `datasources/`, `pipes/`, and `tests/`
  project files against it.
- Runs Tinybird Local from `scripts/dev/tinybird-local.compose.yml` with a memory limit, one CSV
  worker, smaller ClickHouse caches and schedule pools, and without the image's MCP server and Kafka
  connector, instead of `tb local start`. Unbounded, the image sizes itself from host RAM and CPUs
  and idles near 4 GB; this setup idles near 1.8 GB. Fixture appends stage uploads in the image's
  object store, so that service stays. The container keeps the
  `tinybird-local` name, ports, and `.trace-flow/tinybird` data, so `tb local status`/`stop` still
  work. Restart with `start.sh`, not `tb local restart`, which recreates the container without
  limits or data. Setup replaces an older `tb local start` container that uses the same data
  directory. Requires Docker Compose v2.
- Generates ignored local runtime files for Workers and web:
  - `apps/*/.dev.vars`
  - `apps/web/.env.local`
  - `.trace-flow/dev.env`
- Leaves existing local env files alone unless `TRACE_FLOW_OVERWRITE_LOCAL_ENV=1` is set, except for
  Tinybird Local URL/token lines that setup keeps aligned with the current local workspace.

The generated values are local-only placeholders. They are intentionally not suitable for production
or preview deploys.

Tinybird Local still enforces bearer auth on its HTTP API, but agents do not need a provisioned cloud
Tinybird token. `scripts/dev/start.sh` discovers or generates the local workspace token and writes it
to ignored runtime files. When `TRACE_FLOW_SKIP_TINYBIRD=1` is set, setup uses local placeholders and
does not require the Tinybird CLI.

## Common Commands

```bash
# One-time or branch-change setup
scripts/dev/install.sh

# Prepare local infra and generated env files
scripts/dev/start.sh

# Run long-lived services in separate terminals
scripts/dev/convex.sh
scripts/dev/workers.sh
scripts/dev/web.sh

# Run an end-to-end runtime smoke test
scripts/dev/smoke.sh

# Validate the local data project and code
scripts/dev/verify.sh
scripts/dev/verify.sh full

# Inspect missing prerequisites
scripts/dev/doctor.sh
```

## Local Stack With Mock Sign-In

`scripts/dev/local-stack.sh` runs a disposable **Self-Contained Local** stack you can sign in to
without Auth0. Use it to evaluate the web app in a browser, take screenshots, or share a running
build with a reviewer. Never point a deployed environment at it.

```bash
scripts/dev/local-stack.sh up                  # start everything and print URLs
scripts/dev/local-stack.sh login-url [EMAIL]   # one-step sign-in URL (default dev@trace-flow.local)
scripts/dev/local-stack.sh seed [EMAIL]        # load fixtures into that user's org (sign in first)
scripts/dev/local-stack.sh status
scripts/dev/local-stack.sh logs web            # oidc | workers | agent-ingest | pipes-api |
                                               # raw-api | kv-bridge | web
scripts/dev/local-stack.sh down [--purge]      # also stops Tinybird Local; --purge deletes Convex,
                                               # Tinybird (shared with start.sh), and Worker state
```

What it runs:

- `scripts/dev/mock-oidc.ts`: a mock OIDC issuer that takes Auth0's place. Its sign-in page accepts
  any email, and `/auth/login?login_hint=<email>` signs in with no form. The same email always
  maps to the same user.
- A self-hosted Convex backend in Docker (`trace-flow-local-convex`), configured to trust the mock
  issuer. It runs four Tokio and four V8 threads instead of one of each per host core, under a 1 GiB
  memory limit.
- Tinybird Local, with the project deployed to the workspace named after the project path. This
  holds regardless of the current git branch.
- The Workers in four `wrangler dev` processes, plus the KV bridge below in a fifth, all sharing
  state under `.trace-flow/local-stack/wrangler`. The proxy and its consumer share one process and
  the agent ingest Worker and its consumer share another, because queues only connect Workers in the
  same process. The Pipes API and Raw API have their own processes and ports.
- `scripts/dev/kv-bridge.ts`: a Worker that stands in for Cloudflare's KV REST API. Convex syncs
  API keys, subscriptions, Collector Credentials, and model pricing to KV over that API, so the
  stack sets Convex's `CLOUDFLARE_API_BASE_URL` to this bridge. It writes to the same local KV
  namespaces the Workers read.
- Web via `next dev`, started from an empty environment plus the stack's values. Next never
  overrides a variable that is already set, so every key in `apps/web`'s dotenv files is set
  empty, and a linked `apps/web/.env.local` contributes no values.

Public URLs use the machine's Tailscale name when one exists, so another tailnet device can open
them. Set `TRACE_FLOW_LOCAL_STACK_HOST=127.0.0.1` to keep everything on loopback, and
`TRACE_FLOW_LOCAL_STACK_*_PORT` to move a port; `up` fails when a port is already taken.
Container names are fixed, so one stack runs per Docker engine, and `up` or `down` from another
checkout refuses to touch a running stack. Generated secrets, logs, and the Convex CLI's
working directory live in `.trace-flow/local-stack/`. The Convex CLI rewrites `.env.local` in its
working directory, so it never runs from the repo root.

`wrangler dev` passes `--env-file` only to the first config in a process. Every other Worker reads
the `.dev.vars` beside its config, and worktrees may link those to cloud dev credentials. Each
Worker therefore runs from a mirror of its app directory under `.trace-flow/local-stack/workers/`.
The mirror links everything except dotenv files and adds a `.dev.vars` holding only the variables
that Worker reads, so production's secret boundaries hold locally too. The KV namespace ids Convex
writes to are pinned in `local-stack.sh`, which fails when an app's config stops binding them.

The Convex container reaches Tinybird Local over a shared Docker network (`trace-flow-local`),
because Tinybird publishes its port only on host loopback. It reaches the mock issuer and the KV
bridge through the host. Rootless Docker's host gateway cannot reach host services, so there the
script uses the host's default-route address instead.

`seed` rewrites the committed `fixtures/*.ndjson` so they belong to the user's org and end an hour
ago. It then publishes agent snapshots the same way the agent-consumer snapshot runner does. Seeding
again appends duplicate rows; purge to start over. Proxy traffic is not part of the seed, but the
onboarding key works against the local proxy, and captured requests reach local Tinybird after the
consumer's one-minute flush. Live Collector uploads do not complete locally: the agent consumer's
`TINYBIRD_AGENT_*` tokens are not configured, as in `start.sh`. Organization erasure does not run
locally, because Convex requires an HTTPS agent ingest URL.

After signing in and opening the main pages, the stack holds about 6.5 GiB: the five `wrangler dev`
processes about 2.7 GiB, `next dev` 1.3 to 2.3 GiB (more after a cold compile), Tinybird Local about
1.85 GiB, and Convex about 0.35 GiB. It runs about 1,100 processes and threads. ClickHouse inside
Tinybird Local aborts when systemd limits Docker scopes to the default 15% of the task limit. Hosts
that cap container tasks need `TasksMax=infinity` for `docker-*.scope` units.

## Convex Gotchas

- **Run Convex commands from the repo root, never from `packages/convex/`.** The root `convex.json`
  sets `"functions": "packages/convex"`, and `scripts/dev/convex.sh` `cd`s to the repo root before
  `bunx convex dev`. Running `bunx convex dev --once` from inside `packages/convex/` resolves the
  functions dir to the empty `packages/convex/convex/` directory and pushes **zero** functions while
  still printing `Convex functions ready!`. New functions then 404 at runtime. Symptom: a freshly
  added function returns `Could not find function ... Did you forget to run npx convex dev?`.
- Use `bunx convex dev --once` to push to the dev **Control Plane**; never `convex deploy` (that is a
  production action).
- **Never pass `-v`/`--verbose` to `convex dev`, and never run `convex env list`/`env get`** — they
  print Convex environment secret _values_, not just keys. To confirm a function deployed, run it with
  invalid args and read the `ArgumentValidationError` instead.

## Agent Defaults

Agents should prefer local validation before asking for cloud resources:

1. Run `scripts/dev/start.sh`.
2. Make the code change.
3. Run the narrowest relevant tests.
4. Run `scripts/dev/smoke.sh` when the change touches runtime wiring, Worker bindings, queues, or
   Tinybird ingestion. This smoke covers the local proxy/OTLP path; production agent-ingest smoke is
   `scripts/agent-ingest-smoke.sh` and must follow `docs/guides/agent-conversation-analytics/runbook.md`.
5. Run `scripts/dev/verify.sh` before handing work back.

Do not run deploy commands from this environment. PR previews and production deploys are separate
cloud workflows with explicit credentials and cleanup requirements.

## Useful Switches

- `TRACE_FLOW_AUTO_INSTALL_TOOLS=1`: allow `install.sh` to install Bun or Tinybird CLI if missing.
- `TRACE_FLOW_SKIP_TINYBIRD=1`: skip Tinybird Local and token discovery when only code checks are
  needed.
- `TRACE_FLOW_SKIP_TB_BUILD=1`: start Tinybird Local without building the Tinybird project.
- `TRACE_FLOW_TINYBIRD_MEMORY=3g`: Tinybird Local container memory limit. ClickHouse fails queries
  at 90% of it. `bun run test:tinybird` peaks near 2.2 GiB of anonymous memory in the container.
- `TRACE_FLOW_TINYBIRD_CPU_COUNT=2`: CPU count Tinybird Local sizes its Python worker pools from.
  `start.sh` leaves a running container alone, so to apply either Tinybird setting run
  `tb local stop && docker rm tinybird-local` and rerun `start.sh`. Data persists in `.trace-flow/tinybird`.
- `TRACE_FLOW_OVERWRITE_LOCAL_ENV=1`: regenerate ignored `.dev.vars` and `apps/web/.env.local`.
- `TRACE_FLOW_VERIFY_SKIP_START=1`: run verification without preparing local infra first.
- `TRACE_FLOW_SMOKE_START_WORKERS=0`: require an already-running Worker server for smoke tests.
- `TRACE_FLOW_SMOKE_TINYBIRD_ONLY=1`: smoke only Tinybird insert/query without Workers or queues.
