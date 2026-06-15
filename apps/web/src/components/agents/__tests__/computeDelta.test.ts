import { describe, expect, it } from 'vitest';
import { computeDelta } from '../delta';

describe('computeDelta prior-period change', () => {
  it('computes percent change vs the prior period', () => {
    expect(computeDelta(150, 100)).toBe(50);
    expect(computeDelta(50, 100)).toBe(-50);
  });

  it('returns null when there is no prior baseline (avoids divide-by-zero)', () => {
    expect(computeDelta(100, 0)).toBeNull();
    expect(computeDelta(0, 0)).toBeNull();
  });

  it('reports a drop to zero as -100%', () => {
    expect(computeDelta(0, 80)).toBe(-100);
  });
});
