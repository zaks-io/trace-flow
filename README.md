# Observe

LLM request proxy and analytics platform built on Cloudflare Workers.

## Architecture

This monorepo contains three Cloudflare Workers:

- **Proxy** (`workers/proxy`) - LLM request proxy that logs requests and enqueues them for processing
- **Proxy Consumer** (`workers/proxy-consumer`) - Queue consumer that writes analytics to ClickHouse and stores bodies in R2
- **Web** (`workers/web`) - React/Vite analytics dashboard

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
