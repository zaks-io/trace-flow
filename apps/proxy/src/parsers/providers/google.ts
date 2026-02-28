import type { LLMTokenUsage } from '@trace-flow/types';

// Google sends cumulative usageMetadata in every streaming chunk.
// When this runs on raw SSE text (fallback), we need the LAST occurrence
// (final totals), not the first (which may have candidatesTokenCount: 0).
function lastMatch(pattern: RegExp, body: string): RegExpExecArray | null {
  const global = new RegExp(pattern.source, 'g');
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = global.exec(body)) !== null) last = m;
  return last;
}

/**
 * Google uses camelCase fields in `usageMetadata`.
 * `promptTokenCount` already includes cached tokens (total input).
 */
export function parseGoogleTokens(body: string): LLMTokenUsage | undefined {
  const promptMatch = lastMatch(/"promptTokenCount"\s*:\s*(\d+)/, body);
  const candidatesMatch = lastMatch(/"candidatesTokenCount"\s*:\s*(\d+)/, body);
  const totalMatch = lastMatch(/"totalTokenCount"\s*:\s*(\d+)/, body);

  if (!promptMatch && !candidatesMatch && !totalMatch) {
    return undefined;
  }

  const result: LLMTokenUsage = {};

  if (promptMatch?.[1]) result.promptTokens = parseInt(promptMatch[1], 10);
  if (candidatesMatch?.[1]) result.completionTokens = parseInt(candidatesMatch[1], 10);
  if (totalMatch?.[1]) result.totalTokens = parseInt(totalMatch[1], 10);

  const cachedMatch = lastMatch(/"cachedContentTokenCount"\s*:\s*(\d+)/, body);
  if (cachedMatch?.[1]) result.cacheReadTokens = parseInt(cachedMatch[1], 10);

  const thoughtsMatch = lastMatch(/"thoughtsTokenCount"\s*:\s*(\d+)/, body);
  if (thoughtsMatch?.[1]) result.reasoningTokens = parseInt(thoughtsMatch[1], 10);

  return result;
}
