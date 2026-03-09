interface PromptCacheMetricsInput {
  promptTotalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  uncachedInputTokens?: number;
  inputCostUsd?: number;
  cacheReadCostUsd?: number;
  cacheWriteCostUsd?: number;
  promptBaselineCostUsd?: number;
  cacheImpactCostUsd?: number;
}

interface PromptCacheMetrics {
  hasCacheActivity: boolean;
  promptTotalTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheHitRate: number | null;
  cacheWriteRate: number | null;
  promptCostActualUsd: number;
  promptBaselineCostUsd: number | null;
  cacheImpactCostUsd: number | null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(value, 100));
}

export function calculateUncachedInputTokens(
  promptTotalTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  explicitUncachedInputTokens?: number,
): number {
  if (explicitUncachedInputTokens !== undefined) {
    return Math.max(0, explicitUncachedInputTokens);
  }

  return Math.max(0, promptTotalTokens - cacheReadTokens - cacheCreationTokens);
}

/**
 * Calculates cache hit rate as the percentage of total prompt-side tokens served from cache reads.
 * Returns null only when there is no cache activity at all (neither reads nor writes).
 * Returns 0 during pure warmup (writes > 0, reads = 0) — 0% is a meaningful signal.
 */
export function calculateCacheHitRate(
  cacheReadTokens: number,
  cacheCreationTokens: number,
  totalInputTokens: number,
): number | null {
  if (cacheReadTokens === 0 && cacheCreationTokens === 0) return null;
  if (totalInputTokens === 0) return null;
  return clampPercent((cacheReadTokens / totalInputTokens) * 100);
}

export function calculateCacheWriteRate(
  cacheReadTokens: number,
  cacheCreationTokens: number,
  totalInputTokens: number,
): number | null {
  if (cacheCreationTokens === 0) return null;
  if (totalInputTokens === 0) return null;
  return clampPercent((cacheCreationTokens / totalInputTokens) * 100);
}

export function getPromptCacheMetrics(input: PromptCacheMetricsInput): PromptCacheMetrics {
  const uncachedInputTokens = calculateUncachedInputTokens(
    input.promptTotalTokens,
    input.cacheReadTokens,
    input.cacheCreationTokens,
    input.uncachedInputTokens,
  );
  const hasCacheActivity = input.cacheReadTokens > 0 || input.cacheCreationTokens > 0;
  const promptCostActualUsd =
    (input.inputCostUsd ?? 0) + (input.cacheReadCostUsd ?? 0) + (input.cacheWriteCostUsd ?? 0);

  return {
    hasCacheActivity,
    promptTotalTokens: input.promptTotalTokens,
    uncachedInputTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheCreationTokens: input.cacheCreationTokens,
    cacheHitRate: calculateCacheHitRate(
      input.cacheReadTokens,
      input.cacheCreationTokens,
      input.promptTotalTokens,
    ),
    cacheWriteRate: calculateCacheWriteRate(
      input.cacheReadTokens,
      input.cacheCreationTokens,
      input.promptTotalTokens,
    ),
    promptCostActualUsd,
    promptBaselineCostUsd: input.promptBaselineCostUsd ?? null,
    cacheImpactCostUsd: input.cacheImpactCostUsd ?? null,
  };
}

/**
 * Formats cache hit rate for display with appropriate precision.
 */
export function formatCacheHitRate(rate: number | null): string {
  if (rate === null) return '-';

  // Show 1 decimal place for values < 99.95%
  if (rate < 99.95) {
    return `${rate.toFixed(1)}%`;
  }

  // Show 2 decimal places for very high hit rates (99.95%+)
  return `${rate.toFixed(2)}%`;
}

/**
 * Returns color accent for cache hit rate based on performance thresholds.
 */
export function getCacheHitRateAccent(rate: number | null): 'green' | 'amber' | 'red' | 'zinc' {
  if (rate === null) return 'zinc';
  if (rate >= 80) return 'green';
  if (rate >= 50) return 'amber';
  return 'red';
}
