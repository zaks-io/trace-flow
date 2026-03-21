export function getCurrentTimestamp(): number {
  return Date.now();
}

export function computePeriod(now: Date): { periodStart: number; periodEnd: number } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { periodStart: start.getTime(), periodEnd: end.getTime() };
}

/**
 * Estimate token count using character count heuristic.
 * ~4 characters per token for English text is a reasonable approximation.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
