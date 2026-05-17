export type ProviderId = 'openai' | 'anthropic' | 'google' | 'openrouter' | 'groq';

export interface ProviderConfig {
  id: ProviderId;
  baseUrl: string;
}

export interface ResolvedRoute {
  provider: ProviderConfig;
  targetUrl: string;
}

/**
 * Per-provider description of where token fields live in the response body. Drives
 * BOTH whole-body extraction (parseTokenUsage) and streaming SSE accumulation
 * (createTokenAccumulator). Same schema, same code path, no drift.
 */
export interface ProviderTokenSchema {
  /** Field names to probe for prompt-side tokens. First-match wins. OpenAI lists both
   * Chat (`prompt_tokens`) and Responses (`input_tokens`) shapes. */
  promptFields: readonly string[];
  completionFields: readonly string[];
  totalFields?: readonly string[];
  cacheReadFields?: readonly string[];
  cacheCreationFields?: readonly string[];
  reasoningFields?: readonly string[];
  /** When set, parse a usage-scoped `cost` field (OpenRouter). */
  hasUpstreamCost?: boolean;
  /** false (Anthropic): prompt field is the UNCACHED portion. promptTokens is
   *  derived by adding cacheRead + cacheCreation. true (everyone else): prompt
   *  field already includes cached tokens. */
  promptIncludesCache: boolean;
  /** Google streams cumulative usageMetadata in every chunk — body parsing must
   *  use the LAST regex match (final totals) instead of the FIRST. */
  lastMatchOnly: boolean;
  /** Anthropic's `cache_creation` sub-object breaks cache writes into 5m / 1h tiers. */
  nestedCacheCreation?: { field5m: string; field1h: string };
}

/**
 * Raw token fields extracted from an SSE event or whole body. Shared shape — any
 * provider's event can populate any subset. Provider-specific normalization happens
 * at the accumulator's finalize() step.
 */
export interface RawTokenUsage {
  // OpenAI / Anthropic / OpenRouter style
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_write_tokens?: number;
  cached_tokens?: number;
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
  reasoning_tokens?: number;
  cost?: number;
  // Google style
  prompt_token_count?: number;
  candidates_token_count?: number;
  cached_content_token_count?: number;
  total_token_count?: number;
  thoughts_token_count?: number;
}
