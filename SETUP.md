# Setup Instructions

## 1. Create Cloudflare Queues

Run these commands to create the required queues:

```bash
npx wrangler queues create llm-requests
npx wrangler queues create llm-requests-dlq
```

## 2. Configure ClickStack Secrets

Set the following secrets for the proxy-consumer worker:

```bash
cd workers/proxy-consumer

# Set the ClickStack OTLP endpoint (e.g., https://your-clickstack.com:4318/v1/traces)
npx wrangler secret put CLICKSTACK_OTLP_ENDPOINT

# Set your ClickStack API key (found in HyperDX app under "Team Settings → API Keys")
npx wrangler secret put CLICKSTACK_API_KEY

# Optional: Set a custom service name (defaults to "observe-proxy-consumer")
npx wrangler secret put OTEL_SERVICE_NAME
```

## 3. Deploy the Workers

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
CLICKSTACK_OTLP_ENDPOINT=http://localhost:4318/v1/traces
CLICKSTACK_API_KEY=your-api-key-here
OTEL_SERVICE_NAME=observe-proxy-consumer-dev
```

Then run the workers in development mode:

```bash
# From the root of the project
bun run dev
```

## Verifying the Setup

1. Send a test request to your proxy worker with the `X-Proxy-Target` header
2. Check that the request is queued successfully
3. Verify that the proxy-consumer processes the message
4. View the traces in ClickStack/HyperDX dashboard

## Architecture

The system works as follows:

1. **Proxy Worker** receives LLM requests and streams responses back to clients
2. Request/response bodies are stored in R2 asynchronously
3. Metadata is sent to Cloudflare Queue (`llm-requests`)
4. **Proxy Consumer Worker** processes queue messages
5. Consumer retrieves bodies from R2 and sends OpenTelemetry traces to ClickStack
6. Traces are visible in the ClickStack/HyperDX dashboard with full observability

## OpenTelemetry Configuration

The proxy-consumer is configured to send traces to ClickStack using the OTLP HTTP protocol. Each queue message creates a span with the following attributes:

- `queue.message.id` - Cloudflare Queue message ID
- `request.id` - Unique request identifier
- `request.provider` - LLM provider name
- `request.model` - LLM model name
- `response.status` - HTTP response status code
- `response.latency` - Request latency in milliseconds
- `r2.key` - R2 object key for request/response bodies
- `r2.body.size` - Size of the stored body in bytes

This provides full observability into your LLM request pipeline.
