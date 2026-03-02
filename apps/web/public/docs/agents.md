# Trace Flow Gateway

LLM observability: user events -> API calls -> LLM requests -> tool calls -> final response.

**Gateway:** `https://gateway.trace-flow.dev`  
**API Keys:** https://trace-flow.dev/app/api-keys  
**MCP Server:** `https://mcp.trace-flow.dev/mcp` ([docs](https://trace-flow.dev/docs/mcp))

## Quick Start

1. Add header: `X-Trace-Flow-Api-Key: {your-api-key}`
2. Change base URL to `gateway.trace-flow.dev/{provider}`
3. Pass your provider API key as normal

```typescript
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';

const openai = createOpenAI({
  baseURL: 'https://gateway.trace-flow.dev/openai/v1',
  apiKey: process.env.OPENAI_API_KEY,
  headers: {
    'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY,
  },
});

const result = await generateText({
  model: openai('gpt-5'),
  prompt: 'Hello',
});
```

## Providers

| Provider   | Path             |
| ---------- | ---------------- |
| OpenAI     | `/openai/v1`     |
| Anthropic  | `/anthropic/v1`  |
| Google     | `/google/v1beta` |
| OpenRouter | `/openrouter/v1` |
| Groq       | `/groq/v1`       |

## Understanding Trace Context (W3C)

Trace Flow uses [W3C Trace Context](https://www.w3.org/TR/trace-context/).

- Generate a new `trace-id` per user request or turn.
- Reuse the same `trace-id` for all related LLM calls in that request.
- Always generate a new `span-id` for every LLM call.

`traceparent` format:

```text
traceparent: 00-{trace-id}-{span-id}-01
```

## Common mistakes

1. Reusing a span ID across multiple calls (causes overwrites)
2. Reusing a trace ID across separate user requests (traces grow incorrectly)
3. Generating a new trace ID for each LLM call inside one workflow

## Baggage for operation labels

Use [W3C Baggage](https://www.w3.org/TR/baggage/) to pass filterable metadata:

```typescript
headers: {
  traceparent: `00-${traceId}-${generateSpanId()}-01`,
  baggage: "operation=planning,user_id=123,session_id=abc",
}
```

## OpenTelemetry integration

```typescript
import { context, propagation } from '@opentelemetry/api';

const traceHeaders: Record<string, string> = {};
propagation.inject(context.active(), traceHeaders);

await generateText({
  model: openai('gpt-5'),
  prompt: message,
  headers: traceHeaders,
});
```

## What gets tracked

- Token usage (prompt, completion, cached, reasoning)
- Latency and time to first token
- Model/provider metadata and finish reason
- Request/response bodies
- Errors and status codes
- Cost estimates

## Privacy mode: skip body storage

```typescript
headers: {
  "X-Trace-Flow-Omit-Body": "true",
}
```

Metrics are still captured; only request and response bodies are omitted.

## Full docs

- https://trace-flow.dev/docs/quick-start
- https://trace-flow.dev/docs/sdk-reference
- https://trace-flow.dev/docs/opentelemetry
- https://trace-flow.dev/docs/mcp
