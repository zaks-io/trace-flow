import { describe, it, expect } from 'vitest';
import { calculateCacheHitRate, formatCacheHitRate, getCacheHitRateAccent } from '../cacheMetrics';

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
