import type { LLMTokenUsage } from '@trace-flow/types';
import { PROVIDER_SCHEMAS } from './schemas';
import type { ProviderId, RawTokenUsage } from './types';

export interface TokenAccumulator {
  /** Merge raw token fields from an SSE event (or any partial source) into the running totals. */
  acceptEvent(usage: RawTokenUsage): void;
  /** Anthropic-only: pass thinking-block character length to estimate reasoning tokens when
   *  the provider doesn't return reasoning_tokens directly. */
  acceptThinkingChars(chars: number): void;
  /** Apply provider-specific normalization and return the canonical LLMTokenUsage,
   *  or undefined when no token data was ever accepted. */
  finalize(): LLMTokenUsage | undefined;
}

/**
 * SSE-friendly token accumulator. Sums raw fields across events, applies the
 * provider's schema at finalize() time. Same schema, same normalization rules
 * as parseTokenUsage — drift between whole-body and streaming becomes impossible
 * by construction.
 */
export function createTokenAccumulator(providerId: ProviderId): TokenAccumulator {
  const schema = PROVIDER_SCHEMAS[providerId];

  // Sums across events. `inputTokens` covers OpenAI/Anthropic-style input_tokens (or
  // prompt_tokens, since the proxy's SSE extractor maps prompt_tokens → input_tokens)
  // plus Google's prompt_token_count. Same conceptual quantity from different keys.
  let inputTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let cacheCreation5mTokens = 0;
  let cacheCreation1hTokens = 0;
  let googleCachedTokens = 0;
  let googleTotalTokenCount: number | undefined;
  let thinkingChars = 0;
  let lastUpstreamCost: number | undefined;
  let hasAnyTokens = false;
  let hasInputTokens = false;

  return {
    acceptEvent(usage) {
      if (usage.input_tokens !== undefined) {
        inputTokens += usage.input_tokens;
        hasInputTokens = true;
        hasAnyTokens = true;
      }
      if (usage.output_tokens !== undefined) {
        completionTokens += usage.output_tokens;
        hasAnyTokens = true;
      }
      if (usage.reasoning_tokens !== undefined) {
        reasoningTokens += usage.reasoning_tokens;
        hasAnyTokens = true;
      }
      if (usage.cache_read_input_tokens !== undefined) {
        cacheReadTokens += usage.cache_read_input_tokens;
        hasAnyTokens = true;
      }
      if (usage.cached_tokens !== undefined) {
        // OpenAI/OpenRouter: same conceptual quantity as Anthropic's cache_read_input_tokens.
        // Bridging proxies that emit both would double-count; no real upstream does.
        cacheReadTokens += usage.cached_tokens;
        hasAnyTokens = true;
      }
      if (usage.cache_creation_input_tokens !== undefined) {
        cacheCreationTokens += usage.cache_creation_input_tokens;
        hasAnyTokens = true;
      }
      if (usage.cache_write_tokens !== undefined) {
        cacheCreationTokens += usage.cache_write_tokens;
        hasAnyTokens = true;
      }
      if (usage.ephemeral_5m_input_tokens !== undefined) {
        cacheCreation5mTokens += usage.ephemeral_5m_input_tokens;
        hasAnyTokens = true;
      }
      if (usage.ephemeral_1h_input_tokens !== undefined) {
        cacheCreation1hTokens += usage.ephemeral_1h_input_tokens;
        hasAnyTokens = true;
      }
      if (usage.cost !== undefined) {
        lastUpstreamCost = usage.cost;
        hasAnyTokens = true;
      }

      if (usage.prompt_token_count !== undefined) {
        inputTokens += usage.prompt_token_count;
        hasInputTokens = true;
        hasAnyTokens = true;
      }
      if (usage.candidates_token_count !== undefined) {
        completionTokens += usage.candidates_token_count;
        hasAnyTokens = true;
      }
      if (usage.cached_content_token_count !== undefined) {
        googleCachedTokens += usage.cached_content_token_count;
        hasAnyTokens = true;
      }
      if (usage.thoughts_token_count !== undefined) {
        reasoningTokens += usage.thoughts_token_count;
        hasAnyTokens = true;
      }
      if (usage.total_token_count !== undefined) {
        // Google sends cumulative totals — last wins, not summed.
        googleTotalTokenCount = usage.total_token_count;
        hasAnyTokens = true;
      }
    },

    acceptThinkingChars(chars) {
      thinkingChars += chars;
    },

    finalize() {
      if (!hasAnyTokens && thinkingChars === 0) return undefined;

      // Use locals so finalize() doesn't mutate the accumulator — repeated calls
      // must return the same value, and a future caller might call this twice.
      let finalCacheCreation = cacheCreationTokens;
      if (finalCacheCreation === 0 && (cacheCreation5mTokens > 0 || cacheCreation1hTokens > 0)) {
        finalCacheCreation = cacheCreation5mTokens + cacheCreation1hTokens;
      }

      const finalCacheRead = cacheReadTokens + googleCachedTokens;

      const result: LLMTokenUsage = {};

      let promptTokens: number | undefined;
      if (hasInputTokens) {
        promptTokens = schema.promptIncludesCache
          ? inputTokens
          : inputTokens + finalCacheRead + finalCacheCreation;
      }

      if (promptTokens !== undefined && promptTokens > 0) {
        result.promptTokens = promptTokens;
        result.uncachedInputTokens = schema.promptIncludesCache
          ? Math.max(0, inputTokens - finalCacheRead - finalCacheCreation)
          : inputTokens;
      }

      if (completionTokens > 0) result.completionTokens = completionTokens;
      if (finalCacheRead > 0) result.cacheReadTokens = finalCacheRead;
      if (finalCacheCreation > 0) result.cacheCreationTokens = finalCacheCreation;
      if (cacheCreation5mTokens > 0) result.cacheCreation5mTokens = cacheCreation5mTokens;
      if (cacheCreation1hTokens > 0) result.cacheCreation1hTokens = cacheCreation1hTokens;

      if (reasoningTokens > 0) {
        result.reasoningTokens = reasoningTokens;
      } else if (thinkingChars > 0) {
        // Anthropic thinking estimate: ~4 chars per token.
        result.reasoningTokens = Math.ceil(thinkingChars / 4);
      }

      if (lastUpstreamCost !== undefined) result.upstreamCost = lastUpstreamCost;

      if (googleTotalTokenCount !== undefined && googleTotalTokenCount > 0) {
        result.totalTokens = googleTotalTokenCount;
      } else if (result.promptTokens !== undefined && result.completionTokens !== undefined) {
        result.totalTokens = result.promptTokens + result.completionTokens;
      }

      return result;
    },
  };
}
