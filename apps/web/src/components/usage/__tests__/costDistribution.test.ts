import { describe, expect, it } from 'vitest';
import {
  MIN_REQUESTS,
  buildCostBuckets,
  buildLorenzPoints,
  classifyCostShape,
  costShapeGloss,
} from '../costDistribution';
import type { RequestStatsRow } from '../types';

function makeRow(overrides: Partial<RequestStatsRow> = {}): RequestStatsRow {
  return {
    request_count: 100,
    total_cost_usd: 10,
    cost_min: 0,
    cost_p25: 0.01,
    cost_p50: 0.02,
    cost_p75: 0.05,
    cost_p95: 0.4,
    cost_p99: 2,
    cost_max: 4,
    duration_min: 100,
    duration_p25: 200,
    duration_p50: 300,
    duration_p75: 500,
    duration_p95: 2000,
    duration_p99: 5000,
    duration_max: 8000,
    gini: 0.5,
    half_spend_request_count: 10,
    lorenz_request_pct: [0, 0.5, 1],
    lorenz_cost_pct: [0, 0.2, 1],
    cost_bucket_lo: [0.01, 0.05],
    cost_bucket_hi: [0.05, 4],
    cost_bucket_count: [80, 20],
    cost_bucket_sum: [2, 8],
    ...overrides,
  };
}

describe('classifyCostShape', () => {
  it('returns insufficient below the minimum request count regardless of gini', () => {
    expect(classifyCostShape(makeRow({ request_count: MIN_REQUESTS - 1, gini: 0.9 }))).toBe(
      'insufficient',
    );
  });

  it('classifies a low-gini slice as uniform', () => {
    expect(classifyCostShape(makeRow({ gini: 0.1 }))).toBe('uniform');
  });

  it('classifies a mid-gini slice as moderate', () => {
    expect(classifyCostShape(makeRow({ gini: 0.45 }))).toBe('moderate');
  });

  it('classifies a high-gini slice as fat-tailed', () => {
    expect(classifyCostShape(makeRow({ gini: 0.98 }))).toBe('fat-tailed');
  });
});

describe('costShapeGloss', () => {
  it('names the request count when insufficient', () => {
    expect(costShapeGloss(makeRow({ request_count: 5, gini: 0.9 }))).toContain('5');
  });

  it('points at the per-call cost lever when uniform', () => {
    expect(costShapeGloss(makeRow({ gini: 0.1 }))).toMatch(/prompt or model/i);
  });

  it('points at the outliers and names the half-spend count when fat-tailed', () => {
    const gloss = costShapeGloss(makeRow({ gini: 0.95, half_spend_request_count: 3 }));
    expect(gloss).toMatch(/outliers/i);
    expect(gloss).toContain('3');
  });
});

describe('buildCostBuckets', () => {
  it('zips the parallel bucket arrays into bars', () => {
    const bars = buildCostBuckets(makeRow());
    expect(bars).toHaveLength(2);
    expect(bars[1]).toMatchObject({ lo: 0.05, hi: 4, count: 20, sum: 8 });
  });

  it('returns empty when there are no buckets', () => {
    expect(buildCostBuckets(makeRow({ cost_bucket_lo: [] }))).toEqual([]);
  });
});

describe('buildLorenzPoints', () => {
  it('pairs request share with cost share', () => {
    expect(buildLorenzPoints(makeRow())).toEqual([
      { requestPct: 0, costPct: 0 },
      { requestPct: 0.5, costPct: 0.2 },
      { requestPct: 1, costPct: 1 },
    ]);
  });
});
