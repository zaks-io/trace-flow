# SDK Integration Tests

Test scripts for verifying AI SDK compatibility with the proxy gateway.

## Proxy Path Structure

The proxy uses `/{provider}/...` paths that forward to the provider's API:

| Gateway Path                      | Target URL                                        |
| --------------------------------- | ------------------------------------------------- |
| `/openai/v1/chat/completions`     | `https://api.openai.com/v1/chat/completions`      |
| `/anthropic/v1/messages`          | `https://api.anthropic.com/v1/messages`           |
| `/openrouter/v1/chat/completions` | `https://openrouter.ai/api/v1/chat/completions`   |
| `/groq/v1/chat/completions`       | `https://api.groq.com/openai/v1/chat/completions` |

## AI SDK Usage

```typescript
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';

const PROXY_URL = 'https://your-proxy.workers.dev';
const proxyHeaders = { 'X-Trace-Flow-Api-Key': 'your-trace-flow-key' };

// OpenAI
const openai = createOpenAI({
  baseURL: `${PROXY_URL}/openai/v1`,
  apiKey: 'your-openai-key',
  headers: proxyHeaders,
});

// Anthropic
const anthropic = createAnthropic({
  baseURL: `${PROXY_URL}/anthropic/v1`,
  apiKey: 'your-anthropic-key',
  headers: proxyHeaders,
});

// OpenRouter (uses OpenAI-compatible SDK)
const openrouter = createOpenAI({
  baseURL: `${PROXY_URL}/openrouter/v1`,
  apiKey: 'your-openrouter-key',
  headers: proxyHeaders,
});

// Groq (uses OpenAI-compatible SDK)
const groq = createOpenAI({
  baseURL: `${PROXY_URL}/groq/v1`,
  apiKey: 'your-groq-key',
  headers: proxyHeaders,
});
```

## Setup

1. Install dependencies:

```bash
cd packages/sdk-tests
pnpm install
```

2. Create a `.env` file with your API keys:

```bash
cp .env.example .env
# Edit .env with your keys
```

3. Start the proxy worker locally:

```bash
# From repo root
pnpm run dev:all
```

## Environment Variables

| Variable             | Required             | Description                                  |
| -------------------- | -------------------- | -------------------------------------------- |
| `TRACE_FLOW_API_KEY` | Yes                  | Your proxy gateway API key                   |
| `OPENAI_API_KEY`     | For OpenAI tests     | OpenAI API key                               |
| `ANTHROPIC_API_KEY`  | For Anthropic tests  | Anthropic API key                            |
| `OPENROUTER_API_KEY` | For OpenRouter tests | OpenRouter API key                           |
| `GROQ_API_KEY`       | For Groq tests       | Groq API key                                 |
| `PROXY_URL`          | No                   | Proxy URL (default: `http://localhost:8787`) |

## Running Tests

Test individual providers:

```bash
pnpm run test:openai
pnpm run test:anthropic
pnpm run test:openrouter
pnpm run test:groq
```

Test all configured providers:

```bash
pnpm run test:all
```

Or run directly with bun:

```bash
bun run src/test-openai.ts
bun run src/test-all.ts
```

## What the Tests Verify

Each test runs two scenarios:

1. **Non-streaming**: Uses `generateText()` to get a complete response
2. **Streaming**: Uses `streamText()` to receive chunks incrementally

Both tests verify:

- Request is properly proxied to the provider
- Response is returned correctly
- Token usage is tracked
- Streaming timing (TTFT) is measured

## Example Output

```
==================================================
OpenAI Proxy Test
Proxy URL: http://localhost:8787/openai/v1
==================================================
[OpenAI] Testing non-streaming...
[OpenAI] ✓ Response (847ms): "Hello from the proxy today!"
  Tokens: 18 input, 6 output
[OpenAI] Testing streaming...
  1
  2
  3
  4
  5
[OpenAI] ✓ Stream complete (1203ms, TTFT: 412ms)
  Tokens: 14 input, 15 output

✓ All tests passed
```
