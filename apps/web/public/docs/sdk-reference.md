# SDK Reference

Copy-paste provider examples for Trace Flow gateway.

Gateway base URL: `https://gateway.trace-flow.dev`

## Route map

| Provider   | Gateway Path       | Proxies To                            |
| ---------- | ------------------ | ------------------------------------- |
| OpenAI     | `/openai/v1/*`     | `api.openai.com/v1/*`                 |
| Anthropic  | `/anthropic/v1/*`  | `api.anthropic.com/v1/*`              |
| Google     | `/google/v1beta/*` | `generativelanguage.googleapis.com/*` |
| OpenRouter | `/openrouter/v1/*` | `openrouter.ai/api/v1/*`              |
| Groq       | `/groq/v1/*`       | `api.groq.com/openai/v1/*`            |

## Required headers

- `X-Trace-Flow-Api-Key`: your Trace Flow API key
- Your provider's normal authentication. The SDK examples below set the provider API key and let
  each SDK choose its required `Authorization`, `x-api-key`, or Google authentication format.

## Vercel AI SDK: OpenAI

```typescript
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const openai = createOpenAI({
  baseURL: 'https://gateway.trace-flow.dev/openai/v1',
  apiKey: process.env.OPENAI_API_KEY,
  headers: { 'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY },
});

const result = await generateText({
  model: openai(process.env.OPENAI_MODEL!),
  prompt: 'Hello, world!',
});
```

## Vercel AI SDK: Anthropic

```typescript
import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';

const anthropic = createAnthropic({
  baseURL: 'https://gateway.trace-flow.dev/anthropic/v1',
  apiKey: process.env.ANTHROPIC_API_KEY,
  headers: { 'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY },
});

const result = await generateText({
  model: anthropic(process.env.ANTHROPIC_MODEL!),
  prompt: 'Hello, world!',
});
```

## Vercel AI SDK: Google

```typescript
import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

const google = createGoogleGenerativeAI({
  baseURL: 'https://gateway.trace-flow.dev/google/v1beta',
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  headers: { 'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY },
});

const result = await generateText({
  model: google(process.env.GOOGLE_MODEL!),
  prompt: 'Hello, world!',
});
```

## Vercel AI SDK: OpenRouter

```typescript
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const openrouter = createOpenAI({
  baseURL: 'https://gateway.trace-flow.dev/openrouter/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  headers: { 'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY },
});

const result = await generateText({
  model: openrouter(process.env.OPENROUTER_MODEL!),
  prompt: 'Hello, world!',
});
```

## Vercel AI SDK: Groq

```typescript
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const groq = createOpenAI({
  baseURL: 'https://gateway.trace-flow.dev/groq/v1',
  apiKey: process.env.GROQ_API_KEY,
  headers: { 'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY },
});

const result = await generateText({
  model: groq(process.env.GROQ_MODEL!),
  prompt: 'Hello, world!',
});
```

## Native OpenAI SDK

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'https://gateway.trace-flow.dev/openai/v1',
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: {
    'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY,
  },
});
```

## Direct HTTP (cURL)

```bash
curl -X POST https://gateway.trace-flow.dev/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "X-Trace-Flow-Api-Key: $TRACE_FLOW_API_KEY" \
  -d '{
    "model": "'$OPENAI_MODEL'",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```
