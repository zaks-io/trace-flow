import type { LLMTokenUsage } from '@trace-flow/types';

/**
 * Groq uses OpenAI-compatible format.
 * `prompt_tokens` already includes cached tokens (total input).
 */
export function parseGroqTokens(body: string): LLMTokenUsage | undefined {
  const promptMatch = /"prompt_tokens"\s*:\s*(\d+)/.exec(body);
  const completionMatch = /"completion_tokens"\s*:\s*(\d+)/.exec(body);
  const totalMatch = /"total_tokens"\s*:\s*(\d+)/.exec(body);

  if (!promptMatch && !completionMatch && !totalMatch) {
    return undefined;
  }

  const result: LLMTokenUsage = {};

  if (promptMatch?.[1]) result.promptTokens = parseInt(promptMatch[1], 10);
  if (result.promptTokens !== undefined) result.uncachedInputTokens = result.promptTokens;
  if (completionMatch?.[1]) result.completionTokens = parseInt(completionMatch[1], 10);
  if (totalMatch?.[1]) result.totalTokens = parseInt(totalMatch[1], 10);

  const reasoningMatch = /"reasoning_tokens"\s*:\s*(\d+)/.exec(body);
  if (reasoningMatch?.[1]) result.reasoningTokens = parseInt(reasoningMatch[1], 10);

  return result;
}
