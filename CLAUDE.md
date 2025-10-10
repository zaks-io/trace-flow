# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LLM observability platform built on Cloudflare Workers. Three workers form an async pipeline: a streaming proxy captures LLM requests/responses and enqueues them, a consumer processes the queue and sends OpenTelemetry traces to ClickStack, and a web dashboard displays analytics.

## Architecture

**Data Flow:**

1. Proxy worker receives LLM request with `X-Proxy-Target` header
2. Streams response back to client immediately (low latency)
3. Captures request/response bodies during streaming using tee() and TransformStream
4. Stores bodies in R2 asynchronously (via `c.executionCtx.waitUntil`)
5. Sends metadata to Cloudflare Queue with R2 keys
6. Consumer worker processes queue batches and sends OpenTelemetry traces to ClickStack

**Key Implementation Details:**

- Uses `ReadableStream.tee()` to duplicate request body for both proxying and capture
- Uses `TransformStream` to capture response chunks while streaming to client
- All storage/queue operations happen in `c.executionCtx.waitUntil()` to avoid blocking response
- Queue consumer handles retry logic and error cases
- Shared types in `packages/shared` define the contract between workers

## Development Commands

**Using wrangler CLI (preferred for Cloudflare Workers):**

```bash
# Run all workers in parallel
bun run dev

# Run specific worker
cd workers/proxy && wrangler dev
cd workers/proxy-consumer && wrangler dev
cd workers/web && wrangler dev

# Build all workers
bun run build

# Deploy specific worker
cd workers/proxy && wrangler deploy
cd workers/proxy-consumer && wrangler deploy

# Type check all workers
bun run type-check

# Lint all workers
bun run lint

# Format all files
bun run format
```

**Testing proxy locally:**

```bash
# Start proxy in dev mode
cd workers/proxy && wrangler dev

# Send test request with X-Proxy-Target header
curl -X POST http://localhost:8787 \
  -H "X-Proxy-Target: https://api.openai.com/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"test"}]}'
```

## Monorepo Structure

- **Turborepo** manages builds with dependency graph
- **Bun workspaces** link packages
- Each worker has its own `wrangler.toml` and `package.json`
- Shared package (`@observe/shared`) contains types and utils
- Pre-commit hooks run eslint + prettier on staged files

## Wrangler Configuration

**Proxy** (`workers/proxy/wrangler.toml`):

- Queue producer binding: `REQUEST_QUEUE` → `llm-requests` queue
- R2 bucket binding: `STORAGE` → `observe-storage` bucket

**Consumer** (`workers/proxy-consumer/wrangler.toml`):

- Queue consumer config: `llm-requests` queue with max_batch_size=10
- R2 bucket binding: `STORAGE` → `observe-storage` bucket
- Secrets: `CLICKSTACK_OTLP_ENDPOINT`, `CLICKSTACK_API_KEY`, `OTEL_SERVICE_NAME`
- Uses OpenTelemetry to send traces to ClickStack

**Web** (`workers/web/wrangler.toml`):

- Pages project with `dist` output directory

## Managing Secrets

```bash
# Set secrets for proxy-consumer
cd workers/proxy-consumer
wrangler secret put CLICKSTACK_OTLP_ENDPOINT
wrangler secret put CLICKSTACK_API_KEY
wrangler secret put OTEL_SERVICE_NAME  # Optional
```

## Queue Setup

Queues are configured in `workers/proxy-consumer/wrangler.toml`. To set them up:

1. Create queues using wrangler CLI:
   ```bash
   npx wrangler queues create llm-requests
   npx wrangler queues create llm-requests-dlq
   ```
2. Configure ClickStack secrets (see SETUP.md for details)
3. Deploy consumer worker

**See [SETUP.md](./SETUP.md) for complete setup instructions.**

## Deployment

Project uses Cloudflare's Git integration for automatic deployments on push to `main`. Each worker is configured as a separate application in Cloudflare dashboard with its own root directory and build command.

Manual deployment: `cd workers/<name> && wrangler deploy`

## Important Patterns

- **Stream handling**: Always use `tee()` to duplicate streams when you need both proxying and capture
- **Async operations**: Use `c.executionCtx.waitUntil()` in Hono handlers to avoid blocking responses
- **Error handling**: Queue consumer must call `message.ack()` after processing
- **Type safety**: Import shared types from `@observe/shared/types` for queue messages
- **R2 keys**: Use consistent naming: `requests/${requestId}` and `responses/${requestId}`
- **OpenTelemetry**: Consumer worker uses `@microlabs/otel-cf-workers` to send traces to ClickStack
- **NodeJS compatibility**: Consumer worker requires `nodejs_compat` flag for OpenTelemetry
