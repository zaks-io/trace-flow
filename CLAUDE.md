# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LLM observability platform built on Cloudflare Workers. Three workers form an async pipeline: a streaming proxy captures LLM requests/responses and enqueues them, a consumer processes the queue and sends OpenTelemetry traces to ClickStack, and a web dashboard displays analytics.

## DEPLOYMENT SAFETY - READ THIS FIRST

**⚠️ CRITICAL: NEVER DEPLOY TO PRODUCTION ⚠️**

Do NOT run any production deployment commands. Ever. Any deployments requested by the user reference the development environment.

**Development Commands (use these for local dev and testing):**

- Convex watch mode: `bunx convex dev` (continuous development server)
- Convex deploy to dev: `bunx convex@latest dev --once` (deploy to dev environment once, not a watch command)
- Cloudflare Workers dev (with queues): `wrangler dev -c workers/proxy/wrangler.toml -c workers/proxy-consumer/wrangler.toml --persist-to .wrangler/state`
- Tinybird dev: `tb dev` (auto-reload, local only)

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

## Local Development

**IMPORTANT**: Use globally installed `wrangler` command directly, not `bunx wrangler` or `npx wrangler`. Bun has compatibility issues with wrangler that cause `wrangler dev` to hang. Install wrangler globally: `npm install -g wrangler`

### Running Proxy + Consumer Together (Recommended)

To test the complete message flow from proxy → queue → consumer locally:

```bash
wrangler dev -c workers/proxy/wrangler.toml -c workers/proxy-consumer/wrangler.toml --persist-to .wrangler/state
```

This runs both workers in a single process with shared local R2 bucket and queue. The `--persist-to` flag ensures state is shared between workers.

**Note**: This multi-worker feature is experimental (requires Wrangler v3.1.0+).

### Running Web Worker

The web worker uses Vite for development and requires Convex backend:

```bash
# Terminal 1: Start Convex backend (watch mode)
bunx convex dev

# Terminal 2: Start web UI
cd workers/web && bun run dev
```

On first run, Convex will prompt you to login and create a project. Create `workers/web/.env.local`:

```bash
VITE_CONVEX_URL=https://your-deployment-url.convex.cloud
```

### Full Local Stack

To run everything together (requires 3 terminals):

```bash
# Terminal 1: Proxy + Consumer workers
wrangler dev -c workers/proxy/wrangler.toml -c workers/proxy-consumer/wrangler.toml --persist-to .wrangler/state

# Terminal 2: Convex backend (watch mode)
bunx convex dev

# Terminal 3: Web UI
cd workers/web && bun run dev
```

### Running Workers Individually

If you need to run workers separately:

```bash
# Proxy only
cd workers/proxy && wrangler dev

# Consumer only
cd workers/proxy-consumer && wrangler dev

# Web only (still requires Convex)
cd workers/web && bun run dev
```

### Other Commands

```bash
# Build all workers
bun run build

# Type check all workers
bun run type-check

# Lint all workers
bun run lint

# Format all files
bun run format
```

### Testing Proxy Locally

```bash
# With proxy + consumer running, send test request
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
   wrangler queues create llm-requests
   wrangler queues create llm-requests-dlq
   ```
2. Configure ClickStack secrets (see SETUP.md for details)
3. Deploy consumer worker

**See [SETUP.md](./SETUP.md) for complete setup instructions.**

## Tinybird (ClickHouse Database)

Project uses Tinybird as the managed ClickHouse database for trace storage and analytics.

### Authentication

Project uses JWT-based authentication for secure frontend access to Tinybird APIs following their best practices.

**Setup Environment Variables:**

```bash
# Set in Convex deployment
npx convex env set TINYBIRD_ADMIN_TOKEN <your_admin_token>
npx convex env set TINYBIRD_WORKSPACE_ID <your_workspace_id>
npx convex env set TINYBIRD_API_URL https://api.tinybird.co

# Set in workers/web/.env.local (optional, defaults to https://api.tinybird.co)
VITE_TINYBIRD_API_URL=https://api.tinybird.co
```

Get your workspace ID: `tb workspace ls`
Get your admin token: `tb token list` or create new one with `tb token create --name convex-admin --type ADMIN`

**Architecture:**

1. Frontend requests JWT from Convex action (`api.tinybird.generateToken`)
2. Convex signs JWT with admin token (HS256) and returns to frontend
3. Frontend calls Tinybird APIs directly with JWT (no backend proxy)
4. Tokens expire after 10 minutes (default), auto-refresh on 403

**Usage in React:**

```typescript
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';

const { data, loading, error } = useTinybirdQuery({
  sql: 'SELECT * FROM otel_traces WHERE Timestamp > now() - INTERVAL 1 DAY FORMAT JSON',
  scopes: [{ type: 'PIPES:READ', resource: 'otel_traces' }],
  ttl: 600, // optional, defaults to 10 minutes
});
```

**Security Benefits:**

- Short-lived tokens (default 10 min)
- Scope-limited access (only specified pipes/datasources)
- Direct frontend→Tinybird calls (low latency)
- Admin token never exposed to frontend

### Development Workflow

```bash
# Start local development environment (uses Docker)
tb local start

# Develop with auto-reload
tb dev

# Switch between local and cloud
tb workspace ls
```

### Datasource Management

```bash
# Analyze file before creating datasource (prints schema)
tb datasource analyze telemetry.ndjson

# Create datasource interactively
tb datasource create

# Create from file
tb datasource create --file telemetry.ndjson --name llm_traces

# Create from URL
tb datasource create --url https://example.com/data.ndjson --name llm_traces

# Append data to existing datasource
tb datasource append llm_traces --file new_data.ndjson

# Export data
tb datasource export llm_traces --format ndjson --rows 1000

# View data
tb datasource data llm_traces --limit 100

# Delete rows with condition
tb datasource delete llm_traces --sql-condition "timestamp < now() - interval 30 day" --yes
```

### Datasource File Structure

Datasources are defined in `.datasource` files in the `datasources/` directory:

```
SCHEMA >
    `timestamp` DateTime64(3) `json:$.timestamp`,
    `trace_id` String `json:$.traceId`,
    `span_id` String `json:$.spanId`,
    `service` LowCardinality(String) `json:$.service`,
    `model` LowCardinality(String) `json:$.model`,
    `duration_ms` UInt32 `json:$.duration`,
    `status` LowCardinality(String) `json:$.status`

ENGINE "MergeTree"
ENGINE_SORTING_KEY "timestamp, trace_id, span_id"
ENGINE_PARTITION_KEY "toYYYYMM(timestamp)"
ENGINE_TTL "timestamp + INTERVAL 90 DAY"
```

### Schema Design Best Practices

**Column Types:**

- Use `LowCardinality(String)` for enums and short strings with low cardinality (< 10k unique values)
- Use `DateTime64(3)` for millisecond timestamps
- Use smallest types that fit (UInt32 vs UInt64, Decimal(18,2) for money)
- Avoid `Nullable` columns (creates extra UInt8 column, degrades performance)
- Store complex JSON as String and parse with JSONExtract functions at query time

**Sorting Keys:**

- Put highest-cardinality filter columns first
- Order by query access patterns (e.g., `timestamp, trace_id, span_id`)
- Sorting key design can impact query performance 10-100x

**Partition Keys:**

- Use time-based partitions for large tables: `toYYYYMM(timestamp)` or `toYYYYMMDD(timestamp)`
- Keeps partition count manageable (< 1000 partitions)

**TTL (Time To Live):**

- Automatically delete old data: `timestamp + INTERVAL 90 DAY`
- Reduces storage costs and maintains performance

**JSONPath Syntax:**

- Supports nested objects: `json:$.user.id`
- Supports arrays (first level only): `json:$.tags[0]`
- For complex nested arrays, store as String and parse at query time

### Query Optimization Patterns

1. **Filter on sorting key columns first** for best performance
2. **Use PREWHERE** for high-selectivity filters on small columns (not Strings/Arrays)
3. **Run filters before JOINs** - use IN operations to reduce data first
4. **Denormalize over joins** - ClickHouse favors wide tables with pre-aggregated metrics
5. **Save GROUP BY and complex operations for last**

### Schema Migration

**Zero-downtime migrations** using FORWARD_QUERY instruction:

```
# In .datasource file when schema changes
FORWARD_QUERY "
  SELECT
    timestamp,
    old_column as new_column_name,
    'default_value' as newly_added_column
  FROM original_table
"
```

Tinybird automatically transforms data from live schema to new schema during deployment.

### Error Handling

- Every datasource has a **quarantine datasource** that stores rows not matching schema
- Quarantine table name: `<datasource_name>_quarantine`
- Check quarantine after ingestion to catch schema issues
- Ingest never fails due to bad rows

### Working with datasources/

- Store all `.datasource` files in `datasources/` directory
- Version control these files for schema history
- Use `tb build` to validate before deployment
- Use `--allow-destructive-operations` flag when deleting datasources

## Deployment

Project uses Cloudflare's Git integration for automatic deployments on push to `main`. Each worker is configured as a separate application in Cloudflare dashboard with its own root directory and build command.

## Important Patterns

- **Stream handling**: Always use `tee()` to duplicate streams when you need both proxying and capture
- **Async operations**: Use `c.executionCtx.waitUntil()` in Hono handlers to avoid blocking responses
- **Error handling**: Queue consumer must call `message.ack()` after processing
- **Type safety**: Import shared types from `@observe/shared/types` for queue messages
- **R2 keys**: Use consistent naming: `requests/${requestId}` and `responses/${requestId}`
- **OpenTelemetry**: Consumer worker uses `@microlabs/otel-cf-workers` to send traces to ClickStack
- **NodeJS compatibility**: Consumer worker requires `nodejs_compat` flag for OpenTelemetry
