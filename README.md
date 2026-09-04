# Trace Flow

Trace Flow is Zaks.io's internal development tooling for inspecting model API requests and local
coding-agent sessions. We are sharing the source under [Apache-2.0](./LICENSE) because it may be
useful to other builders working on similar problems.

This is an early, company-specific project. Expect rough edges, changing APIs, and setup work.
It is not a supported observability service or a turnkey self-hosted package. Maintenance follows
our internal needs; there is no support SLA or release schedule.

The model gateway is used internally. Agent Conversation Analytics has collector, ingestion,
dashboard, and desktop implementations, but is not production-ready until the checks in the
[roadmap](./docs/guides/agent-conversation-analytics/ROADMAP.md) are complete. Conversation Archive
is unfinished and its API is disabled. Roadmaps and specifications describe intended work, not
necessarily working features.

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

## Runtime

The repository contains nine services deployed by the production workflow and one disabled Archive
API scaffold:

| Component       | Location               | Responsibility                                                         |
| --------------- | ---------------------- | ---------------------------------------------------------------------- |
| Proxy           | `apps/proxy`           | Streams provider calls; durably stages transactions and OTLP spans     |
| Proxy Consumer  | `apps/proxy-consumer`  | Prices and writes LLM spans to Tinybird                                |
| Agent Ingest    | `apps/agent-ingest`    | Authenticates and validates collector fact envelopes                   |
| Agent Consumer  | `apps/agent-consumer`  | Deduplicates, prices, and writes agent facts to Tinybird               |
| Pipes API       | `apps/pipes-api`       | Forwards Convex-minted, query-scoped Pipe Tokens to Tinybird           |
| Raw API         | `apps/api`             | Authorizes and decrypts R2 Body Object reads                           |
| MCP             | `apps/mcp`             | Exposes org-scoped trace and agent analytics tools over OAuth          |
| Analyst Sandbox | `apps/analyst-sandbox` | Runs isolated, stateful analysis jobs                                  |
| Web             | `apps/web`             | Next.js dashboard deployed through OpenNext                            |
| Archive API     | `apps/archive-api`     | Disabled authorization scaffold; persistence and production are absent |

Convex owns users, organizations, API keys, Collector Credentials, subscriptions, session ownership,
and scoped Tinybird token minting. The Rust workspace contains the CLI, desktop shell, parsers, sync
engine, and Conversation Archive contracts.

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

The canonical domain vocabulary is in [CONTEXT.md](./CONTEXT.md). The current service boundaries are
documented in [ADR 0020](./docs/adr/0020-read-side-secret-boundaries.md).

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
and Durable Objects share one persisted state directory. Web, Convex, MCP, Analyst Sandbox, and the
disabled Archive API are not part of that multi-Worker process.

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

The Conversation Archive origin is intentionally absent. `apps/archive-api` currently implements a
fail-closed authorization boundary only and is not deployed.

## Deployment

Production deploys run through `.github/workflows/deploy.yml` after changes land on `main`. The
workflow validates TypeScript, Rust, and Tinybird; deploys Convex; deploys the Tinybird schema before
both consumers; then deploys Web, Proxy, Proxy Consumer, Raw API, Pipes API, MCP, Agent Ingest, Agent
Consumer, and Analyst Sandbox according to their dependencies.

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
