# Trace Flow Integration Guide

## What is Trace Flow?

Trace Flow is an LLM observability platform. See your entire AI workflow in one trace:
user events → API calls → LLM requests → tool calls → final response.

Gateway: `https://gateway.trace-flow.dev`

Get your API key: https://trace-flow.dev/app/api-keys

## Quick Start

### 1. Install

```bash
npm install ai @ai-sdk/openai
```

### 2. Configure Provider

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

### 3. Make Requests

```typescript
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'Hello!',
});
```

### 4. Link to OpenTelemetry Traces (Recommended)

Connect LLM calls to existing traces for full observability:

```typescript
const parentSpan = tracer.startSpan('user-request');
const ctx = parentSpan.spanContext();

const result = await generateText({
  model: openai('gpt-4o'),
  prompt: userMessage,
  headers: {
    'X-Trace-Flow-Trace-Id': ctx.traceId,
    'X-Trace-Flow-Parent-Span-Id': ctx.spanId,
  },
});
```

## Headers Reference

| Header                      | Required | Format       | Purpose                |
| --------------------------- | -------- | ------------ | ---------------------- |
| X-Trace-Flow-Api-Key        | Yes      | string       | Authentication         |
| X-Trace-Flow-Trace-Id       | No       | 32 hex chars | Link to existing trace |
| X-Trace-Flow-Parent-Span-Id | No       | 16 hex chars | Set parent span        |

## Proxy Routes

| Provider   | Gateway Path      | Proxies To                |
| ---------- | ----------------- | ------------------------- |
| OpenAI     | /openai/v1/\*     | api.openai.com/v1/\*      |
| Anthropic  | /anthropic/v1/\*  | api.anthropic.com/v1/\*   |
| OpenRouter | /openrouter/v1/\* | openrouter.ai/api/v1/\*   |
| Groq       | /groq/v1/\*       | api.groq.com/openai/v1/\* |

## Other Providers

### Anthropic

```typescript
import { createAnthropic } from '@ai-sdk/anthropic';

const anthropic = createAnthropic({
  baseURL: 'https://gateway.trace-flow.dev/anthropic/v1',
  apiKey: process.env.ANTHROPIC_API_KEY,
  headers: {
    'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY,
  },
});
```

### OpenRouter

```typescript
import { createOpenAI } from '@ai-sdk/openai';

const openrouter = createOpenAI({
  baseURL: 'https://gateway.trace-flow.dev/openrouter/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  headers: {
    'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY,
  },
});
```

### Groq

```typescript
import { createOpenAI } from '@ai-sdk/openai';

const groq = createOpenAI({
  baseURL: 'https://gateway.trace-flow.dev/groq/v1',
  apiKey: process.env.GROQ_API_KEY,
  headers: {
    'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY,
  },
});
```

## What Gets Tracked

- Request and response bodies
- Token usage (input, output, cached, reasoning)
- Timing metrics (latency, time to first token)
- Model, provider, and finish reason
- Error details when requests fail

## More Documentation

- Quick Start: https://trace-flow.dev/docs/quick-start
- SDK Reference: https://trace-flow.dev/docs/sdk-reference
- OpenTelemetry Setup: https://trace-flow.dev/docs/opentelemetry
- AI Agents Guide: https://trace-flow.dev/docs/agents
