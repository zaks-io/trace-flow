# Setup Instructions

## 1. Create ClickHouse Table

Run the SQL in `workers/proxy-consumer/schema.sql` in your ClickHouse Cloud console to create the `otel_traces` table.

```bash
# Copy the schema from:
cat workers/proxy-consumer/schema.sql
```

Then paste and execute in your ClickHouse Cloud SQL console.

## 2. Create Cloudflare Queues

Run these commands to create the required queues:

```bash
npx wrangler queues create llm-requests
npx wrangler queues create llm-requests-dlq
```

## 3. Configure ClickHouse Secrets

Set the following secrets for the proxy-consumer worker:

```bash
cd workers/proxy-consumer

# Set the ClickHouse host (include https:// and port)
npx wrangler secret put CLICKHOUSE_HOST
# Example: https://rtfxk4dvlo.us-central1.gcp.clickhouse.cloud:8443

# Set your ClickHouse username
npx wrangler secret put CLICKHOUSE_USERNAME
# Example: default

# Set your ClickHouse password
npx wrangler secret put CLICKHOUSE_PASSWORD

# Optional: Set a custom database name (defaults to "default")
npx wrangler secret put CLICKHOUSE_DATABASE
```

## 4. Deploy the Workers

After creating the queues and setting the secrets, deploy the workers:

```bash
# Deploy proxy worker
cd workers/proxy
bun run deploy

# Deploy proxy-consumer worker
cd workers/proxy-consumer
bun run deploy
```

## Testing Locally

To test locally, you'll need to set up environment variables. Create a `.dev.vars` file in `workers/proxy-consumer/`:

```
CLICKHOUSE_HOST=https://your-instance.clickhouse.cloud:8443
CLICKHOUSE_USERNAME=default
CLICKHOUSE_PASSWORD=your-password
CLICKHOUSE_DATABASE=default
```

Then run the workers in development mode:

```bash
# From the root of the project
bun run dev
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
4. Query ClickHouse to see the traces:

```sql
SELECT
    Timestamp,
    TraceId,
    SpanName,
    Duration / 1000000 as DurationMs,
    SpanAttributes
FROM otel_traces
ORDER BY Timestamp DESC
LIMIT 10;
```

## Architecture

The system works as follows:

1. **Proxy Worker** receives LLM requests and streams responses back to clients
2. Request/response bodies are stored in R2 asynchronously
3. Metadata is sent to Cloudflare Queue (`llm-requests`)
4. **Proxy Consumer Worker** processes queue messages
5. Consumer builds OpenTelemetry-compatible trace spans
6. Traces are inserted directly into ClickHouse via HTTP interface
7. Query traces in ClickHouse or visualize with Grafana

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
