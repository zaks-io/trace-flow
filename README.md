# Trace Flow

**Keep a history of your AI work. See what it costs.**

Trace Flow collects data from model calls and coding agents in the background so you can track
spending and performance over time. Use the desktop app to capture coding-session analytics, or
connect your existing SDK to capture model API calls. Investigate wasted tokens, growing context,
and tool failures through the dashboard and MCP tools, or use Trace Flow Analyst on Pro.

The history gives you something to come back to as your models and workflows change. Monthly
model usage totals are retained for five years, daily totals for two years, and coding-agent
analytics for one year. Individual model traces are available for 7 days on Hobby and 30 days on
Pro. See the [retention policy](https://trace-flow.dev/privacy).

Trace Flow grew out of Zaks.io's own work and is available in private alpha. The source is published
under [Apache-2.0](./LICENSE). Expect changing features and setup work; there is no support SLA.

## What Trace Flow observes

### Model API requests

Applications keep their provider SDK and provider API key, point the SDK at the Trace Flow gateway,
and add an organization-scoped Trace Flow API key. The gateway forwards the provider credentials
unchanged and streams the provider response back to the caller while it captures timing, token
usage, W3C trace context (`traceparent`, `tracestate`, `baggage`), and optional request and response
bodies. The Proxy Consumer estimates cost from model pricing and also records the provider-reported
cost when the provider returns one, as OpenRouter does.

Implemented provider routes:

| Provider   | Base URL                                       |
| ---------- | ---------------------------------------------- |
| OpenAI     | `https://gateway.trace-flow.dev/openai/v1`     |
| Anthropic  | `https://gateway.trace-flow.dev/anthropic/v1`  |
| Google     | `https://gateway.trace-flow.dev/google/v1beta` |
| OpenRouter | `https://gateway.trace-flow.dev/openrouter/v1` |
| Groq       | `https://gateway.trace-flow.dev/groq/v1`       |

```typescript
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';

const openai = createOpenAI({
  baseURL: 'https://gateway.trace-flow.dev/openai/v1',
  apiKey: process.env.OPENAI_API_KEY,
  headers: {
    'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY,
  },
});

const result = await generateText({
  model: openai(process.env.OPENAI_MODEL!),
  prompt: 'Hello, world!',
});
```

Use `X-Trace-Flow-Omit-Body: true` when you want metrics and trace metadata without storing request
or response bodies. Stored bodies are encrypted before they reach R2.

The gateway also accepts OpenTelemetry traces at `POST https://gateway.trace-flow.dev/v1/traces`,
authenticated with the same `X-Trace-Flow-Api-Key` header. See the
[Quick Start](https://trace-flow.dev/docs/quick-start),
[SDK Reference](https://trace-flow.dev/docs/sdk-reference), and
[OpenTelemetry guide](https://trace-flow.dev/docs/opentelemetry).

### Coding-agent sessions

The local collector reads supported agent stores on the user's machine, derives redacted typed facts,
and uploads them with a Collector Credential that is separate from gateway API keys. Message facts
carry ids, roles, models, token counts, and repository metadata, not message text. Tool facts carry
redacted command excerpts (up to 1 KB), redacted error excerpts (up to 4 KB), repository-relative file
paths, and navigation hints. Raw transcripts are never uploaded.

| Source      | Where it is read                               |
| ----------- | ---------------------------------------------- |
| Claude Code | macOS and Windows desktop, macOS and Linux CLI |
| Codex CLI   | macOS and Windows desktop, macOS and Linux CLI |
| Cursor      | macOS only                                     |

The desktop app (macOS arm64 and Windows x64) gates the first upload behind an explicit
**Start syncing** action. The CLI has no published installer yet; build it from source as described
in the [CLI README](./apps/cli/README.md).

The **Agents** dashboard reports cost, token, and usage trends with a cost projection, per-turn
context size, cost as conversations deepen, tool failure rates, where spend concentrates, and costs
for directly linked pull requests and merge requests. Filter by source, model, and repository.

Agent Conversation Analytics is not production-ready until its
[roadmap gates](./docs/guides/agent-conversation-analytics/ROADMAP.md) are complete.

- [Collector guide](https://trace-flow.dev/docs/collector)
- [CLI source and development notes](./apps/cli/README.md)
- [Desktop architecture and release notes](./apps/desktop/README.md)

### Dashboard, alerts, and MCP

The web dashboard covers traces and spans, requests, per-operation usage, model pricing, API keys,
and coding-agent analytics. Cost alerts notify by email or webhook on spend thresholds, projected
monthly spend, expensive single requests, hourly spend spikes, and use of models outside an approved
list. Webhooks configured with a secret are signed with `X-Trace-Flow-Signature`. See the
[webhook guide](./docs/guides/cost-alert-webhooks.md).

The MCP server at `https://mcp.trace-flow.dev/mcp` signs in with OAuth and exposes tools for traces,
spans, span events, usage summaries, per-operation and per-model usage, agent analytics queries, and
API key listing. MCP tools never return request or response bodies. See the
[MCP guide](https://trace-flow.dev/docs/mcp).

### Trace Flow Analyst

Trace Flow Analyst is the in-app chat for asking questions about the analytics you already collect.
It requires an active Pro subscription and is not available on Hobby. It opens as a sidebar on every
dashboard page, keeps threads private to their creator, and can attach objects from the current page
to a message. Data questions run in a sealed Cloudflare Sandbox with internet access disabled. Its
outbound traffic is limited to the Analyst Sandbox Worker, which brokers model calls and data
queries, and the sandbox's own R2 storage. Inside it, an analysis agent
writes and runs Python against your Trace Flow data and reports back with its cost.

## Architecture

Two inputs feed one control plane and one data plane. Convex owns users and organizations (signed in
through Auth0), API keys, Collector Credentials, Stripe subscriptions, session ownership, cost
alerts, MCP OAuth, and scoped Tinybird token minting. Tinybird holds the trace spans and agent facts
the dashboard reads. R2 holds encrypted request and response bodies and in-flight delivery objects.
Convex also hosts the Analyst Runtime on Convex Agents
([ADR 0022](./docs/adr/0022-trace-flow-analyst-convex-runtime.md)), which reaches Trace Flow data
only through the Analyst Sandbox Worker. The Rust workspace contains the collector CLI, the desktop
shell, parsers, and the sync engine.

The runtime is split into more Cloudflare Workers than the feature list suggests. The count is
structural, not a sign of separate products. Each input has an ingress Worker and a separate
consumer (Proxy and Proxy Consumer for model calls, Agent Ingest and Agent Consumer for collector
uploads) so capture never waits on Tinybird writes
([ADR 0007](./docs/adr/0007-queue-based-processing.md),
[ADR 0024](./docs/adr/0024-bounded-agent-ingestion.md)). The read side is two Workers because
[ADR 0020](./docs/adr/0020-read-side-secret-boundaries.md) keeps Body Object decryption keys and
Tinybird forwarding in separate isolates (Raw API and Pipes API). Web reads through those two. MCP
gets a scoped token from Convex and queries Tinybird directly, so it never touches bodies. Web is a
Next.js app deployed to Workers with OpenNext. The Analyst Sandbox Worker (`apps/analyst-sandbox`)
runs model-generated code in a container with all egress denied except calls back to the Worker
itself. The per-app map is in [repo navigation](./docs/agents/repo-navigation.md).

### Data flow

```text
Application -> Proxy -> provider
                 |-> R2 delivery envelope -> request queue reference
                                               |-> Proxy Consumer -> Tinybird + R2 Body Object

CLI/Desktop -> Agent Ingest -> R2 delivery object + Agent Consumer registration -> agent queue
                                                         |-> Agent Consumer -> Tinybird

Web -> Convex-scoped authorization -> Pipes API / Raw API -> Tinybird / R2
MCP -> Convex-scoped token -> Tinybird
```

The proxy consumes both sides of each `ReadableStream.tee()`. Accepted traces remain in an R2 delivery
envelope until the Proxy Consumer completes durable handoff; failed or uncertain Tinybird writes stay
available for reconciliation. Agent Ingest checks capacity with Agent Consumer's Durable Objects
before it accepts an upload. Queue consumers acknowledge messages only after their durable write
path succeeds. See [delivery guarantees and recovery](./docs/guides/trace-delivery-recovery.md).

## Repository map

```text
apps/                 Cloudflare Workers, Next.js Web, Collector CLI, Desktop
packages/             Shared TypeScript packages, Convex backend, Rust collector crates
datasources/          Tinybird datasource definitions
materializations/     Tinybird materialized views
pipes/                Tinybird query endpoints
copies/               Tinybird copy pipes for snapshot and baseline repair
tests/                Tinybird data-project tests
fixtures/             Sample facts and spans for seeding and tests
skills/               Public Trace Flow agent skill served by Web
docs/adr/             Architecture decisions
docs/guides/          Operational and feature guides
docs/agents/          Coding-agent workflow and navigation docs
scripts/dev/          Reproducible local environment and verification commands
specs/                Component and feature specifications
```

The canonical domain vocabulary is in [CONTEXT.md](./CONTEXT.md).

## Development

Requirements:

- Bun 1.3.x, pinned by `packageManager`
- Node.js 24
- Stable Rust toolchain for collector or desktop work
- Docker and the Tinybird CLI for the self-contained local data plane

The configuration and CI workflows contain Zaks.io resource names, domains, and deployment IDs.
A fork needs its own service accounts, resources, secrets, and deployment configuration. Review
`.mcp.json` and `.codex/config.toml` before enabling the checked-in agent connections; they point to
company services. The collector defaults to company endpoints; set `TRACE_FLOW_INGEST_URL` and
`TRACE_FLOW_CONVEX_SITE_URL` before using it with your own deployment.

### Everyday development

Only Web runs locally. It talks to the deployed dev Workers, the Convex dev deployment, and
Tinybird dev.

```bash
bun install --frozen-lockfile
cp apps/web/.env.local.example apps/web/.env.local   # then fill in the dev values
bun run dev:web
```

Point CLI and desktop collectors at the dev endpoints listed in
[CONTEXT.md](./CONTEXT.md#concrete-endpoints-canonical--stop-rediscovering-these).

### Self-Contained Local

The `scripts/dev` scripts provision **Self-Contained Local** for CI, background agents, and offline
work: local Workers, Convex local, and Tinybird Local in Docker.

```bash
scripts/dev/install.sh
scripts/dev/start.sh
scripts/dev/doctor.sh   # inspect missing prerequisites
```

Run the long-lived processes in separate terminals:

```bash
scripts/dev/convex.sh
scripts/dev/workers.sh
scripts/dev/web.sh
```

`scripts/dev/workers.sh` starts the six core data-plane Workers (Proxy, Proxy Consumer, Raw API,
Pipes API, Agent Ingest, Agent Consumer) together so local queues, KV, R2, and Durable Objects share
one persisted state directory. Web, Convex, MCP, and the Analyst Sandbox are not part of that
multi-Worker process. See [Local Agent Environment](./docs/agents/local-environment.md) and the
environment definitions in [CONTEXT.md](./CONTEXT.md).

### Verification

```bash
bun run ci:check              # full local gate: duplicates, formatting, lint, types, tests, build
scripts/dev/smoke.sh          # local OTLP ingest -> queue -> Tinybird path
scripts/dev/verify.sh         # Tinybird build/tests, type-check, tests
scripts/dev/verify.sh full    # plus lint and TypeScript build
cargo test --workspace --locked
```

The JavaScript workspace uses Turborepo:

```bash
bun run type-check
bun run test
bun run lint
bun run build
```

## Company deployment

These URLs belong to the company deployment. Publishing the source does not grant access to it or
promise availability. Use your own endpoints and credentials for an independent deployment.

- Dashboard: <https://trace-flow.dev>
- Human docs: <https://trace-flow.dev/docs>
- Agent bootstrap: <https://trace-flow.dev/agents.md>
- LLM documentation index: <https://trace-flow.dev/llms.txt>
- Gateway: <https://gateway.trace-flow.dev>
- MCP: <https://mcp.trace-flow.dev/mcp>
- Desktop downloads: [macOS arm64](https://downloads.zaks.sh/trace-flow/desktop/latest/trace-flow-desktop.dmg) · [Windows x64](https://downloads.zaks.sh/trace-flow/desktop/latest/trace-flow-desktop-setup.exe)

## Deployment

Production deploys run through `.github/workflows/deploy.yml` after changes land on `main`. The
workflow runs TypeScript and Rust checks, then deploys the Tinybird schema, then Convex and the
Proxy Consumer, then the remaining Workers in dependency order. Agent Consumer deploys before the
read-only Tinybird resource verification, and Agent Ingest deploys after verification.

PR previews run through `.github/workflows/preview.yml`, which the repository owner dispatches
manually. Desktop builds publish through `.github/workflows/desktop-release.yml`.

Do not manually deploy production.

See [SETUP.md](./SETUP.md) for resource ownership, secrets, and environment-specific setup.

## Contributing and security

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development and contribution expectations, and
[SECURITY.md](./SECURITY.md) for private vulnerability reporting. Do not include real prompts,
transcripts, credentials, or customer data in issues and pull requests.

## License

Original project code and documentation are licensed under the [Apache License, Version 2.0](./LICENSE).
See [NOTICE](./NOTICE) and [third-party notices](./THIRD_PARTY_NOTICES.md) for attribution.
Third-party components retain their own licenses.
The license does not grant rights to company or provider trademarks.

## Sandbox worktrees

When `sbx-runtime` is installed, `bun run dev:all` assigns stable named ports for
the full stack, including Worker inspectors. Each worktree gets private state
outside the checkout and its own Convex and Tinybird containers and volumes.
Use `sbx-runtime list` to find URLs; explicit local-stack port overrides remain
supported and fail if another worktree has reserved the port.

Normal shutdown retains data. The explicit `--purge` option removes only the
current worktree's stack data. Existing checkout data is retained; the first
managed run starts a fresh database. Standalone development keeps its existing
port and state defaults when the helper is absent.
