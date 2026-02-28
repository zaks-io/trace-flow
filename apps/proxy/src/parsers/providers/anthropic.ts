import type { LLMTokenUsage } from '@trace-flow/types';

/**
 * Anthropic's `input_tokens` excludes cached tokens, unlike OpenAI where `prompt_tokens` is the total.
 * We normalize: promptTokens = input_tokens + cache_read_input_tokens (total input).
 */
export function parseAnthropicTokens(body: string): LLMTokenUsage | undefined {
  const inputMatch = /"input_tokens"\s*:\s*(\d+)/.exec(body);
  const outputMatch = /"output_tokens"\s*:\s*(\d+)/.exec(body);

  if (!inputMatch && !outputMatch) {
    return undefined;
  }

  const inputTokens = inputMatch?.[1] ? parseInt(inputMatch[1], 10) : undefined;
  const outputTokens = outputMatch?.[1] ? parseInt(outputMatch[1], 10) : undefined;

  const cacheCreationMatch = /"cache_creation_input_tokens"\s*:\s*(\d+)/.exec(body);
  const cacheReadMatch = /"cache_read_input_tokens"\s*:\s*(\d+)/.exec(body);

  const cacheCreationTokens = cacheCreationMatch?.[1]
    ? parseInt(cacheCreationMatch[1], 10)
    : undefined;
  const cacheReadTokens = cacheReadMatch?.[1] ? parseInt(cacheReadMatch[1], 10) : undefined;

  // Extract nested cache_creation breakdown (5m vs 1h tiers)
  const ephemeral5mMatch = /"ephemeral_5m_input_tokens"\s*:\s*(\d+)/.exec(body);
  const ephemeral1hMatch = /"ephemeral_1h_input_tokens"\s*:\s*(\d+)/.exec(body);

  const cacheCreation5mTokens = ephemeral5mMatch?.[1]
    ? parseInt(ephemeral5mMatch[1], 10)
    : undefined;
  const cacheCreation1hTokens = ephemeral1hMatch?.[1]
    ? parseInt(ephemeral1hMatch[1], 10)
    : undefined;

  // Normalize: promptTokens = input_tokens + cache_read_input_tokens (total input)
  const promptTokens = inputTokens !== undefined ? inputTokens + (cacheReadTokens ?? 0) : undefined;

  const result: LLMTokenUsage = {};

  if (promptTokens !== undefined) result.promptTokens = promptTokens;
  if (outputTokens !== undefined) result.completionTokens = outputTokens;
  if (cacheReadTokens !== undefined) result.cacheReadTokens = cacheReadTokens;
  if (cacheCreationTokens !== undefined) {
    result.cacheCreationTokens = cacheCreationTokens;
  } else if (cacheCreation5mTokens !== undefined || cacheCreation1hTokens !== undefined) {
    result.cacheCreationTokens = (cacheCreation5mTokens ?? 0) + (cacheCreation1hTokens ?? 0);
  }
  if (cacheCreation5mTokens !== undefined) result.cacheCreation5mTokens = cacheCreation5mTokens;
  if (cacheCreation1hTokens !== undefined) result.cacheCreation1hTokens = cacheCreation1hTokens;

  // Calculate total if we have both
  if (result.promptTokens !== undefined && result.completionTokens !== undefined) {
    result.totalTokens = result.promptTokens + result.completionTokens;
  }

  return result;
}
