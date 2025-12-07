import type { LLMTokenUsage } from '@trace-flow/types';

/**
 * Extracts token usage from LLM response bodies using regex.
 * Avoids parsing large JSON objects by using regex patterns to extract only the fields we need.
 *
 * Supports both OpenAI-style and Anthropic-style token formats:
 * - OpenAI: prompt_tokens, completion_tokens, total_tokens, cached_tokens, reasoning_tokens
 * - Anthropic: input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
 *
 * Returns undefined if the response doesn't contain valid usage data.
 */
export function parseTokenUsage(responseBody: string): LLMTokenUsage | undefined {
  // OpenAI-style patterns
  const promptTokensMatch = /"prompt_tokens"\s*:\s*(\d+)/.exec(responseBody);
  const completionTokensMatch = /"completion_tokens"\s*:\s*(\d+)/.exec(responseBody);
  const totalTokensMatch = /"total_tokens"\s*:\s*(\d+)/.exec(responseBody);
  const cachedTokensMatch = /"cached_tokens"\s*:\s*(\d+)/.exec(responseBody);
  const reasoningTokensMatch = /"reasoning_tokens"\s*:\s*(\d+)/.exec(responseBody);

  // Anthropic-style patterns
  const inputTokensMatch = /"input_tokens"\s*:\s*(\d+)/.exec(responseBody);
  const outputTokensMatch = /"output_tokens"\s*:\s*(\d+)/.exec(responseBody);
  const cacheCreationTokensMatch = /"cache_creation_input_tokens"\s*:\s*(\d+)/.exec(responseBody);
  const cacheReadTokensMatch = /"cache_read_input_tokens"\s*:\s*(\d+)/.exec(responseBody);

  // Check if any token fields were found
  const hasOpenAITokens =
    promptTokensMatch !== null || completionTokensMatch !== null || totalTokensMatch !== null;
  const hasAnthropicTokens = inputTokensMatch !== null || outputTokensMatch !== null;
  const hasCacheTokens =
    cachedTokensMatch !== null ||
    cacheCreationTokensMatch !== null ||
    cacheReadTokensMatch !== null ||
    reasoningTokensMatch !== null;

  if (!hasOpenAITokens && !hasAnthropicTokens && !hasCacheTokens) {
    return undefined;
  }

  // Extract OpenAI-style tokens (also used by Groq, OpenRouter)
  const promptTokens = promptTokensMatch?.[1] ? parseInt(promptTokensMatch[1], 10) : undefined;
  const completionTokens = completionTokensMatch?.[1]
    ? parseInt(completionTokensMatch[1], 10)
    : undefined;
  const totalTokens = totalTokensMatch?.[1] ? parseInt(totalTokensMatch[1], 10) : undefined;
  const cachedTokens = cachedTokensMatch?.[1] ? parseInt(cachedTokensMatch[1], 10) : undefined;
  const reasoningTokens = reasoningTokensMatch?.[1]
    ? parseInt(reasoningTokensMatch[1], 10)
    : undefined;

  // Extract Anthropic-style tokens
  const inputTokens = inputTokensMatch?.[1] ? parseInt(inputTokensMatch[1], 10) : undefined;
  const outputTokens = outputTokensMatch?.[1] ? parseInt(outputTokensMatch[1], 10) : undefined;
  const cacheCreationTokens = cacheCreationTokensMatch?.[1]
    ? parseInt(cacheCreationTokensMatch[1], 10)
    : undefined;
  const cacheReadTokens = cacheReadTokensMatch?.[1]
    ? parseInt(cacheReadTokensMatch[1], 10)
    : undefined;

  // Normalize to unified format - prefer OpenAI-style if both present
  return {
    promptTokens: promptTokens ?? inputTokens,
    completionTokens: completionTokens ?? outputTokens,
    totalTokens,
    reasoningTokens,
    cachedTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
}
