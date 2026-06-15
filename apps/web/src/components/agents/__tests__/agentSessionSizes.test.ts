import { describe, expect, it } from 'vitest';
import {
  axisLabel,
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
    cost_bin_under_10c: 0,
    cost_bin_10c_1: 0,
    cost_bin_1_5: 0,
    cost_bin_5_20: 0,
    cost_bin_20_plus: 0,
    cost_sum_under_10c: 0,
    cost_sum_10c_1: 0,
    cost_sum_1_5: 0,
    cost_sum_5_20: 0,
    cost_sum_20_plus: 0,
    token_bin_under_10k: 0,
    token_bin_10k_50k: 0,
    token_bin_50k_200k: 0,
    token_bin_200k_1m: 0,
    token_bin_1m_plus: 0,
    token_sum_under_10k: 0,
    token_sum_10k_50k: 0,
    token_sum_50k_200k: 0,
    token_sum_200k_1m: 0,
    token_sum_1m_plus: 0,
    top_10pct_cost_usd: 0,
    top_10pct_session_count: 0,
  } satisfies AgentCostDistributionRow;
  return { ...zero, ...overrides };
}

describe('buildDistributionBins', () => {
  it('maps the five cost bands in order with counts and summed spend', () => {
    const bins = buildDistributionBins(
      makeRow({
        cost_bin_under_10c: 3,
        cost_sum_under_10c: 0.15,
        cost_bin_10c_1: 2,
        cost_sum_10c_1: 0.9,
        cost_bin_1_5: 1,
        cost_sum_1_5: 4,
        cost_bin_20_plus: 1,
        cost_sum_20_plus: 50,
      }),
      'cost',
    );
    expect(bins.map((b) => b.label)).toEqual(['<$0.10', '$0.10–1', '$1–5', '$5–20', '$20+']);
    expect(bins[0]).toEqual({ label: '<$0.10', count: 3, total: 0.15 });
    expect(bins[4]).toEqual({ label: '$20+', count: 1, total: 50 });
  });

  it('maps the five generated-token bands in order on the token axis', () => {
    const bins = buildDistributionBins(
      makeRow({ token_bin_under_10k: 4, token_sum_under_10k: 12000, token_bin_1m_plus: 1 }),
      'tokens',
    );
    expect(bins.map((b) => b.label)).toEqual(['<10k', '10k–50k', '50k–200k', '200k–1M', '1M+']);
    expect(bins[0]).toEqual({ label: '<10k', count: 4, total: 12000 });
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
