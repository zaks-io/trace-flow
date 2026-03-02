# Quick Start

Get end-to-end LLM observability in minutes. Trace Flow links user events, API calls, LLM requests, tool calls, and final responses in one trace timeline.

## 1) Install SDK dependencies

```bash
npm install ai @ai-sdk/openai
```

## 2) Configure your provider to use Trace Flow gateway

Use your normal provider API key and add your Trace Flow API key in headers.

```typescript
import { createOpenAI } from '@ai-sdk/openai';

const openai = createOpenAI({
  baseURL: 'https://gateway.trace-flow.dev/openai/v1',
  apiKey: process.env.OPENAI_API_KEY,
  headers: {
    'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY,
  },
});
```

## 3) Send requests as normal

```typescript
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-5'),
  prompt: 'Plan a weekend trip to Portland.',
});
```

## 4) Link requests to your app traces

To stitch LLM calls into your existing trace hierarchy, pass trace context headers.

```typescript
import { trace, context } from '@opentelemetry/api';
import { generateText } from 'ai';

const parentSpan = tracer.startSpan('user-request');
const ctx = parentSpan.spanContext();

const result = await generateText({
  model: openai('gpt-5'),
  prompt: userMessage,
  headers: {
    'X-Trace-Flow-Trace-Id': ctx.traceId,
    'X-Trace-Flow-Parent-Span-Id': ctx.spanId,
  },
});

parentSpan.end();
```

## Required headers

| Header                        | Format       | Purpose                                 |
| ----------------------------- | ------------ | --------------------------------------- |
| `X-Trace-Flow-Api-Key`        | string       | Required. Your Trace Flow API key       |
| `X-Trace-Flow-Trace-Id`       | 32 hex chars | Optional. Join an existing trace        |
| `X-Trace-Flow-Parent-Span-Id` | 16 hex chars | Optional. Set parent span for hierarchy |

## What gets tracked

- Request and response bodies
- Token usage (input, output, cached, reasoning)
- Timing metrics (latency, time to first token)
- Model/provider metadata and finish reason
- Errors and status codes

## Next docs

- [SDK Reference](/docs/sdk-reference)
- [OpenTelemetry](/docs/opentelemetry)
