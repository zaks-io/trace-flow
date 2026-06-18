import { describe, expect, it } from 'vitest';
import {
  axisLabel,
  buildConcentrationCurve,
  buildDistributionBins,
  buildPercentiles,
  buildSkewSummary,
  formatAxisValue,
  generatedTokenShare,
} from '../agentSessionSizes';
import type { AgentCostDistributionRow } from '../types';

function makeRow(overrides: Partial<AgentCostDistributionRow> = {}): AgentCostDistributionRow {
  const zero = {
    session_count: 0,
    prior_session_count: 0,
    total_generated_tokens: 0,
    prior_total_generated_tokens: 0,
    total_cache_inclusive_tokens: 0,
    prior_total_cache_inclusive_tokens: 0,
    total_cost_usd: 0,
    prior_total_cost_usd: 0,
    cost_p50: 0,
    prior_cost_p50: 0,
    cost_p90: 0,
    prior_cost_p90: 0,
    cost_p95: 0,
    prior_cost_p95: 0,
    cost_max: 0,
    prior_cost_max: 0,
    generated_tokens_p50: 0,
    prior_generated_tokens_p50: 0,
    generated_tokens_p90: 0,
    prior_generated_tokens_p90: 0,
    generated_tokens_p95: 0,
    prior_generated_tokens_p95: 0,
    generated_tokens_max: 0,
    prior_generated_tokens_max: 0,
    cache_inclusive_tokens_p50: 0,
    prior_cache_inclusive_tokens_p50: 0,
    cache_inclusive_tokens_p90: 0,
    prior_cache_inclusive_tokens_p90: 0,
    cache_inclusive_tokens_p95: 0,
    prior_cache_inclusive_tokens_p95: 0,
    cache_inclusive_tokens_max: 0,
    prior_cache_inclusive_tokens_max: 0,
    cost_bucket_lo: [],
    cost_bucket_hi: [],
    cost_bucket_count: [],
    cost_bucket_sum: [],
    token_bucket_lo: [],
    token_bucket_hi: [],
    token_bucket_count: [],
    token_bucket_sum: [],
    top_10pct_cost_usd: 0,
    top_10pct_session_count: 0,
    gini: 0,
    half_spend_conv_count: 0,
    lorenz_conv_pct: [],
    lorenz_cost_pct: [],
  } satisfies AgentCostDistributionRow;
  return { ...zero, ...overrides };
}

describe('buildDistributionBins', () => {
  it('zips the cost decile arrays into bars with data-derived range labels and spend totals', () => {
    const bins = buildDistributionBins(
      makeRow({
        cost_bucket_lo: [0.1, 0.8, 22],
        cost_bucket_hi: [0.8, 22, 240],
        cost_bucket_count: [2, 5, 1],
        cost_bucket_sum: [0.9, 60, 240],
      }),
      'cost',
    );
    expect(bins.map((b) => b.label)).toEqual(['$0.100–$0.800', '$0.800–$22.00', '$22.00–$240.00']);
    expect(bins[0]).toEqual({ label: '$0.100–$0.800', count: 2, total: 0.9 });
    // Bar height is the SUMMED spend (where the money is), not the conversation count.
    expect(bins[2]).toEqual({ label: '$22.00–$240.00', count: 1, total: 240 });
  });

  it('zips the generated-token decile arrays on the token axis', () => {
    const bins = buildDistributionBins(
      makeRow({
        token_bucket_lo: [1000, 48000],
        token_bucket_hi: [48000, 1200000],
        token_bucket_count: [4, 1],
        token_bucket_sum: [60000, 1200000],
      }),
      'tokens',
    );
    expect(bins.map((b) => b.label)).toEqual(['1.0K–48.0K', '48.0K–1.2M']);
    expect(bins[0]).toEqual({ label: '1.0K–48.0K', count: 4, total: 60000 });
  });

  it('returns no bars when the bucket arrays are empty (no spread / no conversations)', () => {
    expect(buildDistributionBins(makeRow(), 'cost')).toEqual([]);
  });

  it('truncates to the shortest array if the parallel arrays ever disagree in length', () => {
    const bins = buildDistributionBins(
      makeRow({
        cost_bucket_lo: [0.1, 0.8],
        cost_bucket_hi: [0.8, 4],
        cost_bucket_count: [2],
        cost_bucket_sum: [0.9],
      }),
      'cost',
    );
    expect(bins).toHaveLength(1);
  });
});

describe('buildPercentiles', () => {
  it('reads cost percentiles plus the prior-window p50 on the cost axis', () => {
    const p = buildPercentiles(
      makeRow({ cost_p50: 0.8, cost_p90: 4, cost_p95: 5, cost_max: 12, prior_cost_p50: 0.5 }),
      'cost',
    );
    expect(p).toEqual({ p50: 0.8, p90: 4, p95: 5, max: 12, priorP50: 0.5 });
  });

  it('reads generated-token percentiles on the token axis', () => {
    const p = buildPercentiles(
      makeRow({
        generated_tokens_p50: 5000,
        generated_tokens_p95: 90000,
        generated_tokens_max: 200000,
        prior_generated_tokens_p50: 4000,
      }),
      'tokens',
    );
    expect(p).toMatchObject({ p50: 5000, p95: 90000, max: 200000, priorP50: 4000 });
  });
});

describe('buildSkewSummary', () => {
  it('reports the top-10% concentration and the p95/p50 stretch', () => {
    const skew = buildSkewSummary(
      makeRow({
        total_cost_usd: 100,
        top_10pct_cost_usd: 70,
        top_10pct_session_count: 2,
        cost_p50: 0.8,
        cost_p95: 8,
      }),
    );
    expect(skew.topCount).toBe(2);
    expect(skew.topCostUsd).toBe(70);
    expect(skew.topCostShare).toBeCloseTo(0.7);
    expect(skew.p95OverP50).toBeCloseTo(10);
  });

  it('is all-zero shares (not NaN) when there is no spend', () => {
    const skew = buildSkewSummary(makeRow());
    expect(skew.topCostShare).toBe(0);
    expect(skew.p95OverP50).toBe(0);
  });

  it('clamps the top-10% share to 1 if concentration rounding overshoots total', () => {
    const skew = buildSkewSummary(makeRow({ total_cost_usd: 10, top_10pct_cost_usd: 12 }));
    expect(skew.topCostShare).toBe(1);
  });
});

describe('buildConcentrationCurve', () => {
  // Mirrors the pipe fixture: costs {0.1, 0.8, 4.0}, total 4.9, gini 0.5306, half in 1 conversation.
  const fixtureRow = makeRow({
    session_count: 3,
    total_cost_usd: 4.9,
    top_10pct_cost_usd: 4,
    top_10pct_session_count: 1,
    gini: 0.5306,
    half_spend_conv_count: 1,
    lorenz_conv_pct: [0, 1 / 3, 2 / 3, 1],
    lorenz_cost_pct: [0, 4 / 4.9, 4.8 / 4.9, 1],
  });

  it('reads the derived scalars straight from the row', () => {
    const curve = buildConcentrationCurve(fixtureRow);
    expect(curve.gini).toBeCloseTo(0.5306);
    expect(curve.halfSpendCount).toBe(1);
    expect(curve.topCount).toBe(1);
    expect(curve.topCostShare).toBeCloseTo(4 / 4.9);
    expect(curve.totalCost).toBe(4.9);
    expect(curve.sessionCount).toBe(3);
  });

  it('plots a monotonic non-decreasing curve that ends at (1, 1)', () => {
    const { points } = buildConcentrationCurve(fixtureRow);
    expect(points[0]).toEqual({ convPct: 0, costPct: 0 });
    expect(points[points.length - 1]).toEqual({ convPct: 1, costPct: 1 });
    for (let i = 1; i < points.length; i++) {
      expect(points[i].convPct).toBeGreaterThanOrEqual(points[i - 1].convPct);
      expect(points[i].costPct).toBeGreaterThanOrEqual(points[i - 1].costPct);
    }
  });

  it('bows above the diagonal (priciest-first => spend share leads conversation share)', () => {
    const { points } = buildConcentrationCurve(fixtureRow);
    for (const p of points) {
      expect(p.costPct).toBeGreaterThanOrEqual(p.convPct - 1e-9);
    }
  });

  it('returns an empty curve and zeroed facts for a no-spend row', () => {
    const curve = buildConcentrationCurve(makeRow());
    expect(curve.points).toEqual([]);
    expect(curve.gini).toBe(0);
    expect(curve.halfSpendCount).toBe(0);
    expect(curve.topCostShare).toBe(0);
  });

  it('clamps out-of-range or malformed share values into [0, 1]', () => {
    const curve = buildConcentrationCurve(
      makeRow({
        gini: 1.4,
        lorenz_conv_pct: [-0.2, 0.5, 1.3],
        lorenz_cost_pct: [0, 1.1, Number.NaN],
      }),
    );
    expect(curve.gini).toBe(1);
    expect(curve.points).toEqual([
      { convPct: 0, costPct: 0 },
      { convPct: 0.5, costPct: 1 },
      { convPct: 1, costPct: 0 },
    ]);
  });

  it('drops the trailing point when the two share arrays disagree in length', () => {
    const curve = buildConcentrationCurve(
      makeRow({ lorenz_conv_pct: [0, 0.5, 1], lorenz_cost_pct: [0, 0.9] }),
    );
    expect(curve.points).toHaveLength(2);
  });
});

describe('formatAxisValue / axisLabel', () => {
  it('formats cost as currency and tokens as a plain count', () => {
    expect(formatAxisValue('cost', 4.2)).toBe('$4.20');
    expect(formatAxisValue('tokens', 12000)).toBe('12.0K');
  });

  it('labels the axes with standard terms', () => {
    expect(axisLabel('cost')).toBe('Cost');
    expect(axisLabel('tokens')).toBe('Tokens generated');
  });
});

describe('generatedTokenShare', () => {
  it('is the generated fraction of tokens processed', () => {
    const row = makeRow({ total_cache_inclusive_tokens: 1000, total_generated_tokens: 250 });
    expect(generatedTokenShare(row)).toBe(0.25);
  });

  it('is 0 (not NaN) when nothing was processed', () => {
    expect(generatedTokenShare(makeRow())).toBe(0);
  });

  it('clamps to 1 if generated somehow exceeds processed', () => {
    const row = makeRow({ total_cache_inclusive_tokens: 100, total_generated_tokens: 150 });
    expect(generatedTokenShare(row)).toBe(1);
  });
});
