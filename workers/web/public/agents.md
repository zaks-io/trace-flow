# Trace Flow Gateway

LLM observability: user events → API calls → LLM requests → tool calls → final response.

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
  prompt: 'Hello ',
});
```

## Providers

| Provider   | Path           |
| ---------- | -------------- |
| OpenAI     | /openai/v1     |
| Anthropic  | /anthropic/v1  |
| Google     | /google/v1beta |
| OpenRouter | /openrouter/v1 |
| Groq       | /groq/v1       |

Adapt the example above: change `baseURL` path and use the appropriate SDK/API key for each provider.

## Gantt Chart Hierarchy

Trace Flow displays a Gantt chart of your LLM calls. Use the `traceparent` header to group related calls:

**Format:** `traceparent: 00-{traceId}-{spanId}-01`

- **traceId** (32 hex chars): Same for all calls in a workflow → groups them in one trace
- **spanId** (16 hex chars): Different per call → creates timeline entries

```typescript
function generateTraceId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateSpanId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Generate once per user request
const traceId = generateTraceId();

// Call 1: Planning
await generateText({
  model: openai('gpt-5'),
  prompt: 'Plan: ' + task,
  headers: { traceparent: `00-${traceId}-${generateSpanId()}-01` },
});

// Call 2: Execution (same traceId = same Gantt chart)
await generateText({
  model: openai('gpt-5'),
  prompt: 'Execute: ' + plan,
  headers: { traceparent: `00-${traceId}-${generateSpanId()}-01` },
});
```

## Operation Labels

Use `baggage` header to label phases in the UI. Stored as `baggage.operation` attribute for filtering:

```typescript
headers: {
  traceparent: `00-${traceId}-${generateSpanId()}-01`,
  baggage: 'operation=planning',
}

// Example operation values:
// operation=planning, operation=execution, operation=summarization
// operation=tool-search, operation=tool-calculator, operation=rag-retrieval
```

Add custom context: `baggage: 'operation=planning,user_id=123,session_id=abc'`

## OpenTelemetry Integration

If using OpenTelemetry, inject trace context automatically:

```typescript
import { context, propagation } from '@opentelemetry/api';

const traceHeaders: Record<string, string> = {};
propagation.inject(context.active(), traceHeaders);

await generateText({
  model: openai('gpt-5'),
  prompt: message,
  headers: traceHeaders, // Contains traceparent and tracestate
});
```

## What Gets Tracked

- Token usage (prompt, completion, cached, reasoning)
- Latency and time to first token
- Model, provider, finish reason
- Request/response bodies
- Errors and status codes
- Cost estimates

## Privacy: Skip Body Storage

To capture metrics without storing request/response bodies, add:

```typescript
headers: {
  'X-Trace-Flow-Omit-Body': 'true',
}
```

All timing, tokens, and costs are still tracked—only body content is omitted.
