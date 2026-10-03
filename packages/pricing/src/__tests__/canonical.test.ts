import { describe, expect, it } from 'vitest';
import {
  calculateCost,
  priceCanonicalUsage,
  parseModelPricing,
  serializeModelPricing,
  resolvePricing,
  type ModelPricing,
  type CanonicalUsage,
  type ResolvedPricing,
} from '../index';

const pricing: ModelPricing = {
  promptCostPerMillion: 3_000_000,
  completionCostPerMillion: 15_000_000,
  cacheReadCostPerMillion: 300_000,
  cacheWriteCostPerMillion: 3_750_000,
  source: 'manual',
  updatedAt: 1,
};
const resolved: ResolvedPricing = { key: 'pricing:anthropic:claude', pricing };
const usage: CanonicalUsage = {
  inputUncached: 1000,
  cacheRead: 200,
  cacheWrite: 100,
  outputNonReasoning: 300,
  reasoning: 50,
  unclassified: 0,
};
const standard = { reported: 'default' };

describe('canonical pricing', () => {
  it('prices canonical nonoverlapping buckets with output-inclusive reasoning once', () => {
    expect(priceCanonicalUsage(usage, resolved, standard)).toMatchObject({
      status: 'priced',
      reasons: [],
      pricedTokens: 1650,
      breakdown: {
        inputCostMicrodollars: 3000,
        cacheReadCostMicrodollars: 60,
        cacheWriteCostMicrodollars: 375,
        outputCostMicrodollars: 4500,
        reasoningCostMicrodollars: 750,
        totalCostMicrodollars: 8685,
      },
    });
  });

  it('rejects unsafe token and cost totals even when each component is safe', () => {
    expect(() =>
      priceCanonicalUsage({ ...usage, unclassified: Number.MAX_SAFE_INTEGER }, resolved, standard),
    ).toThrow('Canonical token total exceeds safe range');
    expect(() =>
      priceCanonicalUsage(
        {
          ...usage,
          inputUncached: 4_000_000_000_000_000,
          outputNonReasoning: 4_000_000_000_000_000,
        },
        {
          ...resolved,
          pricing: {
            ...pricing,
            promptCostPerMillion: 2_000_000,
            completionCostPerMillion: 2_000_000,
          },
        },
        standard,
      ),
    ).toThrow('Canonical cost total exceeds safe microdollar range');
  });

  it('does not invent cache rates, and preserves a configured free rate', () => {
    const { cacheReadCostPerMillion: _read, cacheWriteCostPerMillion: _write, ...rates } = pricing;
    expect(priceCanonicalUsage(usage, { ...resolved, pricing: rates }, standard)).toMatchObject({
      status: 'partial',
      pricedTokens: 1350,
      reasons: ['cache_read_rate_missing', 'cache_write_rate_missing'],
      breakdown: {
        cacheReadCostMicrodollars: 0,
        cacheWriteCostMicrodollars: 0,
        totalCostMicrodollars: 8250,
      },
    });
    expect(
      priceCanonicalUsage(
        usage,
        { ...resolved, pricing: { ...pricing, cacheReadCostPerMillion: 0 } },
        standard,
      ),
    ).toMatchObject({
      status: 'priced',
      pricedTokens: 1650,
      breakdown: { cacheReadCostMicrodollars: 0 },
    });
  });

  it('distinguishes missing, unclassified, and explicit zero usage', () => {
    expect(priceCanonicalUsage(null, resolved, standard)).toMatchObject({
      status: 'unpriced',
      breakdown: null,
      reasons: ['usage_missing'],
    });
    const zero = {
      inputUncached: 0,
      cacheRead: 0,
      cacheWrite: 0,
      outputNonReasoning: 0,
      reasoning: 0,
      unclassified: 0,
    };
    expect(priceCanonicalUsage(zero, resolved, standard)).toMatchObject({
      status: 'priced',
      breakdown: { totalCostMicrodollars: 0 },
    });
    expect(priceCanonicalUsage({ ...zero, unclassified: 90 }, resolved, standard)).toMatchObject({
      status: 'unpriced',
      breakdown: null,
      pricedTokens: 0,
    });
    expect(priceCanonicalUsage({ ...usage, unclassified: 90 }, resolved, standard)).toMatchObject({
      status: 'partial',
      pricedTokens: 1650,
    });
    expect(priceCanonicalUsage(usage, null, standard)).toMatchObject({
      status: 'unpriced',
      breakdown: null,
      reasons: ['model_not_in_catalog'],
    });
  });

  it('excludes cache writes with unknown TTL instead of charging the cheaper rate', () => {
    expect(
      priceCanonicalUsage(
        usage,
        { ...resolved, pricing: { ...pricing, cacheWrite1hCostPerMillion: 6_000_000 } },
        standard,
      ),
    ).toMatchObject({
      status: 'partial',
      reasons: ['cache_write_ttl_unknown'],
      pricedTokens: 1550,
      breakdown: { cacheWriteCostMicrodollars: 0 },
    });
  });

  it.each(['flex', 'priority', 'batch'] as const)(
    'applies explicit documented %s and its own context threshold',
    (tier) => {
      const record: ModelPricing = {
        ...pricing,
        serviceTiers: {
          [tier]: {
            promptCostPerMillion: 2_000_000,
            completionCostPerMillion: 8_000_000,
            referenceUrl: 'https://openai.com/api/pricing/',
            contextTier: {
              thresholdTokens: 100,
              promptCostPerMillion: 4_000_000,
              completionCostPerMillion: 12_000_000,
            },
          },
        },
      };
      const tokens = {
        inputUncached: 99,
        cacheRead: 0,
        cacheWrite: 0,
        outputNonReasoning: 10,
        reasoning: 5,
        unclassified: 0,
      };
      const below = priceCanonicalUsage(
        tokens,
        { ...resolved, pricing: record },
        { reported: tier },
      );
      const at = priceCanonicalUsage(
        { ...tokens, inputUncached: 100 },
        { ...resolved, pricing: record },
        { reported: tier },
      );
      expect(below.breakdown?.totalCostMicrodollars).toBe(318);
      expect(at.breakdown?.totalCostMicrodollars).toBe(580);
      expect(at.rates).toMatchObject({
        contextTierThresholdTokens: 100,
        serviceTier: tier,
        referenceUrl: 'https://openai.com/api/pricing/',
      });
    },
  );

  it('does not inherit missing context rates or guess which threshold applies', () => {
    const record = {
      ...pricing,
      contextTier: {
        thresholdTokens: 1300,
        promptCostPerMillion: 6_000_000,
        completionCostPerMillion: 20_000_000,
      },
    };
    expect(priceCanonicalUsage(usage, { ...resolved, pricing: record }, standard)).toMatchObject({
      status: 'partial',
      reasons: ['cache_read_rate_missing', 'cache_write_rate_missing'],
      pricedTokens: 1350,
    });
    expect(
      priceCanonicalUsage(
        { ...usage, inputUncached: 999, unclassified: 1 },
        { ...resolved, pricing: record },
        standard,
      ),
    ).toMatchObject({
      status: 'unpriced',
      reasons: ['context_tier_unknown', 'unclassified_tokens'],
      breakdown: null,
    });
  });

  it.each([
    [{ requested: 'default' }, 'service_tier_unreported'],
    [{ reported: 'auto', requested: 'default' }, 'service_tier_unsupported'],
    [{ reported: 'unknown' }, 'service_tier_unsupported'],
    [{ reported: 'flex' }, 'service_tier_rate_missing'],
  ])('leaves unsupported or unreported service tiers unresolved', (tier, reason) => {
    expect(priceCanonicalUsage(usage, resolved, tier)).toMatchObject({
      status: 'unpriced',
      reasons: [reason],
      pricedTokens: 0,
      breakdown: null,
    });
  });

  it('reported tier overrides requested tier', () => {
    expect(
      priceCanonicalUsage(usage, resolved, { requested: 'flex', reported: 'default' }).status,
    ).toBe('priced');
  });
});

describe('catalog serialization', () => {
  it('preserves units, context rates, and documented zero service rates', () => {
    const record = {
      ...pricing,
      serviceTiers: {
        batch: {
          promptCostPerMillion: 0,
          completionCostPerMillion: 15_000_000,
          referenceUrl: 'https://openai.com/api/pricing/',
        },
      },
    };
    expect(parseModelPricing(JSON.parse(serializeModelPricing(record)))).toMatchObject(record);
    expect(calculateCost({ promptTokens: 100, completionTokens: 50 }, record)).toEqual(
      calculateCost({ promptTokens: 100, completionTokens: 50 }, pricing),
    );
  });

  it.each([
    { ...pricing, promptCostPerMillion: -1 },
    { ...pricing, cacheReadCostPerMillion: Infinity },
    {
      ...pricing,
      contextTier: { thresholdTokens: 0, promptCostPerMillion: 1, completionCostPerMillion: 1 },
    },
    {
      ...pricing,
      serviceTiers: { invented: { ...pricing, referenceUrl: 'https://example.com/' } },
    },
    { ...pricing, serviceTiers: { flex: { ...pricing, referenceUrl: 'http://example.com/' } } },
  ])('rejects malformed catalog records', (record) =>
    expect(() => parseModelPricing(record)).toThrow(),
  );

  it('records the actual matched catalog key', async () => {
    const kv = {
      get: async <T>(key: string): Promise<T | null> =>
        key === 'pricing:anthropic:claude' ? (pricing as T) : null,
    };
    expect(await resolvePricing(kv, 'anthropic', 'claude-20261002')).toEqual(resolved);
  });
});
