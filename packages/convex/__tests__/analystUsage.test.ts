import { describe, expect, it } from 'vitest';
import { sumAnalystUsage } from '../analystUsage';

describe('sumAnalystUsage', () => {
  it('sums total tokens across messages', () => {
    const result = sumAnalystUsage([
      { usage: { totalTokens: 1200 } },
      { usage: { totalTokens: 800 } },
      { usage: undefined },
    ]);
    expect(result.totalTokens).toBe(2000);
  });

  it('sums OpenRouter charged cost from provider metadata', () => {
    const result = sumAnalystUsage([
      {
        usage: { totalTokens: 1000 },
        providerMetadata: { openrouter: { usage: { cost: 0.012 } } },
      },
      {
        usage: { totalTokens: 500 },
        providerMetadata: { openrouter: { usage: { cost: 0.004 } } },
      },
    ]);
    expect(result.totalTokens).toBe(1500);
    expect(result.totalCost).toBeCloseTo(0.016, 6);
    expect(result.hasCost).toBe(true);
  });

  it('reports hasCost=false when no message carries a cost', () => {
    const result = sumAnalystUsage([
      { usage: { totalTokens: 1000 }, providerMetadata: { openrouter: { usage: {} } } },
      { usage: { totalTokens: 500 } },
    ]);
    expect(result.totalTokens).toBe(1500);
    expect(result.totalCost).toBe(0);
    expect(result.hasCost).toBe(false);
  });

  it('ignores malformed usage and metadata without throwing', () => {
    const result = sumAnalystUsage([
      { usage: { totalTokens: Number.NaN } },
      { providerMetadata: { openrouter: 'nope' } },
      { providerMetadata: null },
      {},
    ]);
    expect(result.totalTokens).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.hasCost).toBe(false);
  });
});
