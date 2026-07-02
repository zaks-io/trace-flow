# Trace Flow

LLM request proxy and analytics platform built on Cloudflare Workers.

## Architecture

The primary observability runtime contains seven Cloudflare Workers across two ingestion paths:

- **Proxy** (`apps/proxy`) - LLM request proxy that logs requests and enqueues them for processing
- **Proxy Consumer** (`apps/proxy-consumer`) - Queue consumer that writes LLM traces to Tinybird
- **Agent Ingest** (`apps/agent-ingest`) - Collector intake worker for local AI-agent transcript facts
- **Agent Consumer** (`apps/agent-consumer`) - Queue consumer that prices and writes agent facts to Tinybird
- **Pipes API** (`apps/pipes-api`) - Forwards Convex-minted Tinybird Pipe Tokens to Tinybird
- **Raw API** (`apps/api`) - Provides R2 access for fetching request/response bodies
- **Web** (`apps/web`) - Next.js analytics dashboard (Cloudflare Workers via OpenNext)

### How It Works

When a client sends a request to your LLM API endpoint, the Cloudflare Worker acts as an edge proxy. The Worker receives the call, extracts any tracing headers (such as those for distributed tracing or observability), and immediately begins streaming the response from the upstream LLM provider back to the user. This streaming approach supports low-latency, token-by-token delivery as responses are generated.

**Supported Providers**: OpenAI, Anthropic, Google Gemini, OpenRouter, and Groq.

While streaming the response, the Worker accumulates the necessary observability metadata, such as timing, request/response bodies, and trace context. Once the response is fully streamed, the Worker asynchronously sends this metadata and trace data to a Cloudflare Queue. This ensures that the user-facing proxy remains fast and that any downstream processing does not block the user experience.

The Cloudflare Queue acts as a buffer and decouples the ingestion workload from the rest of the pipeline. The Proxy Consumer processes messages from the queue, handling retries and error cases as needed. This worker is responsible for writing the finalized trace, request, and response metadata into ClickHouse for long-term storage and analytics.

Agent Conversation Analytics uses a separate Collector path. The local collector in the CLI or desktop
app parses supported agent transcripts into typed facts, authenticates with a hidden Collector
Credential, and posts to the Agent Ingest Worker. Agent Ingest validates the credential, checks
collector compatibility, rate-limits by organization, re-redacts free-text fields, claims session
ownership in Convex, and chunks facts onto the agent queue. Agent Consumer drains that queue, prices
message facts from the shared model-pricing KV catalog, dedupes through the `AGENT_FACT_BATCHER`
Durable Object ledger, and writes the `agent_*` Tinybird datasources used by `/app/agents`.

Agent analytics is still not production-ready until the production gates in
[docs/guides/agent-conversation-analytics](./docs/guides/agent-conversation-analytics/README.md)
are complete.

### Key Features

- **Low-latency user experience** - Streaming responses are delivered immediately without blocking on observability data processing
- **High throughput** - Queue-based architecture handles traffic spikes and scales automatically
- **Reliable delivery** - Built-in retry logic and error handling ensure no data loss
- **Distributed tracing support** - Captures and propagates trace context for end-to-end observability
- **Async body storage** - Request/response bodies are stored in R2 asynchronously to minimize latency

### Additional Components

The platform includes several production-oriented capabilities:

- **Error handling and retry logic** - Queue consumer implements robust error handling with automatic retries
- **Authentication** - Secure key management and authenticated gateway features protect your LLM endpoints
- **Monitoring** - Built-in observability for Workers and Queues ensures production reliability
- **Data retention and privacy** - Configurable policies for observability data lifecycle management

## Structure

```
trace-flow/
├── packages/
│   ├── types/               # Shared TypeScript types
│   ├── utils/               # Shared utilities
│   └── collector-*          # Shared Rust collector crates
└── apps/
    ├── proxy/               # LLM proxy worker
    ├── proxy-consumer/      # Queue consumer worker
    ├── agent-ingest/        # Agent collector ingest worker
    ├── agent-consumer/      # Agent fact queue consumer worker
    ├── api/                 # Raw API worker for R2 Body Object access
    ├── pipes-api/           # Pipes API worker for Tinybird Pipe forwarding
    ├── mcp/                 # MCP worker for agent access to trace data
    ├── web/                 # Next.js dashboard (Cloudflare Workers via OpenNext)
    ├── cli/                 # Collector CLI
    └── desktop/             # Tauri desktop collector
```

## Setup

Install dependencies:

```bash
bun install
```

Initialize husky:

```bash
bun run prepare
```

## Using the Proxy

The Trace Flow proxy uses route-based paths to forward requests to LLM providers. Simply point your SDK to the gateway URL with the appropriate provider path.

**Gateway**: `https://gateway.trace-flow.dev`

| Provider   | Gateway Path       | Proxies To                            |
| ---------- | ------------------ | ------------------------------------- |
| OpenAI     | `/openai/v1/*`     | `api.openai.com/v1/*`                 |
| Anthropic  | `/anthropic/v1/*`  | `api.anthropic.com/v1/*`              |
| Google     | `/google/v1beta/*` | `generativelanguage.googleapis.com/*` |
| OpenRouter | `/openrouter/v1/*` | `openrouter.ai/api/v1/*`              |
| Groq       | `/groq/v1/*`       | `api.groq.com/openai/v1/*`            |

### Quick Start

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

const { text } = await generateText({
  model: openai('gpt-5'),
  prompt: 'Hello, world!',
});
```

The proxy automatically captures request/response bodies, token usage, performance metrics, errors, and streaming events.

**For complete integration guide, see [agents.md](./apps/web/public/agents.md).**

Related design notes:

- [Agent Conversation Analytics](./docs/adr/0012-agent-conversation-analytics.md) - data model and ingestion design for local AI agent conversation analytics in Trace Flow.
- [Otto Extraction Reference](./docs/adr/0017-otto-extraction-reference.md) - source files and modules to consult when extracting Collector code from Otto.

## Development

### Agent-Ready Local Environment

The reusable local environment contract lives in `scripts/dev/` and is shared by humans, Cursor
background agents, and other coding agents:

```bash
scripts/dev/install.sh
scripts/dev/start.sh
scripts/dev/smoke.sh
scripts/dev/verify.sh
```

`scripts/dev/start.sh` starts Tinybird Local, builds the Tinybird project against it, and generates
ignored local `.dev.vars` / `.env.local` files when they do not already exist. Cursor delegates to the
same scripts through `.cursor/environment.json`.

No cloud Tinybird token is required for local setup. Tinybird Local still requires a bearer token for
its HTTP API, but `scripts/dev/start.sh` discovers or generates that local token automatically.

`scripts/dev/smoke.sh` seeds a local API key, posts an OTLP trace through the local Worker stack, and
queries Tinybird for the captured trace. It will start `scripts/dev/workers.sh` for the run when the
Worker server is not already listening on port 8787. Agent-ingest production verification uses the
separate smoke harness in
[docs/guides/agent-conversation-analytics/runbook.md](./docs/guides/agent-conversation-analytics/runbook.md).

See [docs/agents/local-environment.md](./docs/agents/local-environment.md) for the full contract.

### Full Local Stack (Recommended)

Run the six non-Web Workers together with shared local R2, queues, KV, and Durable Objects:

```bash
# Terminal 1: Proxy, Proxy Consumer, API, Agent Ingest, Agent Consumer
bun run dev:all

# Terminal 2: Convex backend (watch mode)
bunx convex dev

# Terminal 3: Web UI
cd apps/web && bun run dev
```

### Running Workers Together

To test Worker-to-Worker bindings locally without the helper script:

```bash
wrangler dev \
  -c apps/proxy/wrangler.toml \
  -c apps/proxy-consumer/wrangler.toml \
  -c apps/api/wrangler.toml \
  -c apps/pipes-api/wrangler.toml \
  -c apps/agent-ingest/wrangler.jsonc \
  -c apps/agent-consumer/wrangler.jsonc \
  --persist-to .wrangler/state
```

This runs the proxy and agent ingestion paths in one process so local queues and storage bindings are
shared.

### Running Web Worker

The web worker uses Next.js and requires Convex backend:

```bash
# Terminal 1: Start Convex backend
bunx convex dev

# Terminal 2: Start web UI
cd apps/web && bun run dev
```

On first run, Convex will prompt you to login and create a project.

Create `apps/web/.env.local`:

```bash
NEXT_PUBLIC_CONVEX_URL=https://your-deployment-url.convex.cloud
NEXT_PUBLIC_API_URL=http://localhost:8788
NEXT_PUBLIC_PIPES_API_URL=http://localhost:8788
NEXT_PUBLIC_RAW_API_URL=http://localhost:8788
NEXT_PUBLIC_AUTH0_DOMAIN=your-auth0-domain
NEXT_PUBLIC_AUTH0_CLIENT_ID=your-auth0-client-id
```

### Running Workers Individually

You can also run workers separately:

```bash
# Proxy only
cd apps/proxy && bun run dev

# Proxy Consumer only
cd apps/proxy-consumer && bun run dev

# Raw API only
cd apps/api && bun run dev

# Pipes API only
cd apps/pipes-api && bun run dev

# Agent Ingest only
cd apps/agent-ingest && bun run dev

# Agent Consumer only
cd apps/agent-consumer && bun run dev

# Web only (still requires Convex)
cd apps/web && bun run dev
```

## Building

Build all workers:

```bash
bun run build
```

## Deployment

### Production (Automated)

Production deployments are automated via GitHub Actions. When code is merged to `main`, the workflow:

1. Runs CI checks (format, lint, type-check, test, build)
2. Deploys Convex and exports `.convex.cloud` / `.convex.site` URLs for dependent Workers
3. Deploys the Tinybird schema before the proxy and agent consumers
4. Deploys Cloudflare Workers with dependency ordering: proxy, proxy-consumer, API, MCP, Web, Agent Ingest, Agent Consumer, and Analyst Sandbox

See `.github/workflows/deploy.yml` for the full workflow.

### Environments

The project has two environments:

- **Development** - Default environment for local testing and `deploy:dev`
- **Production** - Deployed automatically on merge to `main`

### Development Deployment

```bash
# Deploy all workers to development
bun run deploy:dev

# Deploy individual workers to dev
cd apps/proxy && bun run deploy:dev
```

## Configuration

### Cloudflare Resources

Before deploying, you need to create Cloudflare resources.

**See [SETUP.md](./SETUP.md) for detailed setup instructions.**

Quick overview:

1. **Queues** - `trace-flow-requests-*` for LLM traces and `agent-ingest-*` for agent facts, each with DLQs
2. **R2 Bucket** - `trace-flow-storage-*` for encrypted request/response bodies
3. **KV Namespaces** - API keys, model pricing, and Collector Credential lookup
4. **Durable Objects** - usage tracking, trace batching, and agent fact dedupe
5. **Tinybird** - trace and agent datasources, materializations, pipes, and JWT-scoped reads

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Package Manager**: Bun
- **Monorepo**: Turborepo
- **Frontend**: Next.js (Cloudflare Workers via OpenNext)
- **Backend**: Convex
- **Analytics**: Tinybird (ClickHouse)
- **Storage**: Cloudflare R2
- **Language**: TypeScript
- **Linting**: ESLint + Prettier
- **Git Hooks**: Husky + lint-staged
