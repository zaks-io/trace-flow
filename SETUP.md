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
cd apps/proxy-consumer

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

## 4. Configure Analytics Engine Read Access

The admin Analytics Engine explorer reads directly from Cloudflare's Analytics Engine SQL API through Convex actions in `packages/convex/adminAnalytics.ts`.

Set these environment variables for the Convex deployment that powers the web app:

```bash
# Required for Cloudflare API access
npx convex env set CLOUDFLARE_ACCOUNT_ID your-cloudflare-account-id

# Preferred: dedicated token with Account | Account Analytics | Read
npx convex env set CLOUDFLARE_ANALYTICS_API_TOKEN your-analytics-read-token

# Optional fallback if the shared token already includes analytics read access
npx convex env set CLOUDFLARE_API_TOKEN your-cloudflare-api-token

# Analytics Engine dataset to query
npx convex env set CLOUDFLARE_ANALYTICS_DATASET trace-flow-proxy-dev
```

Recommended token scope:

- `Account | Account Analytics | Read`

Current Analytics Engine dataset limits:

- The dataset is written only by the proxy worker.
- It stores operational aggregates, not trace IDs or request bodies.
- Preview and dev currently share `trace-flow-proxy-dev`, so the explorer cannot separate them unless the write-side dataset strategy changes.

## 5. Deploy the Workers

After creating the queues and setting the secrets, deploy the workers to your chosen environment:

```bash
# Deploy all workers to development (from project root)
bun run deploy:dev

# Or deploy individual workers
cd apps/proxy && bun run deploy:dev
cd apps/proxy-consumer && bun run deploy:dev
cd apps/web && bun run deploy:dev

# For staging
bun run deploy:staging

# For production (requires explicit approval)
bun run deploy:prod
```

### Web worker: `APP_BASE_URL`

Set `APP_BASE_URL` on the OpenNext web worker to the canonical public origin (for example `https://trace-flow.dev`). The app uses it for Auth0, token minting, and the `/api/token` CSRF origin check.

## 6. Configure Custom Domains (Production)

Custom domains are configured in `wrangler.toml` and connected through the Cloudflare Dashboard:

**Production domains:**

- `api.trace-flow.dev` → API worker
- `gateway.trace-flow.dev` → Proxy worker
- `trace-flow.dev` → Web worker (Cloudflare Workers via OpenNext)

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
cd apps/api && wrangler deploy --env production
cd apps/proxy && wrangler deploy --env production
```

## 7. Testing Locally

To test locally, you'll need to set up environment variables. Create a `.dev.vars` file in `apps/proxy-consumer/`:

```
TINYBIRD_TOKEN=your-dev-token-here
TINYBIRD_DATASOURCE=otel_traces
TINYBIRD_HOST=https://api.tinybird.co
```

Then run the workers in development mode:

```bash
# From the root of the project (runs proxy + consumer together)
wrangler dev -c apps/proxy/wrangler.toml -c apps/proxy-consumer/wrangler.toml --persist-to .wrangler/state
```

## 8. Verifying the Setup

1. Send a test request to your proxy worker using route-based paths:

```bash
curl -X POST https://your-proxy.workers.dev/openai/v1/chat/completions \
  -H "X-Trace-Flow-Api-Key: YOUR_TRACE_FLOW_API_KEY" \
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

## 9. Architecture

The system works as follows:

1. **Proxy Worker** receives LLM requests and streams responses back to clients
2. Request/response bodies are stored in R2 asynchronously
3. Metadata is sent to Cloudflare Queue (`trace-flow-requests-{env}`)
4. **Proxy Consumer Worker** processes queue messages
5. Consumer builds OpenTelemetry-compatible trace spans
6. Traces are inserted into Tinybird (managed ClickHouse) via HTTP interface
7. Query traces in Tinybird or visualize with Grafana

## 10. OpenTelemetry Traces Schema

Each queue message creates spans following [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/):

- **Root LLM Request Span** - Main span with `gen_ai.operation.name` attribute
  - `gen_ai.request_id` - Unique request identifier
  - `gen_ai.system` - LLM provider (openai, anthropic, etc.)
  - `gen_ai.request.model` - Model name
  - `gen_ai.operation.name` - Operation type (chat, text_completion, etc.)
  - `http.url` - Original target URL
  - `http.response.status_code` - HTTP response status
  - `gen_ai.usage.input_tokens` - Input/prompt token count
  - `gen_ai.usage.output_tokens` - Output/completion token count
  - `gen_ai.server.time_to_first_token` - TTFT in milliseconds (if streaming)
  - `gen_ai.cost.total` - Total cost in USD
  - `trace_flow.source` - Set to "proxy" for proxy-originated spans

- **`gen_ai.response.*`** - Content block spans (text, thinking, tool_use)
  - `gen_ai.content.type` - Content type (text, thinking, tool_use)
  - `gen_ai.message.index` - Content block index

All spans use the same `TraceId` for correlation and form a parent-child relationship.

## 11. Querying Traces

### Get recent requests by provider

```sql
SELECT
    Timestamp,
    SpanAttributes['gen_ai.system'] as Provider,
    SpanAttributes['gen_ai.request.model'] as Model,
    Duration / 1000000 as DurationMs,
    CAST(SpanAttributes['gen_ai.usage.input_tokens'] as Int64) +
    CAST(SpanAttributes['gen_ai.usage.output_tokens'] as Int64) as TotalTokens
FROM otel_traces
WHERE JSONHas(SpanAttributes, 'gen_ai.operation.name')
ORDER BY Timestamp DESC
LIMIT 10;
```

### Calculate average latency by provider

```sql
SELECT
    SpanAttributes['gen_ai.system'] as Provider,
    avg(Duration / 1000000) as AvgLatencyMs,
    count() as RequestCount
FROM otel_traces
WHERE JSONHas(SpanAttributes, 'gen_ai.operation.name')
  AND Timestamp > now() - INTERVAL 1 HOUR
GROUP BY Provider;
```

### Find slow requests

```sql
SELECT
    Timestamp,
    TraceId,
    SpanAttributes['gen_ai.system'] as Provider,
    SpanAttributes['gen_ai.request.model'] as Model,
    Duration / 1000000 as DurationMs
FROM otel_traces
WHERE JSONHas(SpanAttributes, 'gen_ai.operation.name')
  AND Duration > 5000000000
ORDER BY Duration DESC
LIMIT 10;
```

## 12. Analytics Engine Explorer Notes

The admin explorer at `/app/admin/analytics` queries the proxy Analytics Engine dataset with Cloudflare SQL.

The current proxy schema in `apps/proxy/src/index.ts` maps fields as:

- `index1`: org ID
- `blob1..6`: provider, status code, operation, skip reason, SSE flag, model
- `double1..9`: total latency, prep latency, TTFB, server error flag, total tokens, prompt tokens, completion tokens, cache-read tokens, response size

Aggregate queries must account for sampling:

- Use `SUM(_sample_interval)` for counts
- Use weighted sums and averages for numeric fields
- Use `quantileExactWeighted(..., _sample_interval)` for percentiles

## 13. Visualization with Grafana

You can connect Grafana to your ClickHouse Cloud instance to build dashboards:

1. Install the ClickHouse data source plugin in Grafana
2. Configure connection to your ClickHouse Cloud instance
3. Create dashboards querying the `otel_traces` table
4. Visualize metrics like request latency, token usage, error rates, etc.
