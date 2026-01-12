/**
 * Calculates cache hit rate from cache token metrics.
 *
 * Formula: (cache_read_tokens / (cache_read_tokens + cache_creation_tokens)) × 100
 *
 * Returns null if there's no caching activity (both values are 0).
 */
export function calculateCacheHitRate(
  cacheReadTokens: number,
  cacheCreationTokens: number,
): number | null {
  // No caching activity
  if (cacheReadTokens === 0 && cacheCreationTokens === 0) {
    return null;
  }

  const totalCacheableTokens = cacheReadTokens + cacheCreationTokens;

  // Edge case: avoid division by zero
  if (totalCacheableTokens === 0) {
    return null;
  }

  return (cacheReadTokens / totalCacheableTokens) * 100;
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
