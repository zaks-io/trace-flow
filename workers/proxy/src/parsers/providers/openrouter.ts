import type { LLMTokenUsage } from '@trace-flow/types';

/**
 * OpenRouter uses OpenAI-compatible format with additional fields:
 * - `cache_write_tokens` in prompt_tokens_details
 * - `cost` in usage object
 */
export function parseOpenRouterTokens(body: string): LLMTokenUsage | undefined {
  const promptMatch = /"prompt_tokens"\s*:\s*(\d+)/.exec(body);
  const completionMatch = /"completion_tokens"\s*:\s*(\d+)/.exec(body);
  const totalMatch = /"total_tokens"\s*:\s*(\d+)/.exec(body);

  if (!promptMatch && !completionMatch && !totalMatch) {
    return undefined;
  }

  const result: LLMTokenUsage = {};

  if (promptMatch?.[1]) result.promptTokens = parseInt(promptMatch[1], 10);
  if (completionMatch?.[1]) result.completionTokens = parseInt(completionMatch[1], 10);
  if (totalMatch?.[1]) result.totalTokens = parseInt(totalMatch[1], 10);

  const cachedMatch = /"cached_tokens"\s*:\s*(\d+)/.exec(body);
  if (cachedMatch?.[1]) result.cacheReadTokens = parseInt(cachedMatch[1], 10);

  const cacheWriteMatch = /"cache_write_tokens"\s*:\s*(\d+)/.exec(body);
  if (cacheWriteMatch?.[1]) result.cacheCreationTokens = parseInt(cacheWriteMatch[1], 10);

  const reasoningMatch = /"reasoning_tokens"\s*:\s*(\d+)/.exec(body);
  if (reasoningMatch?.[1]) result.reasoningTokens = parseInt(reasoningMatch[1], 10);

  const costMatch = /"cost"\s*:\s*([0-9.]+)/.exec(body);
  if (costMatch?.[1]) result.upstreamCost = parseFloat(costMatch[1]);

  return result;
}
