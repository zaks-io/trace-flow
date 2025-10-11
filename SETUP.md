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
wrangler queues create observe-requests-dev
wrangler queues create observe-requests-dlq-dev

# Staging
wrangler queues create observe-requests-staging
wrangler queues create observe-requests-dlq-staging

# Production
wrangler queues create observe-requests-prod
wrangler queues create observe-requests-dlq-prod
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
tb token create --name observe-dev --scopes DATASOURCES:APPEND
```

## 4. Deploy the Workers

After creating the queues and setting the secrets, deploy the workers to your chosen environment:

```bash
# Deploy all workers to development (from project root)
bun run deploy:dev

# Or deploy individual workers
cd workers/proxy && bun run deploy:dev
cd workers/proxy-consumer && bun run deploy:dev
cd workers/web && bun run deploy:dev

# For staging
bun run deploy:staging

# For production (requires explicit approval)
bun run deploy:prod
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
3. Metadata is sent to Cloudflare Queue (`observe-requests-{env}`)
4. **Proxy Consumer Worker** processes queue messages
5. Consumer builds OpenTelemetry-compatible trace spans
6. Traces are inserted into Tinybird (managed ClickHouse) via HTTP interface
7. Query traces in Tinybird or visualize with Grafana

## OpenTelemetry Traces Schema

Each queue message creates multiple spans in ClickHouse:

- **`llm.request`** - Root span for the entire LLM request
  - `llm.request_id` - Unique request identifier
  - `llm.provider` - LLM provider (openai, anthropic, etc.)
  - `llm.model` - Model name
  - `llm.target_url` - Original target URL
  - `http.status_code` - HTTP response status
  - `llm.tokens.prompt` - Prompt token count
  - `llm.tokens.completion` - Completion token count
  - `llm.tokens.total` - Total token count
  - `llm.cached` - Whether response was cached

- **`llm.request.send`** - Time spent sending request to LLM provider

- **`llm.request.ttft`** - Time to first token (if streaming)
  - `llm.time_to_first_token_ms` - TTFT in milliseconds

- **`llm.response.streaming`** - Time spent streaming response (if streaming)

All spans use the same `TraceId` for correlation and form a parent-child relationship.

## Querying Traces

### Get recent requests by provider

```sql
SELECT
    Timestamp,
    SpanAttributes['llm.provider'] as Provider,
    SpanAttributes['llm.model'] as Model,
    Duration / 1000000 as DurationMs,
    SpanAttributes['llm.tokens.total'] as TotalTokens
FROM otel_traces
WHERE SpanName = 'llm.request'
ORDER BY Timestamp DESC
LIMIT 10;
```

### Calculate average latency by provider

```sql
SELECT
    SpanAttributes['llm.provider'] as Provider,
    avg(Duration / 1000000) as AvgLatencyMs,
    count() as RequestCount
FROM otel_traces
WHERE SpanName = 'llm.request'
  AND Timestamp > now() - INTERVAL 1 HOUR
GROUP BY Provider;
```

### Find slow requests

```sql
SELECT
    Timestamp,
    TraceId,
    SpanAttributes['llm.provider'] as Provider,
    SpanAttributes['llm.model'] as Model,
    Duration / 1000000 as DurationMs
FROM otel_traces
WHERE SpanName = 'llm.request'
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
