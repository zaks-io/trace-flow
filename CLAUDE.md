# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LLM observability platform built on Cloudflare Workers. Four workers form the system:

- **Proxy** - Streaming proxy that captures LLM requests/responses and enqueues them
- **Consumer** - Processes queue batches and sends OpenTelemetry traces to Tinybird
- **API** - Provides R2 access for fetching request/response bodies
- **Web** - Static dashboard (Cloudflare Pages) displaying analytics via Tinybird

## DEPLOYMENT SAFETY - READ THIS FIRST

**⚠️ CRITICAL: NEVER DEPLOY TO PRODUCTION ⚠️**

Do NOT run any production deployment commands. Ever. Any deployments requested by the user reference the development environment.

**Development Commands (use these for local dev and testing):**

- Convex watch mode: `pnpm dlx convex dev` (continuous development server)
- Convex deploy to dev: `pnpm dlx convex@latest dev --once` (deploy to dev environment once, not a watch command)
- Cloudflare Workers dev (with queues): `wrangler dev -c workers/proxy/wrangler.toml -c workers/proxy-consumer/wrangler.toml --persist-to .wrangler/state`
- Tinybird dev: `tb dev` (auto-reload, local only)

## Architecture

**Data Flow:**

1. Proxy worker receives LLM request with `X-Proxy-Target` header
2. Streams response back to client immediately (low latency)
3. Captures request/response bodies during streaming using tee() and TransformStream
4. Stores bodies in R2 asynchronously (via `c.executionCtx.waitUntil`)
5. Sends metadata to Cloudflare Queue with R2 keys
6. Consumer worker processes queue batches and sends OpenTelemetry traces to Tinybird
7. Web UI fetches trace metadata from Tinybird and request/response bodies from API worker
8. API worker retrieves bodies from R2 bucket and returns them to the web UI

**Key Implementation Details:**

- Uses `ReadableStream.tee()` to duplicate request body for both proxying and capture
- Uses `TransformStream` to capture response chunks while streaming to client
- All storage/queue operations happen in `c.executionCtx.waitUntil()` to avoid blocking response
- Queue consumer handles retry logic and error cases
- Shared types in `packages/shared` define the contract between workers

## Local Development

**IMPORTANT**: Use globally installed `wrangler` command directly, not `pnpm dlx wrangler` or `npx wrangler`. The global install ensures consistent behavior and avoids potential compatibility issues. Install wrangler globally: `npm install -g wrangler`

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
pnpm dlx convex dev

# Terminal 2: Start web UI
cd workers/web && pnpm run dev
```

On first run, Convex will prompt you to login and create a project. Create `workers/web/.env.local`:

```bash
NEXT_PUBLIC_CONVEX_URL=https://your-deployment-url.convex.cloud
NEXT_PUBLIC_API_URL=http://localhost:8788
NEXT_PUBLIC_AUTH0_DOMAIN=your-auth0-domain
NEXT_PUBLIC_AUTH0_CLIENT_ID=your-auth0-client-id
```

### Full Local Stack (Recommended)

**Single Command (Recommended):**

```bash
# Terminal 1: All workers with shared R2
pnpm run dev:all

# Terminal 2: API worker (MUST use same persist path)
cd workers/api && wrangler dev --persist-to ../../.wrangler/state

# Terminal 3: Convex backend (watch mode)
pnpm dlx convex dev

# Terminal 4: Web UI
cd workers/web && pnpm run dev
```

The `dev:all` script runs proxy, consumer, and API workers together with shared R2 storage, solving storage isolation issues.

**Multi-Terminal Setup (For Debugging):**

If you need to run workers separately for debugging:

```bash
# Terminal 1: Proxy + Consumer workers
wrangler dev -c workers/proxy/wrangler.toml -c workers/proxy-consumer/wrangler.toml --persist-to .wrangler/state

# Terminal 2: API worker (MUST use same persist path)
cd workers/api && wrangler dev --persist-to ../../.wrangler/state

# Terminal 3: Convex backend (watch mode)
pnpm dlx convex dev

# Terminal 4: Web UI
cd workers/web && pnpm run dev
```

**IMPORTANT**: When running workers separately, all workers MUST use the same `--persist-to` path or R2 storage will be isolated and bodies won't be accessible.

### Running Workers Individually

If you need to run workers separately:

```bash
# Proxy only
cd workers/proxy && wrangler dev

# Consumer only
cd workers/proxy-consumer && wrangler dev

# API only
cd workers/api && wrangler dev

# Web only (still requires Convex and API worker)
<<<<<<< HEAD
cd workers/web && pnpm run dev
=======
cd workers/web && bun run dev
>>>>>>> origin/main
```

### Other Commands

```bash
# Build all workers
pnpm run build

# Type check all workers
pnpm run type-check

# Lint all workers
pnpm run lint

# Format all files
pnpm run format

# Run tests
pnpm run test

# Run tests in watch mode
pnpm run test:watch
```

## Testing

Project uses Vitest for unit and integration testing. Tests are configured per-package for optimal Turborepo caching.

### Testing Strategy

**Per-Package Configuration (Recommended):**

- Each package maintains its own test suite
- Turborepo parallelizes and caches test execution
- Only tests affected by changes are re-run
- Follows monorepo best practices

### Running Tests

```bash
# Run all tests across monorepo
pnpm run test

# Run tests in watch mode
pnpm run test:watch

# Run tests for specific package
cd packages/utils && pnpm run test

# Run tests with coverage
pnpm run test:coverage
```

### Vitest Configuration

**For Standard Packages (utils, types):**

Use standard Vitest configuration with Node.js environment:

```typescript
// packages/utils/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

**For Cloudflare Workers:**

Use `@cloudflare/vitest-pool-workers` for testing Workers with runtime APIs and bindings:

```bash
# Install Workers testing integration
pnpm add @cloudflare/vitest-pool-workers --dev
```

```typescript
// workers/proxy/vitest.config.ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: {
          configPath: './wrangler.toml',
        },
      },
    },
  },
});
```

**Key Features:**

- Runs tests inside Workers runtime (same as production)
- Provides access to Workers APIs and bindings
- Isolated per-test storage
- Declarative request mocking
- Compatible with Vitest 2.0.x - 3.2.x

### Test Organization

**File Structure:**

```
packages/utils/
├── src/
│   ├── __tests__/
│   │   ├── generateId.test.ts
│   │   ├── getCurrentTimestamp.test.ts
│   │   └── ...
│   └── index.ts
└── vitest.config.ts
```

**Best Practices:**

- Always mock external services (network, database, etc.)

### Adding Tests to New Packages

1. Install Vitest: `pnpm add vitest --cwd packages/your-package --dev`
2. Create `vitest.config.ts` in package root
3. Add test scripts to `package.json`:
   ```json
   {
     "scripts": {
       "test": "vitest run",
       "test:watch": "vitest"
     }
   }
   ```
4. Create `src/__tests__/` directory
5. Write tests following existing patterns

### CI Integration

Tests run automatically in CI pipeline before deployment:

```bash
pnpm run format && pnpm run lint && pnpm run type-check && pnpm run test && pnpm run build
```

### Testing Proxy Locally

```bash
# With proxy + consumer running, send test request
curl -X POST http://localhost:8787 \
  -H "X-Proxy-Target: https://api.openai.com/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"test"}]}'
```

**Testing full pipeline locally (proxy + consumer + Tinybird):**

```bash
# Ensure Tinybird Local is running
tb local start

# Start both workers together (required for queue consumer to process messages)
wrangler dev \
  -c ./workers/proxy/wrangler.toml \
  -c ./workers/proxy-consumer/wrangler.toml \
  --persist-to .wrangler/state

# Send test request
curl -X POST http://localhost:8787 \
  -H "X-Proxy-Target: https://chat.zaks.io/api/health" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"test"}]}'

# Verify traces in Tinybird Local
tb datasource data otel_traces --limit 10
```

**Important:** Queue consumers only work in local development when both producer and consumer workers are started together using multiple `-c` flags in a single `wrangler dev` command. Running them separately will not connect the queue.

## Monorepo Structure

- **Turborepo** manages builds with dependency graph
- **Bun workspaces** link packages
- Each worker has its own `wrangler.toml` and `package.json`
- Shared package (`@observe/shared`) contains types and utils
- Pre-commit hooks run eslint + prettier on staged files

## Environments

Project has three separate environments with isolated resources:

**Development (default):**

- Queues: `observe-requests-dev`, `observe-requests-dlq-dev`
- R2 bucket: `observe-storage-dev`
- KV namespace: `observe-api-keys-dev` (ID: 86d6aaf858e747e4bd9aa0a51216570d)

**Staging:**

- Queues: `observe-requests-staging`, `observe-requests-dlq-staging`
- R2 bucket: `observe-storage-staging`
- KV namespace: `observe-api-keys-staging` (ID: bb7a289d3389426b979a746801d68f3c)

**Production:**

- Queues: `observe-requests-prod`, `observe-requests-dlq-prod`
- R2 bucket: `observe-storage-prod`
- KV namespace: `observe-api-keys-prod` (ID: 6d74d697f808470bbb678eda3c52bef3)

### Environment Differences: Workers vs Pages

**Workers (proxy, proxy-consumer):**

- Support custom environment names: `dev`, `staging`, `production`
- Each environment is a separate Worker instance
- Deploy with `--branch` flag: `wrangler deploy --branch staging`

**Pages (web):**

- Only supports TWO environments: `preview` and `production`
- `deploy:preview` deploys to `preview` environment
- `deploy:prod` deploys to `production` environment
- Use branch names to distinguish deployments (e.g., `--branch preview`)

### Deployment Commands

```bash
# Deploy all workers to a specific environment
pnpm run deploy:dev      # Workers → dev, Pages → preview
pnpm run deploy:staging  # Workers → staging, Pages → preview (staging branch)
pnpm run deploy:prod     # Workers → production, Pages → production (requires explicit approval)

# Deploy individual workers
cd workers/proxy && pnpm run deploy:dev
cd workers/proxy-consumer && pnpm run deploy:staging
cd workers/web && pnpm run deploy:dev  # Deploys to Pages preview environment
```

## Wrangler Configuration

**Proxy** (`workers/proxy/wrangler.toml`):

- Queue producer binding: `REQUEST_QUEUE` → `observe-requests-{env}` queue
- R2 bucket binding: `STORAGE` → `observe-storage-{env}` bucket
- KV namespace binding: `API_KEYS` → `observe-api-keys-{env}` namespace

**Consumer** (`workers/proxy-consumer/wrangler.toml`):

- Queue consumer config: `observe-requests-{env}` queue with max_batch_size=100
- Dead letter queue: `observe-requests-dlq-{env}`
- R2 bucket binding: `STORAGE` → `observe-storage-{env}` bucket
- Secrets: `TINYBIRD_TOKEN`, `TINYBIRD_DATASOURCE`, `TINYBIRD_HOST`

**API** (`workers/api/wrangler.toml`):

- R2 bucket binding: `STORAGE` → `observe-storage-{env}` bucket
- Simple Hono worker with GET `/bodies/:traceId` endpoint
- Returns request/response bodies from R2 for the web UI

**Web** (`workers/web/wrangler.toml`):

- Pages project with static export (no R2 bindings)
- Fetches trace data from Tinybird and bodies from API worker

## Managing Secrets and Environment Variables

**For local development (Tinybird Local):**

Create `workers/proxy-consumer/.dev.vars`:

```bash
TINYBIRD_HOST=http://localhost:7181
TINYBIRD_TOKEN=<token from tb local status>
TINYBIRD_DATASOURCE=otel_traces
```

**For production (Tinybird Cloud):**

Secrets must be set for each environment:

```bash
# Set secrets for dev (default)
cd workers/proxy-consumer
wrangler secret put TINYBIRD_TOKEN
wrangler secret put TINYBIRD_DATASOURCE  # Optional
wrangler secret put TINYBIRD_HOST        # Optional

# Set secrets for staging
wrangler secret put TINYBIRD_TOKEN --env staging
wrangler secret put TINYBIRD_DATASOURCE --env staging
wrangler secret put TINYBIRD_HOST --env staging

# Set secrets for production
wrangler secret put TINYBIRD_TOKEN --env production
wrangler secret put TINYBIRD_DATASOURCE --env production
wrangler secret put TINYBIRD_HOST --env production
```

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

## Creating Pull Requests

Follow this workflow when creating PRs:

### 1. Create Feature Branch from Main

```bash
git checkout main
git pull origin main
git checkout -b feature/your-feature-name
```

**Branch naming conventions:**

- `feature/description` - New features
- `fix/description` - Bug fixes
- `refactor/description` - Code refactoring
- `docs/description` - Documentation updates

### 2. Run All CI Checks Locally

Before committing, run the full CI suite to catch issues early:

```bash
# Install dependencies (if not already installed)
pnpm install

# Run all checks in parallel
pnpm run format  # Auto-fix formatting issues
pnpm run lint    # Lint all workers
pnpm run type-check  # Type check all workers
pnpm run build   # Build all workers
```

**Individual worker checks (if needed):**

```bash
# Proxy worker
pnpm run prettier --check "workers/proxy/**/*.{ts,tsx,js,jsx,json}"
pnpm run turbo run lint --filter=@observe/proxy
pnpm run turbo run type-check --filter=@observe/proxy
pnpm run turbo run build --filter=@observe/proxy

# Proxy consumer worker
pnpm run prettier --check "workers/proxy-consumer/**/*.{ts,tsx,js,jsx,json}"
pnpm run turbo run lint --filter=@observe/proxy-consumer
pnpm run turbo run type-check --filter=@observe/proxy-consumer
pnpm run turbo run build --filter=@observe/proxy-consumer

# Web worker
pnpm run prettier --check "workers/web/**/*.{ts,tsx,js,jsx,json,css}"
pnpm run turbo run lint --filter=@observe/web
pnpm run turbo run type-check --filter=@observe/web
pnpm run turbo run build --filter=@observe/web

# GitHub Actions workflows (if modified)
actionlint .github/workflows/*.yml
```

**Fix common issues:**

```bash
# Auto-fix formatting
pnpm run format

# Auto-fix linting issues
pnpm run lint --fix
```

### 3. Commit Changes

Stage and commit your changes with a descriptive message:

```bash
git add .
git commit -m "$(cat <<'EOF'
Add feature description

Brief explanation of what changed and why.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**Commit message guidelines:**

- First line: Concise summary (50-72 characters)
- Blank line
- Detailed explanation (if needed)
- Always include Claude Code attribution footer

### 4. Push Branch to Remote

```bash
git push -u origin feature/your-feature-name
```

### 5. Create Pull Request with gh CLI

```bash
gh pr create --title "Feature: Your feature description" --body "$(cat <<'EOF'
## Summary
- Brief bullet point of what changed
- Why this change was needed
- Any important implementation details

## Test Plan
- [ ] Local development tested
- [ ] All CI checks passing
- [ ] Manual testing completed

## Related Issues
Closes #123 (if applicable)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### Quick PR Workflow (All Steps Combined)

```bash
# Create branch from main
git checkout main && git pull origin main
git checkout -b feature/your-feature-name

# Make your changes...

# Run all checks
pnpm run format && pnpm run lint && pnpm run type-check && pnpm run build

# Commit and push
git add . && git commit -m "$(cat <<'EOF'
Add feature description

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
git push -u origin feature/your-feature-name

# Create PR
gh pr create --title "Feature: Description" --body "$(cat <<'EOF'
## Summary
- What changed

## Test Plan
- [x] Local testing completed
- [x] CI checks passing

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

## Important Patterns

- **Stream handling**: Always use `tee()` to duplicate streams when you need both proxying and capture
- **Async operations**: Use `c.executionCtx.waitUntil()` in Hono handlers to avoid blocking responses
- **Error handling**: Queue consumer must call `message.ack()` after processing
- **Type safety**: Import shared types from `@observe/shared/types` for queue messages
- **R2 keys**: Use consistent naming: `requests/${requestId}` and `responses/${requestId}`
- **OpenTelemetry**: Consumer worker uses `@microlabs/otel-cf-workers` to send traces to ClickStack
- **NodeJS compatibility**: Consumer worker requires `nodejs_compat` flag for OpenTelemetry

## Documentation with JSDoc

Code should be self-documenting through clear naming, types, and structure. Use JSDoc comments only to capture information that cannot be expressed in code itself.

### When to Use JSDoc

Add JSDoc when documenting:

- **Architecture decisions**: Why this approach was chosen over alternatives
- **Non-obvious patterns**: Cloudflare Workers-specific behaviors, stream handling edge cases
- **Performance considerations**: Why specific implementation choices affect performance
- **Integration context**: How components interact across workers, queue semantics
- **Gotchas and constraints**: Runtime limitations, API quirks, ordering requirements

### When NOT to Use JSDoc

Avoid JSDoc for:

- **Obvious function signatures**: Types already express parameter and return types
- **Implementation details**: Code should be self-explanatory through good naming
- **Restating the code**: Don't describe what the code does, explain why it exists
- **Temporary notes**: Use TODO comments for temporary notes, not JSDoc

### Examples

**Good - Explains architectural context:**

```typescript
/**
 * Uses tee() to duplicate the request stream because Cloudflare Workers
 * streams can only be read once. We need one stream for proxying to the
 * target and another for capturing the body to R2.
 *
 * IMPORTANT: Both streams must be consumed or the Worker will hang.
 */
const [proxyStream, captureStream] = request.body.tee();
```

**Good - Explains non-obvious pattern:**

```typescript
/**
 * Must use waitUntil() to defer R2 storage and queue operations.
 * Without this, the Worker terminates before async operations complete,
 * causing data loss. The response is returned immediately to maintain
 * low latency for the client.
 */
c.executionCtx.waitUntil(storeAndEnqueue(request, response));
```

**Bad - Restates the obvious:**

```typescript
/**
 * Generates a unique ID
 * @returns A unique string ID
 */
function generateId(): string {
  return crypto.randomUUID();
}
```

**Bad - Implementation detail already clear:**

```typescript
/**
 * Loops through messages and processes them
 */
for (const message of batch.messages) {
  await processMessage(message);
}
```

### JSDoc Style Guidelines

- Keep comments concise and focused on the "why"
- Use inline comments for single-line explanations
- Use JSDoc blocks for functions/classes requiring architectural context
- Update comments when code changes (stale comments are worse than no comments)
