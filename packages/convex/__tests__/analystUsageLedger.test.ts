import { describe, expect, it } from 'vitest';
import { applyDelta, emptyTotals, isEmptyDelta } from '../analystUsageLedger';

describe('applyDelta', () => {
  it('adds a delta onto existing totals', () => {
    const next = applyDelta(
      { totalTokens: 1000, totalCost: 0.01, cacheReadTokens: 200, requests: 2, hasCost: true },
      { totalTokens: 500, totalCost: 0.004, cacheReadTokens: 100, requests: 1, hasCost: true },
    );
    expect(next).toEqual({
      totalTokens: 1500,
      totalCost: 0.014,
      cacheReadTokens: 300,
      requests: 3,
      hasCost: true,
    });
  });

  it('latches hasCost true once any delta carries cost', () => {
    const a = applyDelta(emptyTotals(), {
      totalTokens: 10,
      totalCost: 0,
      cacheReadTokens: 0,
      requests: 1,
      hasCost: false,
    });
    expect(a.hasCost).toBe(false);
    const b = applyDelta(a, {
      totalTokens: 5,
      totalCost: 0.002,
      cacheReadTokens: 0,
      requests: 1,
      hasCost: true,
    });
    expect(b.hasCost).toBe(true);
  });

  it('clamps negative deltas so totals never go backwards', () => {
    const next = applyDelta(
      { totalTokens: 100, totalCost: 0.01, cacheReadTokens: 10, requests: 1, hasCost: true },
      { totalTokens: -50, totalCost: -0.5, cacheReadTokens: -5, requests: -1, hasCost: false },
    );
    expect(next).toEqual({
      totalTokens: 100,
      totalCost: 0.01,
      cacheReadTokens: 10,
      requests: 1,
      hasCost: true,
    });
  });
});

describe('isEmptyDelta', () => {
  it('treats an all-zero, no-cost delta as empty', () => {
    expect(
      isEmptyDelta({
        totalTokens: 0,
        totalCost: 0,
        cacheReadTokens: 0,
        requests: 0,
        hasCost: false,
      }),
    ).toBe(true);
  });

  it('is non-empty when any field carries a value', () => {
    expect(
      isEmptyDelta({
        totalTokens: 0,
        totalCost: 0,
        cacheReadTokens: 0,
        requests: 1,
        hasCost: false,
      }),
    ).toBe(false);
  });
});
