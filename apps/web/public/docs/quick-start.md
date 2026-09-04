# Quick Start

These examples refer to Zaks.io's company deployment and require access. Trace Flow is internal
development tooling shared as source, with no service availability or support commitment. For a
fork, substitute your own endpoints and credentials. Requests and uploaded activity go to the
configured deployment; use synthetic data when testing.

This guide connects model API traffic to Trace Flow. Gateway requests produce LLM spans and
event metadata. Add W3C trace context or export application spans over OTLP when you want those LLM
spans joined to the rest of an application trace.

To observe the coding agent itself, install the separate
[coding-agent collector](https://trace-flow.dev/docs/collector). If you want an agent to wire your
application's model calls through the gateway, give it
[`/agents.md`](https://trace-flow.dev/agents.md).

## 1) Add your env vars

Keep your upstream provider key exactly as you already do, then add your Trace Flow key:

```bash
export TRACE_FLOW_API_KEY="your-trace-flow-key"
export OPENAI_API_KEY="your-provider-key"
export OPENAI_MODEL="your-openai-model"
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
  model: openai(process.env.OPENAI_MODEL!),
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
  model: openai(process.env.OPENAI_MODEL!),
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

## What can be tracked

- Request and response bodies when recording is enabled and body storage is not omitted
- Token usage reported by the provider, including cached or reasoning tokens where available
- Timing metrics, including time to first token for streaming responses
- Model/provider metadata and finish reason
- Errors and status codes

## Next docs

- [AI Agents](/docs/agents)
- [Coding-Agent Collector](/docs/collector)
- [SDK Reference](/docs/sdk-reference)
- [OpenTelemetry](/docs/opentelemetry)
