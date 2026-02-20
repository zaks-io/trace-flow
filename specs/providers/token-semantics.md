# Provider Token Semantics

## Normalization Contract

All provider parsers normalize to `LLMTokenUsage` where:

- **`promptTokens`** = TOTAL input tokens (cached + non-cached)
- **`completionTokens`** = output tokens
- **`cacheReadTokens`** = subset of promptTokens served from cache
- **`cacheCreationTokens`** = tokens written to cache
- **`reasoningTokens`** = reasoning/thinking tokens (subset of completion)
- **`upstreamCost`** = provider-reported cost (OpenRouter only)

## Provider-Specific Semantics

| Provider       | "Prompt" field     | Includes cached? | Cache read field                      | Cache write field                          |
| -------------- | ------------------ | ---------------- | ------------------------------------- | ------------------------------------------ |
| **Anthropic**  | `input_tokens`     | **No**           | `cache_read_input_tokens`             | `cache_creation_input_tokens`              |
| **OpenAI**     | `prompt_tokens`    | **Yes**          | `prompt_tokens_details.cached_tokens` | N/A                                        |
| **OpenRouter** | `prompt_tokens`    | **Yes**          | `prompt_tokens_details.cached_tokens` | `prompt_tokens_details.cache_write_tokens` |
| **Google**     | `promptTokenCount` | **Yes**          | `cachedContentTokenCount`             | N/A                                        |
| **Groq**       | `prompt_tokens`    | **Yes**          | N/A                                   | N/A                                        |

### Anthropic

Anthropic is the only provider where the prompt token field (`input_tokens`) **excludes** cached tokens. The parser normalizes:

```
promptTokens = input_tokens + cache_read_input_tokens
```

Anthropic also reports a `cache_creation` sub-object with `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`. These are parsed into `cacheCreation5mTokens`/`cacheCreation1hTokens` and priced at separate tier rates (`cacheWriteCostPerMillion` for 5m, `cacheWrite1hCostPerMillion` for 1h). When the tier breakdown is available, it replaces the aggregate `cacheCreationTokens` for cost calculation.

### OpenAI

`prompt_tokens` already includes cached tokens. `cached_tokens` is nested under `prompt_tokens_details`. No normalization needed.

### OpenRouter

OpenAI-compatible with additional fields: `cache_write_tokens` in `prompt_tokens_details` and `cost` at the usage level.

### Google

Uses camelCase fields in `usageMetadata`. `promptTokenCount` includes cached tokens. `cachedContentTokenCount` maps to `cacheReadTokens`.

### Groq

Simple OpenAI-compatible format. `prompt_tokens` includes cached tokens. Supports `reasoning_tokens`.

## Module Structure

```
workers/proxy/src/parsers/providers/
  anthropic.ts    — parseAnthropicTokens()
  openai.ts       — parseOpenAITokens()
  openrouter.ts   — parseOpenRouterTokens()
  google.ts       — parseGoogleTokens()
  groq.ts         — parseGroqTokens()
  index.ts        — parseTokenUsage(body, provider?) dispatcher
```

The dispatcher routes by provider ID. When no provider is given, `parseAutoDetect` tries OpenRouter (superset of OpenAI), then Anthropic, then Google.

## Cost Calculation Impact

The consumer's `calculateCost()` in `pricing.ts` subtracts `cacheReadTokens` from `promptTokens` to get non-cached input:

```
nonCachedPromptTokens = max(0, promptTokens - cacheReadTokens)
```

With the normalization fix, this correctly deducts cached tokens for all providers. Before the fix, Anthropic's `input_tokens` (which excluded cache reads) was used as `promptTokens`, making `nonCachedPromptTokens` too low and cache hit rate always 100%.

## Cache Hit Rate

```
cacheHitRate = (cacheReadTokens / promptTokens) * 100
```

Returns null when there's no cache activity (both cacheReadTokens and cacheCreationTokens are 0) or when promptTokens is 0.
