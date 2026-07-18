import { describe, expect, it } from 'vitest';
import { buildDepthSeries, classifyElasticity, elasticityGloss } from '../costByDepth';
import type { AgentCostByDepthRow } from '../types';

function makeRow(overrides: Partial<AgentCostByDepthRow> = {}): AgentCostByDepthRow {
  return {
    depth: 0,
    sample_count: 5,
    priced_sample_count: 5,
    min_depth_samples: 5,
    well_sampled: 1,
    cost_p25: 1,
    cost_p50: 1,
    cost_p75: 1,
    cost_p95: 1,
    context_p25: 10000,
    context_p50: 10000,
    context_p75: 10000,
    context_p95: 10000,
    cost_elasticity: 1,
    context_elasticity: 1,
    cost_fit_points: 6,
    context_fit_points: 6,
    fit_sampled: 0,
    charted_max_depth: 5,
    observed_max_depth: 5,
    pooled_depth_count: 0,
    pooled_turn_count: 0,
    ...overrides,
  };
}

describe('buildDepthSeries', () => {
  it('returns null for no rows', () => {
    expect(buildDepthSeries([])).toBeNull();
  });

  it('sorts by depth, derives the band height, and lifts the window-level fit', () => {
    const rows = [
      makeRow({ depth: 2, cost_p25: 2, cost_p75: 6, context_p25: 20000, context_p75: 40000 }),
      makeRow({ depth: 0, cost_p25: 1, cost_p75: 3, context_p25: 10000, context_p75: 15000 }),
    ];
    const series = buildDepthSeries(rows);
    expect(series).not.toBeNull();
    expect(series!.points.map((p) => p.depth)).toEqual([0, 2]);
    // costBand = p75 - p25
    expect(series!.points[0].costBand).toBe(2);
    expect(series!.points[1].costBand).toBe(4);
    expect(series!.points[0].contextBand).toBe(5000);
    expect(series!.chartedMaxDepth).toBe(5);
    expect(series!.costElasticity).toBe(1);
    expect(series!.fitSampled).toBe(false);
    expect(series!.costDoublingFactor).toBeCloseTo(2, 10);
  });

  it('charts only well-sampled depths but still reports the pooled tail scalars', () => {
    const rows = [
      makeRow({ depth: 0, well_sampled: 1 }),
      makeRow({ depth: 1, well_sampled: 1 }),
      // Sparse deep turns the chart must drop, even though they are in the rows.
      makeRow({ depth: 900, well_sampled: 0, cost_p50: 50 }),
      makeRow({
        depth: 1937,
        well_sampled: 0,
        charted_max_depth: 1,
        observed_max_depth: 1937,
        pooled_depth_count: 2,
        pooled_turn_count: 3,
      }),
    ];
    const series = buildDepthSeries(rows);
    expect(series!.points.map((p) => p.depth)).toEqual([0, 1]);
    // Scalars are lifted from the first row (identical on every pipe row in practice).
    expect(series!.pooledDepthCount).toBe(0);
    expect(series!.observedMaxDepth).toBe(5);
  });

  it('surfaces when the depth fit was bounded by sampling', () => {
    expect(buildDepthSeries([makeRow({ fit_sampled: 1 })])!.fitSampled).toBe(true);
  });

  it('clamps an inverted band to zero rather than emitting a negative height', () => {
    const series = buildDepthSeries([makeRow({ cost_p25: 5, cost_p75: 3 })]);
    expect(series!.points[0].costBand).toBe(0);
  });

  it('computes 2^elasticity as the doubling factor', () => {
    const series = buildDepthSeries([makeRow({ cost_elasticity: 2, context_elasticity: 0 })]);
    expect(series!.costDoublingFactor).toBeCloseTo(4, 10);
    expect(series!.contextDoublingFactor).toBeCloseTo(1, 10);
  });
});

describe('classifyElasticity', () => {
  it('anchors on 0 (flat) and 1 (linear) with a noise dead-band', () => {
    expect(classifyElasticity(0)).toBe('flat');
    expect(classifyElasticity(0.1)).toBe('flat');
    expect(classifyElasticity(1)).toBe('linear');
    expect(classifyElasticity(0.5)).toBe('linear');
    expect(classifyElasticity(1.1)).toBe('linear');
  });

  it('flags acceleration above linear (the runaway) and decline below zero', () => {
    expect(classifyElasticity(1.5)).toBe('accelerating');
    expect(classifyElasticity(-0.5)).toBe('declining');
  });
});

describe('elasticityGloss', () => {
  it('returns a distinct plain-language reading per verdict', () => {
    const flat = elasticityGloss(0);
    const linear = elasticityGloss(1);
    const accel = elasticityGloss(2);
    expect(flat).not.toBe(linear);
    expect(linear).not.toBe(accel);
    expect(accel).toMatch(/runaway/i);
  });
});
