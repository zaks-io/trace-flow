import { describe, expect, it } from 'vitest';
import { convertModelsDevModel } from '../billing/modelPricing';

/**
 * Pure-conversion guards for the models.dev import. Fixtures mirror the real api.json shape (dollars
 * per million tokens), so a units or tier-mapping regression fails here headlessly — before the
 * `bunx convex dev --once` end-to-end check.
 */
describe('convertModelsDevModel', () => {
  it('converts a flat first-party rate to microdollars', () => {
    // claude-opus-4-7 shape: input/output/cache_read/cache_write in dollars per million.
    const converted = convertModelsDevModel({
      cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    });

    expect(converted).toEqual({
      promptCostPerMillion: 5_000_000,
      completionCostPerMillion: 25_000_000,
      cacheReadCostPerMillion: 500_000,
      cacheWriteCostPerMillion: 6_250_000,
      contextTier: undefined,
    });
  });

  it('maps a context-tier rate set onto contextTier with its threshold', () => {
    // gpt-5.5 shape: a single `tier.type === 'context'` entry at 272k tokens.
    const converted = convertModelsDevModel({
      cost: {
        input: 5,
        output: 30,
        cache_read: 0.5,
        tiers: [{ input: 10, output: 45, cache_read: 1, tier: { type: 'context', size: 272000 } }],
      },
    });

    expect(converted).toEqual({
      promptCostPerMillion: 5_000_000,
      completionCostPerMillion: 30_000_000,
      cacheReadCostPerMillion: 500_000,
      cacheWriteCostPerMillion: undefined,
      contextTier: {
        thresholdTokens: 272000,
        promptCostPerMillion: 10_000_000,
        completionCostPerMillion: 45_000_000,
        cacheReadCostPerMillion: 1_000_000,
        cacheWriteCostPerMillion: undefined,
      },
    });
  });

  it('ignores non-context tiers (no contextTier emitted)', () => {
    const converted = convertModelsDevModel({
      cost: {
        input: 1,
        output: 2,
        tiers: [{ input: 3, output: 4, tier: { type: 'batch', size: 0 } }],
      },
    });

    expect(converted?.contextTier).toBeUndefined();
  });

  it('returns null for an entry with no cost block (e.g. image models)', () => {
    expect(convertModelsDevModel({})).toBeNull();
  });

  it('returns null when a required rate is negative or non-finite (untrusted JSON cannot corrupt a row)', () => {
    expect(convertModelsDevModel({ cost: { input: -1, output: 25 } })).toBeNull();
    expect(
      convertModelsDevModel({ cost: { input: 5, output: Number.POSITIVE_INFINITY } }),
    ).toBeNull();
  });

  it('drops a present-but-invalid optional cache rate instead of storing NaN/negative', () => {
    expect(
      convertModelsDevModel({ cost: { input: 5, output: 25, cache_read: -0.5 } }),
    ).toMatchObject({
      promptCostPerMillion: 5_000_000,
      completionCostPerMillion: 25_000_000,
      cacheReadCostPerMillion: undefined,
    });
  });

  it('drops a context tier with an invalid required rate but keeps the valid base rates', () => {
    const converted = convertModelsDevModel({
      cost: {
        input: 5,
        output: 25,
        tiers: [{ input: -1, output: 45, tier: { type: 'context', size: 272000 } }],
      },
    });

    expect(converted?.promptCostPerMillion).toBe(5_000_000);
    expect(converted?.contextTier).toBeUndefined();
  });

  it('rounds fractional sub-dollar rates to the nearest microdollar', () => {
    const converted = convertModelsDevModel({ cost: { input: 0.25, output: 1.5 } });

    expect(converted).toMatchObject({
      promptCostPerMillion: 250_000,
      completionCostPerMillion: 1_500_000,
    });
  });
});
