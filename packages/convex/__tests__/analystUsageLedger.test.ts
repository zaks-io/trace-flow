import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  cumulativeDelta,
  emptyTotals,
  isEmptyDelta,
  maxCumulative,
  ZERO_CUMULATIVE,
} from '../analystUsageLedger';

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

describe('cumulativeDelta', () => {
  it('first snapshot from zero baseline yields the full snapshot as the delta', () => {
    const delta = cumulativeDelta(
      ZERO_CUMULATIVE,
      { totalTokens: 52722, totalCost: 0.0347, cacheReadTokens: 30080 },
      true,
    );
    expect(delta).toEqual({
      totalTokens: 52722,
      totalCost: 0.0347,
      cacheReadTokens: 30080,
      requests: 1,
      hasCost: true,
    });
  });

  it('a higher cumulative snapshot only adds the increment (no double-count)', () => {
    const applied = { totalTokens: 52722, totalCost: 0.0347, cacheReadTokens: 30080 };
    const delta = cumulativeDelta(
      applied,
      { totalTokens: 60000, totalCost: 0.04, cacheReadTokens: 32000 },
      true,
    );
    expect(delta.totalTokens).toBe(7278);
    expect(delta.totalCost).toBeCloseTo(0.0053, 6);
    expect(delta.cacheReadTokens).toBe(1920);
    expect(delta.requests).toBe(1);
  });

  it('a repeated identical snapshot contributes nothing (idempotent restream)', () => {
    const applied = { totalTokens: 52722, totalCost: 0.0347, cacheReadTokens: 30080 };
    const delta = cumulativeDelta(applied, { ...applied }, true);
    expect(delta.totalTokens).toBe(0);
    expect(delta.requests).toBe(0);
    expect(isEmptyDelta({ ...delta, hasCost: false })).toBe(true);
  });
});

describe('maxCumulative', () => {
  it('keeps the higher value per field', () => {
    const a = { totalTokens: 1000, totalCost: 0.05, cacheReadTokens: 400 };
    const b = { totalTokens: 600, totalCost: 0.08, cacheReadTokens: 200 };
    expect(maxCumulative(a, b)).toEqual({
      totalTokens: 1000,
      totalCost: 0.08,
      cacheReadTokens: 400,
    });
  });

  it('a regressed snapshot followed by an advance never double-counts', () => {
    // Pi reports cumulative totals. A resume can report a snapshot below the prior baseline.
    // The ledger must reflect the true peak (1200), not 1000 + (1200 - 600) = 1600.
    const applied = { totalTokens: 1000, totalCost: 0.05, cacheReadTokens: 0 };
    const regressed = { totalTokens: 600, totalCost: 0.03, cacheReadTokens: 0 };

    // Negative delta on the regression is clamped to nothing.
    const regressDelta = cumulativeDelta(applied, regressed, true);
    expect(applyDelta(emptyTotals(), regressDelta).totalTokens).toBe(0);

    // The baseline stays monotonic, so the next advance only adds the real increment.
    const baseline = maxCumulative(applied, regressed);
    expect(baseline.totalTokens).toBe(1000);
    const advance = cumulativeDelta(
      baseline,
      { totalTokens: 1200, totalCost: 0.06, cacheReadTokens: 0 },
      true,
    );
    expect(advance.totalTokens).toBe(200);
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
