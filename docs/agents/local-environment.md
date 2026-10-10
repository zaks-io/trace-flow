# Local agent environment

"Dev" means the deployed **Dev Environment**. Everyday development runs only Web locally with
`bun run dev:web`, against cloud dev Workers, Convex dev, and Tinybird dev. See the environment
vocabulary and collector endpoint overrides in [CONTEXT.md](../../CONTEXT.md#environments).

The single **Self-Contained Local** stack is `scripts/dev/local-stack.sh`. It runs a disposable
stack with mock sign-in and no cloud credentials. Starting local Workers requires Isaac's explicit
approval. A supervised run also needs at least 8 GiB available memory from `free -h`.
Code checks and `--help` do not start services.

## Prerequisites and setup

Use a Linux host with Bash, Node 24, Bun 1.3.5, Tinybird CLI, Docker, Compose v2, curl, setsid,
and sha256sum. Install dependencies with the pinned package manager:

```bash
bun install --frozen-lockfile
scripts/dev/local-stack.sh --help
scripts/dev/local-stack.sh doctor
```

`doctor` reports missing tools, Docker daemon, and Compose without starting them. It returns a
failure if a prerequisite is missing. The script never installs host tools or starts Docker.
`local-stack.sh install` is an alias for `bun install --frozen-lockfile`.

`bash setup-worktree.sh` installs dependencies and preserves existing environment files. It does
not start the stack. Cursor editor worktrees use the same command in `.cursor/worktrees.json`.
The former Cursor background image lacked Docker and Compose, so its environment bootstrap and
Dockerfile were removed. Background agents need a host with these prerequisites for a local run.

## Commands

After approval and the memory check:

```bash
scripts/dev/local-stack.sh up
scripts/dev/local-stack.sh login-url [EMAIL]
# Sign in and finish onboarding before seeding that user's organization.
scripts/dev/local-stack.sh seed [EMAIL]
scripts/dev/local-stack.sh status
scripts/dev/local-stack.sh smoke
scripts/dev/local-stack.sh smoke --tinybird-only
scripts/dev/local-stack.sh verify
scripts/dev/local-stack.sh verify full
scripts/dev/local-stack.sh logs web
scripts/dev/local-stack.sh down
```

`login-url` defaults to `dev@trace-flow.local`. Logs are available for `oidc`, `workers`,
`agent-ingest`, `pipes-api`, `raw-api`, `kv-bridge`, and `web`.

`smoke` uses the already-running local proxy, KV bridge, and Tinybird instance. It seeds a temporary
local API key, posts OTLP, waits for the consumer to flush, and queries the trace summary endpoint.
`--tinybird-only` inserts and queries a trace without Workers. Neither mode starts services.
Smoke rows remain in the disposable database until it is purged.

`verify` requires the existing local Tinybird instance, runs its build and tests, then repository
type checks and tests. `full` also runs lint and build. For code checks without a running stack,
use `bun run ci:check`; it does not require stack setup.

Normal `down` stops processes and containers and retains data. `down --purge` permanently deletes
this stack's Convex, Tinybird, and Worker state; get explicit approval before deleting data.

Package aliases use the same script: `dev:setup` starts the stack, `dev:doctor` checks prerequisites,
`dev:seed` seeds the signed-in user's organization, `dev:smoke` checks the running stack, and
`dev:verify` validates it. `dev:web` remains Web against cloud dev. Standalone **Local Workers**
remain separate from the self-contained stack.

## Services and isolation

The stack starts:

- `mock-oidc.ts`, which replaces Auth0 and accepts any email. It must never serve a deployed
  environment. One email maps to a stable local user.
- A self-hosted Convex backend in Docker, configured to trust the mock issuer.
- Tinybird Local through `tinybird-local.compose.yml`, with the existing memory and ClickHouse
  limits. It deploys to that instance's default workspace, independent of the Git branch.
- Proxy and Proxy Consumer in one Wrangler process, Agent Ingest and Agent Consumer in another,
  and separate Pipes API, Raw API, and KV bridge processes. Producer/consumer pairs share their
  process so local queues connect. All use the same private persisted Worker state.
- `kv-bridge.ts`, which receives local Convex writes for API keys, subscriptions, Collector
  Credentials, and pricing into the local KV namespaces the Workers read.
- Web through `next dev`, with only the stack's generated environment values.

Generated secrets, logs, Worker mirrors, and the private Convex CLI directory live under
`.trace-flow/local-stack/`. The stack never rewrites linked `.env.local` or `.dev.vars` files.
Worker mirrors exclude dotenv files and contain only that Worker's required local values.
Web blanks keys declared in its dotenv files before adding stack values. Convex runs from a private
CLI directory because the CLI rewrites `.env.local`. Tinybird also uses a private CLI
directory, pinned to the local default workspace, so an existing cloud `.tinyb` cannot redirect
local deploys or verification. Mock sign-in and generated credentials stay
in local runtime state, never in deploy configuration.

When `sbx-runtime` is installed, the stack allocates stable named ports, private state outside the
checkout, and worktree-specific Docker resources. Without it, the stack uses checkout-local state,
checkout-specific container names, and the documented default ports. Override ports with
`TRACE_FLOW_LOCAL_STACK_*_PORT`; `up` fails when a required port is occupied.

Public URLs use the machine's Tailscale name when available, otherwise `127.0.0.1`.
`TRACE_FLOW_LOCAL_STACK_HOST` changes advertised URLs. Services still bind all interfaces so Docker
and tailnet clients can reach them; keep the host private. The Convex container reaches Tinybird
through a shared Docker network and the issuer/KV bridge through the host. On rootless Docker,
the script uses the host's default-route address because the host gateway cannot reach loopback.

`seed` appends the committed fixtures after rewriting ownership and times for a signed-in user's
organization, then publishes agent snapshots. Repeated seeding adds duplicate rows. The local
proxy accepts the onboarding key and captured requests reach Tinybird after the consumer flush.
Live Collector uploads remain unsupported because Agent Consumer's `TINYBIRD_AGENT_*` tokens are
not configured. Organization erasure remains unsupported because Convex requires an HTTPS ingest
URL. These limitations apply to the prior stacks too.

## Verification boundaries

For script changes without an approved live run, use static evidence:

```bash
shellcheck scripts/dev/*.sh
node --test scripts/dev/setup-worktree.test.mjs scripts/dev/local-stack.test.mjs
scripts/dev/local-stack.sh --help
bun run lint
bun run ci:check
```

Record the live-run gap in the PR. A passing code gate cannot prove mock sign-in, Docker networking,
queue delivery, or shutdown. After approval, one supervised `up`, smoke, and `down` closes that gap;
stop every process and container that run starts. Never run deploy commands as local validation.
