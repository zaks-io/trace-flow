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

## Understanding Trace Context (W3C Spec)

Trace Flow uses the [W3C Trace Context](https://www.w3.org/TR/trace-context/) standard. Understanding when to generate vs reuse IDs is critical:

```
User Request (e.g., "Plan my trip")
    │
    └── Trace (trace-id: 32 hex chars) ─────────────────────────┐
            │                                                    │
            ├── Span 1: Planning call (span-id: 16 hex chars)   │ Same Gantt chart
            ├── Span 2: Search call (span-id: 16 hex chars)     │
            └── Span 3: Summary call (span-id: 16 hex chars)    │
                                                                 ┘
Next User Request (e.g., "Book the hotel")
    │
    └── NEW Trace (NEW trace-id) ───────────────────────────────┐
            │                                                    │ Different Gantt chart
            └── Span 1: Booking call (span-id: 16 hex chars)    │
                                                                 ┘
```

### When to Generate IDs

| ID           | Generate NEW                                 | Reuse                             |
| ------------ | -------------------------------------------- | --------------------------------- |
| **trace-id** | Start of each user request/conversation turn | All LLM calls within that request |
| **span-id**  | Every single LLM call                        | Never—always generate fresh       |

### traceparent Format

```
traceparent: 00-{trace-id}-{span-id}-01
                 │          │        │
                 │          │        └─ flags (01 = sampled)
                 │          └─ 16 hex chars, unique per LLM call
                 └─ 32 hex chars, same for entire user request
```

### Common Mistakes

1. **Reusing span-ids across calls** → Every LLM call needs a fresh `generateSpanId()`. Reusing causes calls to overwrite each other.

2. **Sharing trace-ids across user requests** → Each new user message should call `generateTraceId()`. Persisting trace-ids across conversation turns causes traces to grow indefinitely.

3. **New trace-id per LLM call** → Within one user request, reuse the same trace-id for all related calls (planning, execution, tool use). This groups them in one Gantt chart.

## Gantt Chart Hierarchy

Use the `traceparent` header to group related LLM calls in one Gantt chart. See [Understanding Trace Context](#understanding-trace-context-w3c-spec) for when to generate vs reuse IDs.

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

// IMPORTANT: Generate trace-id ONCE per user request, then reuse it
const traceId = generateTraceId();

// Call 1: Planning (new span-id, same trace-id)
await generateText({
  model: openai('gpt-5'),
  prompt: 'Plan: ' + task,
  headers: { traceparent: `00-${traceId}-${generateSpanId()}-01` },
});

// Call 2: Execution (new span-id, same trace-id = same Gantt chart)
await generateText({
  model: openai('gpt-5'),
  prompt: 'Execute: ' + plan,
  headers: { traceparent: `00-${traceId}-${generateSpanId()}-01` },
});

// WRONG: Don't do this - reusing span-id causes overwrites
// const spanId = generateSpanId();
// headers: { traceparent: `00-${traceId}-${spanId}-01` } // Same spanId = BAD
```

## Operation Labels

Use the [W3C Baggage](https://www.w3.org/TR/baggage/) header to add metadata (not hierarchy). Baggage does NOT affect trace grouping—only `traceparent` does.

**Format:** Comma-separated `key=value` pairs. Percent-encode special characters.

```typescript
headers: {
  traceparent: `00-${traceId}-${generateSpanId()}-01`,
  baggage: 'operation=planning',
}

// Multiple values (comma-separated, no spaces after commas)
baggage: 'operation=planning,user_id=123,session_id=abc'

// Example operation values for filtering in UI:
// operation=planning, operation=execution, operation=summarization
// operation=tool-search, operation=tool-calculator, operation=rag-retrieval
```

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
