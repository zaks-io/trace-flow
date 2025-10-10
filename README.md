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
bun install
```

Initialize husky:

```bash
bun run prepare
```

## Development

Run all workers in development mode:

```bash
bun run dev
```

Run a specific worker:

```bash
cd workers/proxy
bun run dev
```

## Building

Build all workers:

```bash
bun run build
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
   - Build command: `bun run build`
   - Branch: `main`

   **Proxy Consumer Worker:**
   - Name: `observe-proxy-consumer`
   - Root directory: `workers/proxy-consumer`
   - Build command: `bun run build`
   - Branch: `main`

   **Web App:**
   - Name: `observe-web`
   - Root directory: `workers/web`
   - Build command: `bun run build`
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
bun run deploy
```

## Configuration

### Cloudflare Resources

Before deploying, you need to create and configure:

1. **Queue** - For async processing
2. **R2 Bucket** - For storing request/response bodies
3. **KV Namespace** (optional) - For caching

Update the `wrangler.toml` files in each worker with your resource IDs.

### Environment Variables

For the proxy-consumer worker, configure ClickHouse credentials:

```bash
wrangler secret put CLICKHOUSE_HOST
wrangler secret put CLICKHOUSE_USER
wrangler secret put CLICKHOUSE_PASSWORD
```

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Package Manager**: Bun
- **Monorepo**: Turborepo
- **Frontend**: React + Vite
- **Language**: TypeScript
- **Linting**: ESLint + Prettier
- **Git Hooks**: Husky + lint-staged
