import type { LLMTokenUsage } from '@trace-flow/types';

/**
 * Google uses camelCase fields in `usageMetadata`.
 * `promptTokenCount` already includes cached tokens (total input).
 */
export function parseGoogleTokens(body: string): LLMTokenUsage | undefined {
  const promptMatch = /"promptTokenCount"\s*:\s*(\d+)/.exec(body);
  const candidatesMatch = /"candidatesTokenCount"\s*:\s*(\d+)/.exec(body);
  const totalMatch = /"totalTokenCount"\s*:\s*(\d+)/.exec(body);

  if (!promptMatch && !candidatesMatch && !totalMatch) {
    return undefined;
  }

  const result: LLMTokenUsage = {};

  if (promptMatch?.[1]) result.promptTokens = parseInt(promptMatch[1], 10);
  if (candidatesMatch?.[1]) result.completionTokens = parseInt(candidatesMatch[1], 10);
  if (totalMatch?.[1]) result.totalTokens = parseInt(totalMatch[1], 10);

  const cachedMatch = /"cachedContentTokenCount"\s*:\s*(\d+)/.exec(body);
  if (cachedMatch?.[1]) result.cacheReadTokens = parseInt(cachedMatch[1], 10);

  return result;
}
