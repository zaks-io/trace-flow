# Local Agent Environment

This repo exposes one local-development contract for humans, Cursor background agents, and other
coding agents:

```bash
scripts/dev/install.sh
scripts/dev/start.sh
scripts/dev/verify.sh
```

Cursor uses the same commands through `.cursor/environment.json`. Keep Cursor-specific setup thin;
the scripts are the source of truth.

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

## Agent Defaults

Agents should prefer local validation before asking for cloud resources:

1. Run `scripts/dev/start.sh`.
2. Make the code change.
3. Run the narrowest relevant tests.
4. Run `scripts/dev/smoke.sh` when the change touches runtime wiring, Worker bindings, queues, or
   Tinybird ingestion.
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
