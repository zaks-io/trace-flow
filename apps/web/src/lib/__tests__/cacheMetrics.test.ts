import { describe, it, expect } from 'vitest';
import {
  calculateCacheHitRate,
  calculateCacheWriteRate,
  calculateUncachedInputTokens,
  formatCacheHitRate,
  getCacheHitRateAccent,
  getPromptCacheMetrics,
} from '../cacheMetrics';

describe('calculateCacheHitRate', () => {
  it('should return null when no cache activity', () => {
    expect(calculateCacheHitRate(0, 0, 1000)).toBeNull();
  });

  it('should return null when totalInputTokens is 0', () => {
    expect(calculateCacheHitRate(100, 0, 0)).toBeNull();
  });

  it('should calculate correct rate for real Anthropic example', () => {
    // input_tokens=972, cache_read=2236 → promptTokens=3208
    const rate = calculateCacheHitRate(2236, 0, 3208);
    expect(rate).toBeCloseTo(69.7, 0);
  });

  it('should calculate 100% for full cache hit', () => {
    const rate = calculateCacheHitRate(1000, 0, 1000);
    expect(rate).toBe(100);
  });

  it('should calculate 0% for cache warming (only creation, no reads)', () => {
    const rate = calculateCacheHitRate(0, 500, 500);
    expect(rate).toBe(0);
  });

  it('should handle mixed cache read and creation', () => {
    const rate = calculateCacheHitRate(500, 200, 1000);
    expect(rate).toBe(50);
  });

  it('should clamp to 100% when cacheReadTokens exceeds totalInputTokens', () => {
    const rate = calculateCacheHitRate(1500, 0, 1000);
    expect(rate).toBe(100);
  });
});

describe('formatCacheHitRate', () => {
  it('should return dash for null', () => {
    expect(formatCacheHitRate(null)).toBe('-');
  });

  it('should show 1 decimal place for normal rates', () => {
    expect(formatCacheHitRate(69.7)).toBe('69.7%');
  });

  it('should show 2 decimal places for very high rates', () => {
    expect(formatCacheHitRate(99.99)).toBe('99.99%');
  });
});

describe('calculateCacheWriteRate', () => {
  it('should return null when no cache writes', () => {
    expect(calculateCacheWriteRate(0, 0, 1000)).toBeNull();
  });

  it('should return null when reads-only (no writes)', () => {
    expect(calculateCacheWriteRate(500, 0, 1000)).toBeNull();
  });

  it('should return null when totalInputTokens is 0', () => {
    expect(calculateCacheWriteRate(0, 100, 0)).toBeNull();
  });

  it('should calculate write rate from total prompt tokens', () => {
    expect(calculateCacheWriteRate(500, 200, 1000)).toBe(20);
  });

  it('should calculate 100% write rate during pure warmup', () => {
    expect(calculateCacheWriteRate(0, 1000, 1000)).toBe(100);
  });
});

describe('calculateUncachedInputTokens', () => {
  it('should prefer explicit uncached input tokens when present', () => {
    expect(calculateUncachedInputTokens(1000, 500, 200, 300)).toBe(300);
  });

  it('should derive uncached input tokens from prompt total when not present', () => {
    expect(calculateUncachedInputTokens(1000, 500, 200)).toBe(300);
  });
});

describe('getPromptCacheMetrics', () => {
  it('should build canonical prompt cache metrics', () => {
    expect(
      getPromptCacheMetrics({
        promptTotalTokens: 1000,
        uncachedInputTokens: 300,
        cacheReadTokens: 500,
        cacheCreationTokens: 200,
        inputCostUsd: 0.0009,
        cacheReadCostUsd: 0.00015,
        cacheWriteCostUsd: 0.00075,
        promptBaselineCostUsd: 0.003,
        cacheImpactCostUsd: 0.0012,
      }),
    ).toEqual({
      hasCacheActivity: true,
      promptTotalTokens: 1000,
      uncachedInputTokens: 300,
      cacheReadTokens: 500,
      cacheCreationTokens: 200,
      cacheHitRate: 50,
      cacheWriteRate: 20,
      promptCostActualUsd: 0.0018,
      promptBaselineCostUsd: 0.003,
      cacheImpactCostUsd: 0.0012,
    });
  });

  it('should handle no cache activity (all uncached)', () => {
    const metrics = getPromptCacheMetrics({
      promptTotalTokens: 1000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(metrics.hasCacheActivity).toBe(false);
    expect(metrics.uncachedInputTokens).toBe(1000);
    expect(metrics.cacheHitRate).toBeNull();
    expect(metrics.cacheWriteRate).toBeNull();
  });

  it('should handle reads-only (no writes)', () => {
    const metrics = getPromptCacheMetrics({
      promptTotalTokens: 1000,
      uncachedInputTokens: 200,
      cacheReadTokens: 800,
      cacheCreationTokens: 0,
    });
    expect(metrics.hasCacheActivity).toBe(true);
    expect(metrics.cacheHitRate).toBe(80);
    expect(metrics.cacheWriteRate).toBeNull();
  });

  it('should handle writes-only (cache warmup)', () => {
    const metrics = getPromptCacheMetrics({
      promptTotalTokens: 1000,
      uncachedInputTokens: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 800,
    });
    expect(metrics.hasCacheActivity).toBe(true);
    expect(metrics.cacheHitRate).toBe(0);
    expect(metrics.cacheWriteRate).toBe(80);
  });
});

describe('getCacheHitRateAccent', () => {
  it('should return zinc for null', () => {
    expect(getCacheHitRateAccent(null)).toBe('zinc');
  });

  it('should return green for high rates', () => {
    expect(getCacheHitRateAccent(85)).toBe('green');
  });

  it('should return amber for medium rates', () => {
    expect(getCacheHitRateAccent(60)).toBe('amber');
  });

  it('should return red for low rates', () => {
    expect(getCacheHitRateAccent(30)).toBe('red');
  });
});
