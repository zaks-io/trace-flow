import { describe, expect, it } from 'vitest';
import {
  getAggregateCacheHitRate,
  getCostPerRequest,
  getLeaderboardSortValue,
} from '../operations';

describe('getAggregateCacheHitRate', () => {
  it('prefers the precomputed cache hit rate when present', () => {
    expect(
      getAggregateCacheHitRate({
        cache_hit_rate: 91.2,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
        input_tokens: 100,
        request_count: 4,
        total_cost_usd: 2,
      }),
    ).toBe(91.2);
  });

  it('falls back to token math when cache_hit_rate is null', () => {
    expect(
      getAggregateCacheHitRate({
        cache_hit_rate: null,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
        input_tokens: 200,
        request_count: 4,
        total_cost_usd: 2,
      }),
    ).toBe(40);
  });

  it('falls back to aggregate token math when cache hit rate is omitted', () => {
    expect(
      getAggregateCacheHitRate({
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
        input_tokens: 200,
        request_count: 4,
        total_cost_usd: 2,
      }),
    ).toBe(40);
  });

  it('returns null when there is no cache activity', () => {
    expect(
      getAggregateCacheHitRate({
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        input_tokens: 200,
        request_count: 4,
        total_cost_usd: 2,
      }),
    ).toBeNull();
  });
});

describe('getCostPerRequest', () => {
  it('prefers the precomputed value when present', () => {
    expect(
      getCostPerRequest({
        cost_per_request_usd: 0.125,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        input_tokens: 0,
        request_count: 10,
        total_cost_usd: 5,
      }),
    ).toBe(0.125);
  });

  it('computes cost per request from totals when omitted', () => {
    expect(
      getCostPerRequest({
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        input_tokens: 0,
        request_count: 8,
        total_cost_usd: 4,
      }),
    ).toBe(0.5);
  });

  it('returns null when request count is zero', () => {
    expect(
      getCostPerRequest({
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        input_tokens: 0,
        request_count: 0,
        total_cost_usd: 4,
      }),
    ).toBeNull();
  });
});

const baseRow = {
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  input_tokens: 0,
  request_count: 10,
  total_cost_usd: 5,
  unique_user_count: 3,
  cost_per_user_usd: 1.5,
  avg_duration_ms: 200,
  p95_duration_ms: 500,
} as const;

describe('getLeaderboardSortValue', () => {
  it('returns direct field values', () => {
    expect(getLeaderboardSortValue(baseRow, 'total_cost_usd')).toBe(5);
    expect(getLeaderboardSortValue(baseRow, 'request_count')).toBe(10);
  });

  it('returns precomputed cost per request when present', () => {
    expect(
      getLeaderboardSortValue({ ...baseRow, cost_per_request_usd: 0.25 }, 'cost_per_request'),
    ).toBe(0.25);
  });

  it('computes cost per request from totals when omitted', () => {
    expect(getLeaderboardSortValue(baseRow, 'cost_per_request')).toBe(0.5);
  });

  it('returns 0 for null cache hit rate', () => {
    expect(
      getLeaderboardSortValue(
        {
          ...baseRow,
          cache_hit_rate: null,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          input_tokens: 200,
        },
        'cache_hit_rate',
      ),
    ).toBe(0);
  });
});
