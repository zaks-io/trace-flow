# SDK Reference

These examples use the hosted Trace Flow service. An account with access is required.
For your own deployment, see [self-hosted setup](/docs/quick-start#self-hosted-deployments).

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
| TypeSafe   | `/typesafe/v1/*`   | `api.typesafe.ai/v1/*`                |

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

## Jev decisions (TypeSafe)

Jev is TypeSafe's decision model. It takes application `state` and typed `questions`, then
returns `answers` and token usage. Trace Flow records these requests as decisions and shows the
captured state, questions, and answers in the trace detail panel when body recording is enabled.
Call Jev directly through TypeSafe or through OpenRouter:

| API                   | Gateway endpoint                                            | Model example          |
| --------------------- | ----------------------------------------------------------- | ---------------------- |
| TypeSafe System One   | `https://gateway.trace-flow.dev/typesafe/v1/systemone`      | `jev-latest`           |
| OpenRouter System One | `https://gateway.trace-flow.dev/openrouter/v1/systemone`    | `jev-latest`           |
| OpenRouter Decisions  | `https://gateway.trace-flow.dev/openrouter/alpha/decisions` | `~typesafe/jev-latest` |

With the [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript), set the base URL to
end at the provider name, because the SDK appends `/v1/systemone`:

```typescript
import { noul, TypeSafeClient } from '@typesafe-ai/sdk';

const client = new TypeSafeClient({
  apiKey: process.env.TYPESAFE_API_KEY,
  baseURL: 'https://gateway.trace-flow.dev/typesafe',
  defaultHeaders: { 'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY },
});

const result = await client.systemOne({
  model: 'jev-latest',
  state: 'My subscription was charged twice.',
  questions: { refund: noul('Is the customer asking for money back?') },
});
```

To route the SDK through OpenRouter instead, use `OPENROUTER_API_KEY` and
`baseURL: 'https://gateway.trace-flow.dev/openrouter'`.

Over plain HTTP:

```bash
curl -X POST https://gateway.trace-flow.dev/typesafe/v1/systemone \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H "X-Trace-Flow-Api-Key: $TRACE_FLOW_API_KEY" \
  -d '{
    "model": "jev-latest",
    "state": "My subscription was charged twice.",
    "questions": {
      "refund": { "type": "noul", "instructions": "Is the customer asking for money back?" }
    }
  }'
```

Direct TypeSafe costs are estimates from its published rates. OpenRouter can also report a
provider-billed `usage.cost`, which Trace Flow records separately. See the
[AI Agents guide](/docs/agents) for answer fields, privacy mode, and cost details.
