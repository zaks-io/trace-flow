/**
 * Calculates cache hit rate as percentage of total input tokens that were cache reads.
 *
 * Formula: (cacheReadTokens / totalInputTokens) × 100
 *
 * Returns null if there's no caching activity (both read and creation are 0) or no input tokens.
 * cacheCreationTokens is only used to detect whether any caching occurred at all — it does not
 * affect the hit rate formula itself.
 */
export function calculateCacheHitRate(
  cacheReadTokens: number,
  cacheCreationTokens: number,
  totalInputTokens: number,
): number | null {
  // No cache activity at all → null (distinguishes "no caching" from "0% hit rate")
  if (cacheReadTokens === 0 && cacheCreationTokens === 0) {
    return null;
  }

  if (totalInputTokens === 0) {
    return null;
  }

  return Math.min((cacheReadTokens / totalInputTokens) * 100, 100);
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
