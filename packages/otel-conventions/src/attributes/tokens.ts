import type { LLMTokenUsage } from '@trace-flow/types';
import { GEN_AI_USAGE } from '../keys';

/**
 * Token-usage attributes per OTel GenAI conventions. Skips fields the upstream
 * did not report (undefined); preserves explicit zero values as a real signal.
 */
export function tokenAttributes(tokens: LLMTokenUsage): Record<string, string> {
  const out: Record<string, string> = {};
  if (tokens.promptTokens !== undefined) {
    out[GEN_AI_USAGE.INPUT_TOKENS] = String(tokens.promptTokens);
  }
  if (tokens.uncachedInputTokens !== undefined) {
    out[GEN_AI_USAGE.INPUT_TOKENS_UNCACHED] = String(tokens.uncachedInputTokens);
  }
  if (tokens.completionTokens !== undefined) {
    out[GEN_AI_USAGE.OUTPUT_TOKENS] = String(tokens.completionTokens);
  }
  if (tokens.reasoningTokens !== undefined) {
    out[GEN_AI_USAGE.REASONING_TOKENS] = String(tokens.reasoningTokens);
  }
  if (tokens.cacheReadTokens !== undefined) {
    out[GEN_AI_USAGE.CACHE_READ_INPUT_TOKENS] = String(tokens.cacheReadTokens);
  }
  if (tokens.cacheCreationTokens !== undefined) {
    out[GEN_AI_USAGE.CACHE_CREATION_INPUT_TOKENS] = String(tokens.cacheCreationTokens);
  }
  if (tokens.cacheCreation5mTokens !== undefined) {
    out[GEN_AI_USAGE.CACHE_CREATION_5M_INPUT_TOKENS] = String(tokens.cacheCreation5mTokens);
  }
  if (tokens.cacheCreation1hTokens !== undefined) {
    out[GEN_AI_USAGE.CACHE_CREATION_1H_INPUT_TOKENS] = String(tokens.cacheCreation1hTokens);
  }
  return out;
}
