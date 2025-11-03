# Using the Observe Proxy with Vercel AI SDK

This guide shows you how to integrate the Observe proxy to add observability to your LLM applications.

## Overview

The Observe proxy acts as an intermediary between your application and LLM providers (OpenAI, Anthropic, etc.), automatically capturing request/response data, token usage, errors, and streaming metrics for analytics.

## Prerequisites

1. **Proxy endpoint**: Your deployed Observe proxy URL (e.g., `https://observe-proxy.isaac-a46.workers.dev`)
2. **API key**: An Observe API key for authentication (stored in Cloudflare KV)
3. **Provider API key**: Your LLM provider API key (OpenAI, Anthropic, etc.)

## Quick Start

### 1. Install Dependencies

```bash
npm install ai @ai-sdk/openai @ai-sdk/anthropic
# or
pnpm add ai @ai-sdk/openai @ai-sdk/anthropic
# or
yarn add ai @ai-sdk/openai @ai-sdk/anthropic
```

### 2. Configure the AI SDK with Custom Fetch

The Vercel AI SDK supports custom fetch functions, which allows you to route requests through the Observe proxy. Here's how to set it up:

#### For OpenAI

```typescript
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

// Create a custom fetch function that routes through the Observe proxy
const createProxyFetch = (proxyUrl: string, observeApiKey: string, providerApiKey: string) => {
  return async (url: string, options?: RequestInit): Promise<Response> => {
    // Extract the original target URL from the OpenAI SDK request
    const targetUrl = url;

    return fetch(proxyUrl, {
      method: options?.method || 'POST',
      headers: {
        ...options?.headers,
        'X-Observe-Api-Key': observeApiKey,
        'X-Proxy-Target': targetUrl,
        'X-Provider-Api-Key': providerApiKey,
        // Remove OpenAI's Authorization header since we're using X-Provider-Api-Key
        Authorization: undefined,
      } as HeadersInit,
      body: options?.body,
    });
  };
};

// Initialize OpenAI with custom fetch
// Note: baseURL is omitted so SDK uses OpenAI's default URL
// The custom fetch intercepts the provider URL and routes it through the proxy
const openaiClient = openai({
  apiKey: process.env.OPENAI_API_KEY, // Still required by SDK for validation
  fetch: createProxyFetch(
    'https://your-proxy-url.workers.dev',
    process.env.OBSERVE_API_KEY!,
    process.env.OPENAI_API_KEY!,
  ),
});

// Use it in your application
const { text } = await generateText({
  model: openaiClient('gpt-4'),
  prompt: 'Explain quantum computing in simple terms',
});
```

#### For Anthropic

```typescript
import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const createProxyFetch = (proxyUrl: string, observeApiKey: string, providerApiKey: string) => {
  return async (url: string, options?: RequestInit): Promise<Response> => {
    return fetch(proxyUrl, {
      method: options?.method || 'POST',
      headers: {
        ...options?.headers,
        'X-Observe-Api-Key': observeApiKey,
        'X-Proxy-Target': url,
        'X-Provider-Api-Key': providerApiKey,
        'x-api-key': undefined, // Remove Anthropic's header, proxy will inject it
      } as HeadersInit,
      body: options?.body,
    });
  };
};

const anthropicClient = anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // baseURL omitted - SDK will use Anthropic's default URL
  fetch: createProxyFetch(
    'https://your-proxy-url.workers.dev',
    process.env.OBSERVE_API_KEY!,
    process.env.ANTHROPIC_API_KEY!,
  ),
});

const { text } = await generateText({
  model: anthropicClient('claude-3-5-sonnet-20241022'),
  prompt: 'Write a haiku about coding',
});
```

#### For OpenRouter

OpenRouter uses an OpenAI-compatible API, so you can use the `@ai-sdk/openai` SDK with OpenRouter's base URL:

```typescript
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const createProxyFetch = (proxyUrl: string, observeApiKey: string, providerApiKey: string) => {
  return async (url: string, options?: RequestInit): Promise<Response> => {
    return fetch(proxyUrl, {
      method: options?.method || 'POST',
      headers: {
        ...options?.headers,
        'X-Observe-Api-Key': observeApiKey,
        'X-Proxy-Target': url,
        'X-Provider-Api-Key': providerApiKey,
        Authorization: undefined, // Remove OpenAI's header, proxy will inject it
      } as HeadersInit,
      body: options?.body,
    });
  };
};

const openrouterClient = openai({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
  fetch: createProxyFetch(
    'https://your-proxy-url.workers.dev',
    process.env.OBSERVE_API_KEY!,
    process.env.OPENROUTER_API_KEY!,
  ),
});

const { text } = await generateText({
  model: openrouterClient('anthropic/claude-3.5-sonnet'),
  prompt: 'Explain quantum computing in simple terms',
});
```

## Environment Variables

Create a `.env.local` file with your keys:

```bash
# Observe proxy configuration
OBSERVE_API_KEY=your-observe-api-key-here
PROXY_URL=https://your-proxy-url.workers.dev

# Provider API keys
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=sk-or-...
```

## Streaming Support

The proxy fully supports streaming responses. Stream handling works automatically:

```typescript
import { streamText } from 'ai';

const result = streamText({
  model: openaiClient('gpt-4'),
  prompt: 'Tell me a story about a robot',
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

The proxy captures:

- **First token latency**: Time to first chunk
- **Streaming metrics**: Token-by-token timing for SSE responses
- **Full response body**: Complete response stored in R2

## Next.js Route Handlers

### API Route Example

```typescript
// app/api/chat/route.ts
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

const createProxyFetch = (proxyUrl: string, observeApiKey: string, providerApiKey: string) => {
  return async (url: string, options?: RequestInit): Promise<Response> => {
    return fetch(proxyUrl, {
      method: options?.method || 'POST',
      headers: {
        ...options?.headers,
        'X-Observe-Api-Key': observeApiKey,
        'X-Proxy-Target': url,
        'X-Provider-Api-Key': providerApiKey,
        Authorization: undefined,
      } as HeadersInit,
      body: options?.body,
    });
  };
};

const openaiClient = openai({
  apiKey: process.env.OPENAI_API_KEY!,
  // baseURL omitted - SDK uses OpenAI's default, custom fetch routes through proxy
  fetch: createProxyFetch(
    process.env.PROXY_URL!,
    process.env.OBSERVE_API_KEY!,
    process.env.OPENAI_API_KEY!,
  ),
});

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openaiClient('gpt-4'),
    messages,
  });

  return result.toDataStreamResponse();
}
```

## React Hook Example

```typescript
// app/page.tsx
'use client';

import { useChat } from 'ai/react';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat({
    api: '/api/chat', // Uses the proxy-enabled route handler above
  });

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>
          {m.role}: {m.content}
        </div>
      ))}

      <form onSubmit={handleSubmit}>
        <input
          value={input}
          placeholder="Say something..."
          onChange={handleInputChange}
        />
      </form>
    </div>
  );
}
```

## Advanced: Reusable Proxy Configuration

Create a utility file for cleaner code:

```typescript
// lib/ai-proxy.ts
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';

const PROXY_URL = process.env.PROXY_URL!;
const OBSERVE_API_KEY = process.env.OBSERVE_API_KEY!;

function createProxyFetch(providerApiKey: string) {
  return async (url: string, options?: RequestInit): Promise<Response> => {
    return fetch(PROXY_URL, {
      method: options?.method || 'POST',
      headers: {
        ...options?.headers,
        'X-Observe-Api-Key': OBSERVE_API_KEY,
        'X-Proxy-Target': url,
        'X-Provider-Api-Key': providerApiKey,
        Authorization: undefined,
        'x-api-key': undefined,
      } as HeadersInit,
      body: options?.body,
    });
  };
}

export const openaiClient = openai({
  apiKey: process.env.OPENAI_API_KEY!,
  // baseURL omitted - SDK uses provider's default URL
  fetch: createProxyFetch(process.env.OPENAI_API_KEY!),
});

export const anthropicClient = anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  // baseURL omitted - SDK uses provider's default URL
  fetch: createProxyFetch(process.env.ANTHROPIC_API_KEY!),
});
```

Then use it anywhere:

```typescript
import { openaiClient } from '@/lib/ai-proxy';
import { generateText } from 'ai';

const { text } = await generateText({
  model: openaiClient('gpt-4'),
  prompt: 'Hello, world!',
});
```

## What Gets Captured

Every request routed through the proxy automatically captures:

- **Request metadata**: Timestamps, trace IDs, request IDs
- **Request/response bodies**: Full content stored in R2
- **Token usage**: Prompt and completion tokens
- **Performance metrics**:
  - Time to first token (streaming)
  - Total latency
  - Request/response sizes
- **Errors**: Parsed error messages and status codes
- **Streaming events**: SSE message parsing for detailed streaming metrics

View all captured data in the Observe dashboard at your web worker URL.

## Troubleshooting

### 401 Unauthorized

- Check that `X-Observe-Api-Key` is set correctly
- Verify the API key exists in Cloudflare KV namespace
- Ensure the API key hasn't expired

### Missing X-Proxy-Target header

- Make sure you're setting `X-Proxy-Target` to the original provider URL
- For OpenAI: `https://api.openai.com/v1/chat/completions`
- For Anthropic: `https://api.anthropic.com/v1/messages`

### Provider authentication fails

- Verify `X-Provider-Api-Key` is set correctly
- Check that the provider API key is valid
- Ensure the provider API key format matches expectations (Bearer vs x-api-key)

### Streaming not working

- The proxy automatically handles streaming - no special configuration needed
- Verify `Content-Type: text/event-stream` is preserved
- Check that you're using `streamText()` or `streamObject()` from AI SDK

## Security Best Practices

1. **Never expose provider API keys** - Always use `X-Provider-Api-Key` header, never put keys in URLs or query params
2. **Rotate Observe API keys** - Set expiration dates on API keys and rotate regularly
3. **Use environment variables** - Never hardcode API keys in source code
4. **Limit API key scopes** - Create separate API keys for different environments (dev, staging, prod)

## Additional Resources

- [Vercel AI SDK Documentation](https://sdk.vercel.ai/docs)
- [OpenAI API Reference](https://platform.openai.com/docs/api-reference)
- [Anthropic API Reference](https://docs.anthropic.com/claude/reference)
