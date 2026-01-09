# Trace Flow

LLM request proxy and analytics platform built on Cloudflare Workers.

## Architecture

This monorepo contains four Cloudflare Workers:

- **Proxy** (`workers/proxy`) - LLM request proxy that logs requests and enqueues them for processing
- **Proxy Consumer** (`workers/proxy-consumer`) - Queue consumer that writes traces to Tinybird and stores bodies in R2
- **API** (`workers/api`) - Provides R2 access for fetching request/response bodies
- **Web** (`workers/web`) - Next.js analytics dashboard (Cloudflare Pages)

### How It Works

When a client sends a request to your LLM API endpoint, the Cloudflare Worker acts as an edge proxy. The Worker receives the call, extracts any tracing headers (such as those for distributed tracing or observability), and immediately begins streaming the response from the upstream LLM provider back to the user. This streaming approach supports low-latency, token-by-token delivery as responses are generated.

**Supported Providers**: OpenAI, Anthropic, Google Gemini, OpenRouter, and Groq.

While streaming the response, the Worker accumulates the necessary observability metadata, such as timing, request/response bodies, and trace context. Once the response is fully streamed, the Worker asynchronously sends this metadata and trace data to a Cloudflare Queue. This ensures that the user-facing proxy remains fast and that any downstream processing does not block the user experience.

The Cloudflare Queue acts as a buffer and decouples the ingestion workload from the rest of the pipeline. A consumer Worker processes messages from the queue, handling retries and error cases as needed. This consumer is responsible for writing the finalized trace, request, and response metadata into ClickHouse for long-term storage and analytics.

### Key Features

- **Low-latency user experience** - Streaming responses are delivered immediately without blocking on observability data processing
- **High throughput** - Queue-based architecture handles traffic spikes and scales automatically
- **Reliable delivery** - Built-in retry logic and error handling ensure no data loss
- **Distributed tracing support** - Captures and propagates trace context for end-to-end observability
- **Async body storage** - Request/response bodies are stored in R2 asynchronously to minimize latency

### Additional Components

The platform includes several production-ready capabilities:

- **Error handling and retry logic** - Queue consumer implements robust error handling with automatic retries
- **Authentication** - Secure key management and authenticated gateway features protect your LLM endpoints
- **Monitoring** - Built-in observability for Workers and Queues ensures production reliability
- **Data retention and privacy** - Configurable policies for observability data lifecycle management

## Structure

```
trace-flow/
├── packages/
│   ├── types/               # Shared TypeScript types
│   └── utils/               # Shared utilities
└── workers/
    ├── proxy/               # LLM proxy worker
    ├── proxy-consumer/      # Queue consumer worker
    ├── api/                 # API worker for R2 body access
    └── web/                 # Next.js dashboard (Cloudflare Pages)
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

**For complete integration guide, see [agents.md](./workers/web/public/agents.md).**

## Development

### Full Local Stack (Recommended)

Run all workers together with shared R2 storage:

```bash
# Terminal 1: All workers with shared R2
bun run dev:all

# Terminal 2: Convex backend (watch mode)
bunx convex dev

# Terminal 3: Web UI
cd workers/web && bun run dev
```

### Running Proxy + Consumer + API Together

To test the complete message flow from proxy → queue → consumer locally:

```bash
wrangler dev -c workers/proxy/wrangler.toml -c workers/proxy-consumer/wrangler.toml -c workers/api/wrangler.toml --persist-to .wrangler/state
```

This runs all workers in a single process with shared local R2 bucket and queue.

### Running Web Worker

The web worker uses Next.js and requires Convex backend:

```bash
# Terminal 1: Start Convex backend
bunx convex dev

# Terminal 2: Start web UI
cd workers/web && bun run dev
```

On first run, Convex will prompt you to login and create a project.

Create `workers/web/.env.local`:

```bash
NEXT_PUBLIC_CONVEX_URL=https://your-deployment-url.convex.cloud
NEXT_PUBLIC_API_URL=http://localhost:8788
NEXT_PUBLIC_AUTH0_DOMAIN=your-auth0-domain
NEXT_PUBLIC_AUTH0_CLIENT_ID=your-auth0-client-id
```

### Running Workers Individually

You can also run workers separately:

```bash
# Proxy only
cd workers/proxy && bun run dev

# Consumer only
cd workers/proxy-consumer && bun run dev

# API only
cd workers/api && bun run dev

# Web only (still requires Convex)
cd workers/web && bun run dev
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
2. Deploys Convex backend
3. Deploys all Cloudflare Workers in parallel (proxy, proxy-consumer, api, web)

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
cd workers/proxy && bun run deploy:dev
```

## Configuration

### Cloudflare Resources

Before deploying, you need to create Cloudflare resources.

**See [SETUP.md](./SETUP.md) for detailed setup instructions.**

Quick overview:

1. **Queues** - `trace-flow-requests-dev`/`trace-flow-requests-prod` and DLQ queues
2. **R2 Bucket** - `trace-flow-storage-dev`/`trace-flow-storage-prod` for storing request/response bodies
3. **KV Namespace** - `trace-flow-api-keys-dev`/`trace-flow-api-keys-prod` for API key validation
4. **Tinybird** - Configure token and datasource for trace storage

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Package Manager**: Bun
- **Monorepo**: Turborepo
- **Frontend**: Next.js (Cloudflare Pages)
- **Backend**: Convex
- **Analytics**: Tinybird (ClickHouse)
- **Storage**: Cloudflare R2
- **Language**: TypeScript
- **Linting**: ESLint + Prettier
- **Git Hooks**: Husky + lint-staged
