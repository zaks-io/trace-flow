# Trace Flow

**Keep a history of your AI work. See what it costs.**

Trace Flow collects data from model calls and coding agents in the background so you can track
spending and performance over time. Use the desktop app to capture coding-session analytics, or
connect your existing SDK to capture model API calls. Investigate wasted tokens, growing context,
and tool failures through the dashboard and MCP tools, or use Trace Flow Analyst on Pro.

The history gives you something to come back to as your models and workflows change. Monthly
model usage totals are retained for five years and coding-agent analytics for one year. Individual
model traces have shorter, plan-based access windows. See the
[retention policy](https://trace-flow.dev/privacy).

Trace Flow Analyst is the in-app chat for asking questions about the analytics you already collect.
It requires an active Pro subscription and is not available on Hobby.
It opens as a sidebar on every dashboard page, keeps threads private to their creator, and can
attach objects from the current page to a message. Data questions run in a sealed Cloudflare
Sandbox where a Python analysis agent queries your Trace Flow data and reports back with its cost.

We're building an opt-in archive of full agent conversations so the exchanges behind the metrics
can become part of your own record. The upload path is implemented end to end, from the collector
spool through the Archive API to encrypted R2 storage, but it is not deployed and archive
availability stays off in Convex. Conversation archiving and search are not available yet. The next
step for Analyst is analyzing that archive to find where agents get stuck or waste time and tokens,
with future uses in fine-tuning and alignment research.

Trace Flow grew out of Zaks.io's own work and is available in private alpha. The source is published
under [Apache-2.0](./LICENSE). Expect changing features and setup work; there is no support SLA.

## What Trace Flow observes

### Model API requests

Applications keep their provider SDK and provider API key, point the SDK at the Trace Flow gateway,
and add an organization-scoped Trace Flow API key. The gateway streams the provider response back to
the caller while it captures timing, token usage, estimated cost, trace context, and optional request
and response bodies.

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
or response bodies. See the [Quick Start](https://trace-flow.dev/docs/quick-start) and
[SDK Reference](https://trace-flow.dev/docs/sdk-reference) for complete examples.

### Coding-agent sessions

The local collector reads supported agent stores, emits redacted typed facts, and uploads them with a
Collector Credential that is separate from gateway API keys. The dashboard reports cost, tokens,
context pressure, tool reliability, repository activity, and directly linked review-unit estimates.

Current sources are Claude Code, Codex CLI, and Cursor on macOS. The desktop app gates the first
upload behind an explicit **Start syncing** action. Raw transcripts are not uploaded by this path.

- [Collector guide](https://trace-flow.dev/docs/collector)
- [CLI source and development notes](./apps/cli/README.md)
- [Desktop architecture and release notes](./apps/desktop/README.md)

## Architecture

Two inputs feed one control plane and one data plane. Convex owns users, organizations, API keys,
Collector Credentials, subscriptions, session ownership, and scoped Tinybird token minting. Tinybird
holds the trace spans and agent facts the dashboard reads. R2 holds encrypted request and response
bodies. Convex also hosts the Analyst Runtime on Convex Agents
([ADR 0022](./docs/adr/0022-trace-flow-analyst-convex-runtime.md)), which reaches Trace Flow data
only through the Analyst Sandbox Worker. The Rust workspace contains the collector CLI, the desktop
shell, parsers, the sync engine, and the Conversation Archive contracts, spool, and upload client.

The runtime is split into more Cloudflare Workers than the feature list suggests. The count is
structural, not a sign of separate products. Each input has an ingress Worker and a separate queue
consumer (Proxy and Proxy Consumer for model calls, Agent Ingest and Agent Consumer for collector
uploads) so capture never waits on Tinybird writes
([ADR 0007](./docs/adr/0007-queue-based-processing.md)). The read side is two Workers because
[ADR 0020](./docs/adr/0020-read-side-secret-boundaries.md) keeps Body Object decryption keys and
Tinybird forwarding in separate isolates (Raw API and Pipes API). Web and MCP read through those two.
The Analyst Sandbox Worker (`apps/analyst-sandbox`) runs model-generated Python in a container with
all egress denied except calls back to the Worker itself. `apps/archive-api` is implemented but not
deployed. The per-app map is in [repo navigation](./docs/agents/repo-navigation.md).

### Data flow

```text
Application -> Proxy -> provider
                  |-> R2 delivery envelope -> request queue reference
                                                |-> Proxy Consumer -> Tinybird + R2 Body Object

CLI/Desktop -> Agent Ingest -> agent queue -> Agent Consumer -> Tinybird

Web/MCP -> Convex-scoped authorization -> Pipes API / Raw API -> Tinybird / R2
```

The proxy consumes both sides of each `ReadableStream.tee()`. Accepted traces remain in an R2 delivery
envelope until the Proxy Consumer completes durable handoff; failed or uncertain Tinybird writes stay
available for reconciliation. Queue consumers acknowledge messages only after their durable write
path succeeds. See [delivery guarantees and recovery](./docs/guides/trace-delivery-recovery.md).

## Repository map

```text
apps/                 Cloudflare Workers, Next.js Web, Collector CLI, Desktop
packages/             Shared TypeScript packages, Convex backend, Rust collector crates
datasources/          Tinybird datasource definitions
materializations/     Tinybird materialized views
pipes/                Tinybird query endpoints
tests/                Tinybird data-project tests
docs/adr/             Accepted architecture decisions
docs/guides/          Operational and feature guides
scripts/dev/          Reproducible local environment and verification commands
specs/                Component and feature specifications
```

The canonical domain vocabulary is in [CONTEXT.md](./CONTEXT.md).

## Development

Requirements:

- Bun 1.3.x, pinned by `packageManager`
- Node.js 24
- Rust toolchain for collector or desktop work
- Docker and the Tinybird CLI for the self-contained local data plane

The configuration and CI workflows contain Zaks.io resource names, domains, and deployment IDs.
A fork needs its own service accounts, resources, secrets, and deployment configuration. Review
`.mcp.json` and `.codex/config.toml` before enabling the checked-in agent connections; they point to
company services. The
collector defaults to company endpoints; set `TRACE_FLOW_INGEST_URL` and
`TRACE_FLOW_CONVEX_SITE_URL` before using it with your own deployment.

Install the workspace and prepare the local environment:

```bash
scripts/dev/install.sh
scripts/dev/start.sh
```

Run the long-lived processes in separate terminals:

```bash
scripts/dev/convex.sh
scripts/dev/workers.sh
scripts/dev/web.sh
```

`scripts/dev/workers.sh` starts the six core data-plane Workers together so local queues, KV, R2,
and Durable Objects share one persisted state directory. Web, Convex, MCP, the Analyst Sandbox, and
the undeployed Archive API are not part of that multi-Worker process.

The scripts default to **Self-Contained Local**: local Workers, Convex local, and Tinybird Local. For
the normal **Cloud-Dev** workflow, point the local Web and collector at the deployed cloud-dev
endpoints. Do not assume a Worker whose configured name ends in `-dev` is a separate cloud
environment. See [Local Agent Environment](./docs/agents/local-environment.md) and the environment
definitions in [CONTEXT.md](./CONTEXT.md).

### Verification

```bash
scripts/dev/smoke.sh          # local proxy -> queue -> Tinybird path
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

The Conversation Archive origin is intentionally absent. `apps/archive-api` implements the upload
path: Collector Credential plus enrollment authorization, Archive Observation JSONL validation, the
Archive Session Ledger and Storage Budget Durable Objects, encrypted chunk and manifest writes to R2,
and integrity and audit reporting to Convex. Export and deletion routes fail closed because no Archive
Export Grant issuer exists yet. The Worker has only a development configuration and is not deployed.

## Deployment

Production deploys run through `.github/workflows/deploy.yml` after changes land on `main`. The
workflow validates TypeScript, Rust, and Tinybird; deploys Convex; deploys the Tinybird schema before
both consumers; then deploys the remaining Workers in dependency order.

`apps/archive-api` is excluded from production deployment. Do not manually deploy production.

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
