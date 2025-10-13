import type { LLMTokenUsage } from '@observe/types';

/**
 * Extracts token usage from LLM response bodies.
 * Assumes OpenAI-compatible response format with a `usage` object at the root level.
 *
 * Detects prompt caching by checking for `cached_tokens` in `prompt_tokens_details`.
 * This is an OpenAI-specific field that indicates partial cache hits during prompt processing.
 *
 * Returns undefined if the response doesn't contain valid usage data (non-error responses may lack usage).
 */
export function parseTokenUsage(responseBody: string): LLMTokenUsage | undefined {
  try {
    const parsed = JSON.parse(responseBody) as unknown;

    if (
      parsed &&
      typeof parsed === 'object' &&
      'usage' in parsed &&
      parsed.usage &&
      typeof parsed.usage === 'object'
    ) {
      const usage = parsed.usage as Record<string, unknown>;

      let cached: boolean | undefined;
      if (usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object') {
        const details = usage.prompt_tokens_details as Record<string, unknown>;
        if ('cached_tokens' in details && typeof details.cached_tokens === 'number') {
          cached = details.cached_tokens > 0;
        }
      }

      return {
        promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
        completionTokens:
          typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
        totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
        cached,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
