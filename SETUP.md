# Setup Instructions

## 1. Create Tinybird Datasource

Create the `otel_traces` datasource in Tinybird:

```bash
# Deploy Tinybird resources (datasources, pipes, etc.)
tb push

# Or manually create datasource from schema
tb datasource create --file datasources/otel_traces.datasource
```

This will create the necessary table in your Tinybird workspace (managed ClickHouse).

## 2. Create Cloudflare Queues

Run these commands to create the required queues for all environments:

```bash
# Development
wrangler queues create trace-flow-requests-dev
wrangler queues create trace-flow-requests-dlq-dev

# Staging
wrangler queues create trace-flow-requests-staging
wrangler queues create trace-flow-requests-dlq-staging

# Production
wrangler queues create trace-flow-requests-prod
wrangler queues create trace-flow-requests-dlq-prod
```

## 3. Configure Tinybird Secrets

Set the following secrets for the proxy-consumer worker for each environment:

```bash
cd workers/proxy-consumer

# Development environment
wrangler secret put TINYBIRD_TOKEN
wrangler secret put TINYBIRD_DATASOURCE  # Optional, defaults to "otel_traces"
wrangler secret put TINYBIRD_HOST        # Optional, defaults to "https://api.tinybird.co"

# Staging environment
wrangler secret put TINYBIRD_TOKEN --env staging
wrangler secret put TINYBIRD_DATASOURCE --env staging
wrangler secret put TINYBIRD_HOST --env staging

# Production environment
wrangler secret put TINYBIRD_TOKEN --env production
wrangler secret put TINYBIRD_DATASOURCE --env production
wrangler secret put TINYBIRD_HOST --env production
```

Get your Tinybird token with `DATASOURCE:APPEND` scope:

```bash
tb token create --name trace-flow-dev --scopes DATASOURCES:APPEND
```

## 4. Deploy the Workers

After creating the queues and setting the secrets, deploy the workers to your chosen environment:

```bash
# Deploy all workers to development (from project root)
pnpm run deploy:dev

# Or deploy individual workers
cd workers/proxy && pnpm run deploy:dev
cd workers/proxy-consumer && pnpm run deploy:dev
cd workers/web && pnpm run deploy:dev

# For staging
pnpm run deploy:staging

# For production (requires explicit approval)
pnpm run deploy:prod
```

## 5. Configure Custom Domains (Production)

Custom domains are configured in `wrangler.toml` and connected through the Cloudflare Dashboard:

**Production domains:**

- `api.trace-flow.dev` → API worker
- `gateway.trace-flow.dev` → Proxy worker
- `trace-flow.dev` → Web worker (Cloudflare Pages)

**To connect domains:**

1. **Routes are already configured** in `wrangler.toml` for production environments

2. **Connect domains via Cloudflare Dashboard:**
   - Navigate to **Workers & Pages** → Select your worker (e.g., `trace-flow-api-production`)
   - Go to **Settings** → **Domains**
   - Click **Add Custom Domain**
   - Enter the subdomain (e.g., `api.trace-flow.dev`)
   - Cloudflare will automatically create DNS records if the domain is in the same account

3. **Verify DNS records** (auto-created):
   - `api.trace-flow.dev` → CNAME to worker route
   - `gateway.trace-flow.dev` → CNAME to worker route

**Note:** After adding routes to `wrangler.toml`, redeploy the worker for the routes to take effect:

```bash
cd workers/api && wrangler deploy --env production
cd workers/proxy && wrangler deploy --env production
```

## Testing Locally

To test locally, you'll need to set up environment variables. Create a `.dev.vars` file in `workers/proxy-consumer/`:

```
TINYBIRD_TOKEN=your-dev-token-here
TINYBIRD_DATASOURCE=otel_traces
TINYBIRD_HOST=https://api.tinybird.co
```

Then run the workers in development mode:

```bash
# From the root of the project (runs proxy + consumer together)
wrangler dev -c workers/proxy/wrangler.toml -c workers/proxy-consumer/wrangler.toml --persist-to .wrangler/state
```

## Verifying the Setup

1. Send a test request to your proxy worker with the `X-Proxy-Target` header:

```bash
curl -X POST https://your-proxy.workers.dev \
  -H "X-Proxy-Target: https://api.openai.com/v1/chat/completions" \
  -H "Authorization: Bearer YOUR_OPENAI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hello!"}]}'
```

2. Check that the request is queued successfully in proxy logs
3. Verify that the proxy-consumer processes the message in consumer logs
4. Query Tinybird to see the traces:

```sql
SELECT
    Timestamp,
    TraceId,
    SpanName,
    Duration / 1000000 as DurationMs,
    SpanAttributes
FROM otel_traces
ORDER BY Timestamp DESC
LIMIT 10
FORMAT JSON
```

Or use the Tinybird CLI:

```bash
tb sql "SELECT * FROM otel_traces ORDER BY Timestamp DESC LIMIT 10 FORMAT JSON"
```

## Architecture

The system works as follows:

1. **Proxy Worker** receives LLM requests and streams responses back to clients
2. Request/response bodies are stored in R2 asynchronously
3. Metadata is sent to Cloudflare Queue (`trace-flow-requests-{env}`)
4. **Proxy Consumer Worker** processes queue messages
5. Consumer builds OpenTelemetry-compatible trace spans
6. Traces are inserted into Tinybird (managed ClickHouse) via HTTP interface
7. Query traces in Tinybird or visualize with Grafana

## OpenTelemetry Traces Schema

Each queue message creates multiple spans in ClickHouse:

- **`ai.request`** - Root span for the entire LLM request
  - `ai.request_id` - Unique request identifier
  - `ai.provider` - LLM provider (openai, anthropic, etc.)
  - `ai.model` - Model name
  - `ai.target_url` - Original target URL
  - `http.status_code` - HTTP response status
  - `ai.tokens.prompt` - Prompt token count
  - `ai.tokens.completion` - Completion token count
  - `ai.tokens.total` - Total token count
  - `ai.cached` - Whether response was cached

- **`ai.request.ttft`** - Time to first token (if streaming)
  - `ai.time_to_first_token_ms` - TTFT in milliseconds

- **`ai.assistant.*`** - Content block spans (text, thinking, tool_use)

All spans use the same `TraceId` for correlation and form a parent-child relationship.

## Querying Traces

### Get recent requests by provider

```sql
SELECT
    Timestamp,
    SpanAttributes['ai.provider'] as Provider,
    SpanAttributes['ai.model'] as Model,
    Duration / 1000000 as DurationMs,
    SpanAttributes['ai.tokens.total'] as TotalTokens
FROM otel_traces
WHERE SpanName = 'ai.request'
ORDER BY Timestamp DESC
LIMIT 10;
```

### Calculate average latency by provider

```sql
SELECT
    SpanAttributes['ai.provider'] as Provider,
    avg(Duration / 1000000) as AvgLatencyMs,
    count() as RequestCount
FROM otel_traces
WHERE SpanName = 'ai.request'
  AND Timestamp > now() - INTERVAL 1 HOUR
GROUP BY Provider;
```

### Find slow requests

```sql
SELECT
    Timestamp,
    TraceId,
    SpanAttributes['ai.provider'] as Provider,
    SpanAttributes['ai.model'] as Model,
    Duration / 1000000 as DurationMs
FROM otel_traces
WHERE SpanName = 'ai.request'
  AND Duration > 5000000000
ORDER BY Duration DESC
LIMIT 10;
```

## Visualization with Grafana

You can connect Grafana to your ClickHouse Cloud instance to build dashboards:

1. Install the ClickHouse data source plugin in Grafana
2. Configure connection to your ClickHouse Cloud instance
3. Create dashboards querying the `otel_traces` table
4. Visualize metrics like request latency, token usage, error rates, etc.
