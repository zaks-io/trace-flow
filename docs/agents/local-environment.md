# Local Agent Environment

> **Vocabulary:** "dev" is overloaded. See the **Environments** section of `CONTEXT.md` for the
> shared terms used here: **Local Workers**, **Cloud-Dev**, **Self-Contained Local**, and the
> **Control Plane** / **Data Plane** split. This document describes the **Self-Contained Local**
> stack. If you mean "local Workers pointed at a developer's Convex/Tinybird Cloud dev" — that is
> **Cloud-Dev**, a different data plane, and these scripts do not provision it by default.

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

It is **not** the same as **Cloud-Dev** — the "Local Workers → Convex Cloud dev + Tinybird Cloud
dev" setup a developer typically runs day to day and where they expect their data to appear in the
cloud dashboards. To run Cloud-Dev, point the **Data Plane** and **Control Plane** at cloud via env
vars (`TRACE_FLOW_TINYBIRD_HOST` + `TINYBIRD_TOKEN`, `TRACE_FLOW_CONVEX_URL` / `CONVEX_SITE_URL`)
instead of the local defaults. Each plane can be pointed independently.

## What Setup Does

- Installs workspace dependencies with Bun.
- Starts Tinybird Local in Docker and builds the committed `datasources/`, `pipes/`, and `tests/`
  project files against it.
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
- `TRACE_FLOW_OVERWRITE_LOCAL_ENV=1`: regenerate ignored `.dev.vars` and `apps/web/.env.local`.
- `TRACE_FLOW_VERIFY_SKIP_START=1`: run verification without preparing local infra first.
- `TRACE_FLOW_SMOKE_START_WORKERS=0`: require an already-running Worker server for smoke tests.
- `TRACE_FLOW_SMOKE_TINYBIRD_ONLY=1`: smoke only Tinybird insert/query without Workers or queues.
