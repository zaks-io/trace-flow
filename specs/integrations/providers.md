# LLM Provider Integration

Trace Flow proxies requests to multiple LLM providers while capturing observability data. This document covers routing, request transformation, and response parsing for each provider.

## Supported Providers

| Provider   | Path Prefix     | Target Base URL                             |
| ---------- | --------------- | ------------------------------------------- |
| OpenAI     | `/openai/*`     | `https://api.openai.com`                    |
| Anthropic  | `/anthropic/*`  | `https://api.anthropic.com`                 |
| Google     | `/google/*`     | `https://generativelanguage.googleapis.com` |
| OpenRouter | `/openrouter/*` | `https://openrouter.ai/api`                 |
| Groq       | `/groq/*`       | `https://api.groq.com/openai`               |

Provider configuration lives in `apps/proxy/src/providers.ts`.

## Routing

The proxy uses path-based routing. The first path segment identifies the provider, and the remainder passes through to the target API.

```
/openai/v1/chat/completions -> https://api.openai.com/v1/chat/completions
/anthropic/v1/messages -> https://api.anthropic.com/v1/messages
/google/v1beta/models/gemini-pro:generateContent -> https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent
```

The `resolveRoute()` function in `providers.ts` extracts the provider from the path and constructs the target URL.

## Header Transformation

The proxy modifies headers before forwarding to providers:

**Removed headers:**

- `X-Trace-Flow-Api-Key` - Proxy authentication (never forwarded)
- `X-Trace-Flow-Omit-Body` - Body storage control
- `traceparent`, `tracestate`, `baggage` - W3C trace context (parsed, not forwarded)
- `host` - Replaced by target domain

**Passed through unchanged:**

- `Authorization` - Provider API key (OpenAI, OpenRouter, Groq)
- `x-api-key` - Provider API key (Anthropic)
- `x-goog-api-key` - Provider API key (Google)
- `Content-Type`, `Accept`, and all other headers

## Response Parsing

### Token Extraction

The proxy extracts token counts from response bodies using regex (avoiding full JSON parse for performance). See `apps/proxy/src/parsers/tokens.ts`.

**OpenAI/Groq/OpenRouter format:**

```json
{ "usage": { "prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30 } }
```

**Anthropic format:**

```json
{ "usage": { "input_tokens": 10, "output_tokens": 20 } }
```

**Google format:**

```json
{ "usageMetadata": { "promptTokenCount": 10, "candidatesTokenCount": 20 } }
```

All formats normalize to a unified `LLMTokenUsage` structure with `promptTokens`, `completionTokens`, and optional fields for caching and reasoning tokens.

### Request Body Parsing

Input messages are parsed to create input spans for observability. Three parser functions handle provider differences:

- `parseOpenAIStyleRequestBody()` - OpenAI, Groq, OpenRouter
- `parseAnthropicRequestBody()` - Anthropic (handles system message separately)
- `parseGoogleRequestBody()` - Google (maps `model` role to `assistant`)

Parsers extract message structure without storing content, enabling observability without retaining PII.

## Streaming (SSE)

SSE parsing differs significantly between providers. See `apps/proxy/src/streaming/sse.ts`.

### OpenAI/Groq/OpenRouter Style

- No `event:` field, just `data:` lines with JSON
- Stream ends with `data: [DONE]`
- Usage included in final chunk (when `stream_options.include_usage` is set)

### Anthropic Style

Uses typed events for granular observability:

| Event                 | Purpose                                           |
| --------------------- | ------------------------------------------------- |
| `message_start`       | Beginning of response, includes input token count |
| `content_block_start` | Start of text/tool_use/thinking block             |
| `content_block_delta` | Content chunks                                    |
| `content_block_stop`  | Block completion with timestamp                   |
| `message_delta`       | Output token count, stop reason                   |
| `message_stop`        | Stream complete                                   |

This enables tracking Time-To-First-Token (TTFT) per content block and detailed tool use timing.

### Google Style

Similar to OpenAI but with different field names. Usage comes in `usageMetadata` within each chunk.

## Provider-Specific Quirks

**Anthropic:**

- System messages are top-level `system` field, not in `messages` array
- Content blocks have explicit types (`text`, `tool_use`, `thinking`)
- Cache tokens split into `cache_creation_input_tokens` and `cache_read_input_tokens`

**Google:**

- Uses `contents` array instead of `messages`
- Role is `model` instead of `assistant`
- Tool calls are `functionCall`/`functionResponse` in `parts`

**OpenRouter:**

- Proxies to multiple providers, response format matches the underlying provider
- May include additional headers for provider selection

## Configuration

Provider routing requires no configuration beyond the wrangler.toml bindings. The proxy automatically detects the provider from the request path.

For local development, test with:

```bash
curl -X POST http://localhost:8787/openai/v1/chat/completions \
  -H "X-Trace-Flow-Api-Key: your-api-key" \
  -H "Authorization: Bearer your-openai-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"test"}]}'
```
