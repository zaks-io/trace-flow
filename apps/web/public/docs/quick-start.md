# Quick Start

Get end-to-end LLM observability in minutes. Trace Flow links user events, API calls, LLM requests, tool calls, and final responses in one trace timeline.

If you use Cursor, Claude Code, or another coding agent, you can also hand it [`/agents.md`](https://trace-flow.dev/agents.md) and let it wire the integration into your repo.

## 1) Add your env vars

Keep your upstream provider key exactly as you already do, then add your Trace Flow key:

```bash
export TRACE_FLOW_API_KEY="your-trace-flow-key"
export OPENAI_API_KEY="your-provider-key"
```

## 2) Install SDK dependencies

```bash
npm install ai @ai-sdk/openai
```

## 3) Configure your provider to use the Trace Flow gateway

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

## 4) Send requests as normal

```typescript
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-5'),
  prompt: 'Plan a weekend trip to Portland.',
});
```

## 5) Link requests to your app traces

To stitch LLM calls into your existing trace hierarchy, pass W3C trace context headers.

```typescript
import { trace, context } from '@opentelemetry/api';
import { generateText } from 'ai';

const parentSpan = tracer.startSpan('user-request');
const ctx = parentSpan.spanContext();

const result = await generateText({
  model: openai('gpt-5'),
  prompt: userMessage,
  headers: {
    traceparent: `00-${ctx.traceId}-${ctx.spanId}-01`,
    baggage: 'operation=chat,user_id=user_123',
  },
});

parentSpan.end();
```

## Required headers

| Header                 | Format     | Purpose                                 |
| ---------------------- | ---------- | --------------------------------------- |
| `X-Trace-Flow-Api-Key` | string     | Required. Your Trace Flow API key       |
| `traceparent`          | W3C format | Optional. Join an existing trace        |
| `baggage`              | W3C format | Optional. Add filterable trace metadata |

## What gets tracked

- Request and response bodies
- Token usage (input, output, cached, reasoning)
- Timing metrics (latency, time to first token)
- Model/provider metadata and finish reason
- Errors and status codes

## Next docs

- [AI Agents](/docs/agents)
- [SDK Reference](/docs/sdk-reference)
- [OpenTelemetry](/docs/opentelemetry)
