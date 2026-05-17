import type { LLMTokenUsage } from '@trace-flow/types';
import { PROVIDER_SCHEMAS } from './schemas';
import type { ProviderId, RawTokenUsage } from './types';
import { applyTokenSchema, type RawTokenTotals } from './applyTokenSchema';

function addTo(current: number | undefined, addend: number): number {
  return (current ?? 0) + addend;
}

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
 * SSE-friendly token accumulator. Sums raw fields across events into a
 * `RawTokenTotals`, then defers to `applyTokenSchema` at `finalize()` — the same
 * normalizer the whole-body extractor uses, so the two paths can't drift.
 *
 * Zero is preserved as a real signal: `{ output_tokens: 0 }` from a refused
 * response flows through to `result.completionTokens = 0` rather than being
 * dropped. `undefined` still means "never observed."
 */
export function createTokenAccumulator(providerId: ProviderId): TokenAccumulator {
  const schema = PROVIDER_SCHEMAS[providerId];
  const raw: RawTokenTotals = {};

  return {
    acceptEvent(usage) {
      // OpenAI/Anthropic/OpenRouter shape — input/output.
      if (usage.input_tokens !== undefined) {
        raw.inputTokens = addTo(raw.inputTokens, usage.input_tokens);
      }
      if (usage.output_tokens !== undefined) {
        raw.completionTokens = addTo(raw.completionTokens, usage.output_tokens);
      }
      if (usage.reasoning_tokens !== undefined) {
        raw.reasoningTokens = addTo(raw.reasoningTokens, usage.reasoning_tokens);
      }
      if (usage.cache_read_input_tokens !== undefined) {
        raw.cacheReadTokens = addTo(raw.cacheReadTokens, usage.cache_read_input_tokens);
      }
      if (usage.cached_tokens !== undefined) {
        // OpenAI/OpenRouter: same conceptual quantity as Anthropic's cache_read_input_tokens.
        // Bridging proxies that emit both would double-count; no real upstream does.
        raw.cacheReadTokens = addTo(raw.cacheReadTokens, usage.cached_tokens);
      }
      if (usage.cache_creation_input_tokens !== undefined) {
        raw.cacheCreationTokens = addTo(raw.cacheCreationTokens, usage.cache_creation_input_tokens);
      }
      if (usage.cache_write_tokens !== undefined) {
        raw.cacheCreationTokens = addTo(raw.cacheCreationTokens, usage.cache_write_tokens);
      }
      if (usage.ephemeral_5m_input_tokens !== undefined) {
        raw.cacheCreation5mTokens = addTo(
          raw.cacheCreation5mTokens,
          usage.ephemeral_5m_input_tokens,
        );
      }
      if (usage.ephemeral_1h_input_tokens !== undefined) {
        raw.cacheCreation1hTokens = addTo(
          raw.cacheCreation1hTokens,
          usage.ephemeral_1h_input_tokens,
        );
      }
      if (usage.cost !== undefined) {
        // Last cost wins; OpenRouter emits a single cost on the final usage event.
        raw.upstreamCost = usage.cost;
      }

      // Google shape — same conceptual quantities, different keys. Sum into the same fields.
      if (usage.prompt_token_count !== undefined) {
        raw.inputTokens = addTo(raw.inputTokens, usage.prompt_token_count);
      }
      if (usage.candidates_token_count !== undefined) {
        raw.completionTokens = addTo(raw.completionTokens, usage.candidates_token_count);
      }
      if (usage.cached_content_token_count !== undefined) {
        // Google's cached_content_token_count maps to cache_read_input_tokens.
        raw.cacheReadTokens = addTo(raw.cacheReadTokens, usage.cached_content_token_count);
      }
      if (usage.thoughts_token_count !== undefined) {
        raw.reasoningTokens = addTo(raw.reasoningTokens, usage.thoughts_token_count);
      }
      if (usage.total_token_count !== undefined) {
        // Google sends cumulative totals — last wins, not summed.
        raw.explicitTotal = usage.total_token_count;
      }
    },

    acceptThinkingChars(chars) {
      if (chars <= 0) return;
      raw.thinkingChars = addTo(raw.thinkingChars, chars);
    },

    finalize() {
      return applyTokenSchema(raw, schema);
    },
  };
}
