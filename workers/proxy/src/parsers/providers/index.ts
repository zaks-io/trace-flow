import type { LLMTokenUsage } from '@trace-flow/types';
import { parseAnthropicTokens } from './anthropic';
import { parseOpenAITokens } from './openai';
import { parseOpenRouterTokens } from './openrouter';
import { parseGoogleTokens } from './google';
import { parseGroqTokens } from './groq';

/**
 * Auto-detect fallback that tries all parsers. Preserves backward compat
 * for cases where provider isn't passed. Prefers OpenAI-style, then Anthropic, then Google.
 *
 * Note: Anthropic normalization (adding cache_read to input) fires here, so a non-Anthropic
 * response with `input_tokens` + `cache_read_input_tokens` fields would get that normalization
 * applied incorrectly. This is low risk because the auto-detect path only triggers when
 * provider is undefined, which shouldn't happen in the normal proxy flow.
 */
function parseAutoDetect(body: string): LLMTokenUsage | undefined {
  // Try OpenRouter first (superset of OpenAI — has cost field)
  const openRouterResult = parseOpenRouterTokens(body);
  if (openRouterResult) return openRouterResult;

  // Try Anthropic
  const anthropicResult = parseAnthropicTokens(body);
  if (anthropicResult) return anthropicResult;

  // Try Google
  const googleResult = parseGoogleTokens(body);
  if (googleResult) return googleResult;

  return undefined;
}

export function parseTokenUsage(body: string, provider?: string): LLMTokenUsage | undefined {
  switch (provider) {
    case 'anthropic':
      return parseAnthropicTokens(body);
    case 'openai':
      return parseOpenAITokens(body);
    case 'openrouter':
      return parseOpenRouterTokens(body);
    case 'google':
      return parseGoogleTokens(body);
    case 'groq':
      return parseGroqTokens(body);
    default:
      return parseAutoDetect(body);
  }
}
