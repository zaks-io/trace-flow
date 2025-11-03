# Observe

LLM request proxy and analytics platform built on Cloudflare Workers.

## Architecture

This monorepo contains three Cloudflare Workers:

- **Proxy** (`workers/proxy`) - LLM request proxy that logs requests and enqueues them for processing
- **Proxy Consumer** (`workers/proxy-consumer`) - Queue consumer that writes analytics to ClickHouse and stores bodies in R2
- **Web** (`workers/web`) - React/Vite analytics dashboard

### How It Works

When a client sends a request to your LLM API endpoint, the Cloudflare Worker acts as an edge proxy. The Worker receives the call, extracts any tracing headers (such as those for distributed tracing or observability), and immediately begins streaming the response from the upstream LLM provider back to the user. This streaming approach supports low-latency, token-by-token delivery as responses are generated.

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
observe/
├── packages/
│   └── shared/              # Shared TypeScript types and utilities
└── workers/
    ├── proxy/               # LLM proxy worker
    ├── proxy-consumer/      # Queue consumer worker
    └── web/                 # React dashboard
```

## Setup

Install dependencies:

```bash
pnpm install
```

Initialize husky:

```bash
pnpm run prepare
```

## Using the Proxy

The Observe proxy can be integrated with any LLM client, including the popular [Vercel AI SDK](https://sdk.vercel.ai/).

### Quick Start

**For complete integration guide, see [USAGE.md](./USAGE.md).**

The proxy requires three headers:

- `X-Observe-Api-Key`: Your Observe API key for authentication
- `X-Proxy-Target`: The target LLM provider URL (e.g., `https://api.openai.com/v1/chat/completions`)
- `X-Provider-Api-Key`: Your LLM provider API key (optional, will be injected into provider-specific auth headers)

### Example: Using with Vercel AI SDK

```typescript
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const openaiClient = openai({
  apiKey: process.env.OPENAI_API_KEY,
  // baseURL omitted - SDK uses OpenAI's default URL, custom fetch routes through proxy
  fetch: async (url, options) => {
    return fetch(process.env.PROXY_URL!, {
      method: options?.method || 'POST',
      headers: {
        ...options?.headers,
        'X-Observe-Api-Key': process.env.OBSERVE_API_KEY!,
        'X-Proxy-Target': url, // Original provider URL intercepted here
        'X-Provider-Api-Key': process.env.OPENAI_API_KEY!,
        Authorization: undefined,
      } as HeadersInit,
      body: options?.body,
    });
  },
});

const { text } = await generateText({
  model: openaiClient('gpt-4'),
  prompt: 'Hello, world!',
});
```

The proxy automatically captures:

- Request/response bodies
- Token usage
- Performance metrics (latency, time to first token)
- Errors and status codes
- Streaming events

View all captured data in the Observe dashboard.

## Development

### Running Proxy + Consumer Together (Recommended)

To test the complete message flow from proxy → queue → consumer locally:

```bash
wrangler dev -c workers/proxy/wrangler.toml -c workers/proxy-consumer/wrangler.toml --persist-to .wrangler/state
```

This runs both workers in a single process with shared local R2 bucket and queue.

**Note**: This multi-worker feature is experimental (requires Wrangler v3.1.0+).

### Running Web Worker

The web worker uses Vite and requires Convex backend:

```bash
# Terminal 1: Start Convex backend
npx convex dev

# Terminal 2: Start web UI
cd workers/web && pnpm run dev
```

On first run, Convex will:

1. Log you in with GitHub
2. Create a Convex project
3. Provide a deployment URL

Create `workers/web/.env.local` with your deployment URL:

```bash
VITE_CONVEX_URL=https://your-deployment-url.convex.cloud
```

### Full Local Stack

To run everything together (requires 3 terminals):

```bash
# Terminal 1: Proxy + Consumer workers
wrangler dev -c workers/proxy/wrangler.toml -c workers/proxy-consumer/wrangler.toml --persist-to .wrangler/state

# Terminal 2: Convex backend
npx convex dev

# Terminal 3: Web UI
cd workers/web && pnpm run dev
```

### Running Workers Individually

You can also run workers separately:

```bash
# Proxy only
cd workers/proxy && pnpm run dev

# Consumer only
cd workers/proxy-consumer && pnpm run dev

# Web only (still requires Convex)
cd workers/web && pnpm run dev
```

## Building

Build all workers:

```bash
pnpm run build
```

## Deployment

This project uses Cloudflare's native Git integration for automatic deployments on push to `main`.

### Setup Git Integration

1. Push your code to GitHub

2. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages

3. Click **Create application** → **Import a repository**

4. Connect the **Cloudflare Workers & Pages** GitHub App and authorize access to your repository

5. Configure each worker with the following build settings:

   **Proxy Worker:**
   - Name: `observe-proxy`
   - Root directory: `workers/proxy`
   - Build command: `pnpm run build`
   - Branch: `main`

   **Proxy Consumer Worker:**
   - Name: `observe-proxy-consumer`
   - Root directory: `workers/proxy-consumer`
   - Build command: `pnpm run build`
   - Branch: `main`

   **Web App:**
   - Name: `observe-web`
   - Root directory: `workers/web`
   - Build command: `pnpm run build`
   - Branch: `main`

6. Cloudflare will automatically build and deploy on every push to `main`

### Features

- Automatic deployments on push to main
- Preview deployments on pull requests
- Build status comments on PRs
- Preview URLs for testing changes

### Manual Deployment

Deploy a specific worker manually:

```bash
cd workers/proxy
pnpm run deploy
```

## Configuration

### Cloudflare Resources & OpenTelemetry Setup

Before deploying, you need to create Cloudflare Queues and configure OpenTelemetry for ClickStack.

**See [SETUP.md](./SETUP.md) for detailed setup instructions.**

Quick overview:

1. **Queue** - Create `llm-requests` and `llm-requests-dlq` queues
2. **R2 Bucket** - For storing request/response bodies (already configured in wrangler.toml)
3. **ClickStack Secrets** - Configure OTLP endpoint and API key for observability

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Package Manager**: pnpm
- **Monorepo**: Turborepo
- **Frontend**: React + Vite
- **Database**: Convex
- **Language**: TypeScript
- **Linting**: ESLint + Prettier
- **Git Hooks**: Husky + lint-staged
