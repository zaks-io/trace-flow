import type { LLMTokenUsage } from '@trace-flow/types';

/**
 * Extracts token usage from LLM response bodies using regex.
 * Avoids parsing large JSON objects by using regex patterns to extract only the fields we need.
 *
 * Detects prompt caching by checking for `cached_tokens` in `prompt_tokens_details`.
 * This is an OpenAI-specific field that indicates partial cache hits during prompt processing.
 *
 * Returns undefined if the response doesn't contain valid usage data (non-error responses may lack usage).
 */
export function parseTokenUsage(responseBody: string): LLMTokenUsage | undefined {
  // Use regex to extract all token fields without parsing the entire JSON
  const promptTokensMatch = /"prompt_tokens"\s*:\s*(\d+)/.exec(responseBody);
  const completionTokensMatch = /"completion_tokens"\s*:\s*(\d+)/.exec(responseBody);
  const totalTokensMatch = /"total_tokens"\s*:\s*(\d+)/.exec(responseBody);
  const cachedTokensMatch = /"cached_tokens"\s*:\s*(\d+)/.exec(responseBody);
  const reasoningTokensMatch = /"reasoning_tokens"\s*:\s*(\d+)/.exec(responseBody);

  // If no token fields found, return undefined
  if (
    !promptTokensMatch &&
    !completionTokensMatch &&
    !totalTokensMatch &&
    !cachedTokensMatch &&
    !reasoningTokensMatch
  ) {
    return undefined;
  }

  const promptTokens = promptTokensMatch?.[1] ? parseInt(promptTokensMatch[1], 10) : undefined;
  const completionTokens = completionTokensMatch?.[1]
    ? parseInt(completionTokensMatch[1], 10)
    : undefined;
  const totalTokens = totalTokensMatch?.[1] ? parseInt(totalTokensMatch[1], 10) : undefined;
  const cached = cachedTokensMatch?.[1] ? parseInt(cachedTokensMatch[1], 10) > 0 : undefined;
  const reasoningTokens = reasoningTokensMatch?.[1]
    ? parseInt(reasoningTokensMatch[1], 10)
    : undefined;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cached,
    reasoningTokens,
  };
}
