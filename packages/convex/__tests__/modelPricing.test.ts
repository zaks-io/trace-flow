import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../_generated/api';
import { convertModelsDevModel } from '../billing/modelPricing';
import { initConvexTest } from './convexTest.setup';

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

describe('default pricing sync', () => {
  beforeEach(() => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account');
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');
    vi.stubEnv('CLOUDFLARE_PRICING_KV_NAMESPACE_ID', 'test-namespace');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('') }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('repairs and serializes the Groq GPT-OSS 120B cached-input discount', async () => {
    const t = initConvexTest();
    await t.run((ctx) =>
      ctx.db.insert('modelPricing', {
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
        promptCostPerMillion: 150_000,
        completionCostPerMillion: 600_000,
        source: 'default',
        updatedAt: 123,
      }),
    );

    await expect(
      t.action(internal.billing.modelPricing.syncGroqGptOss120bDefaultInternal, {}),
    ).resolves.toEqual({ updated: true, preservedOverride: false });
    await expect(
      t.action(internal.billing.modelPricing.syncGroqGptOss120bDefaultInternal, {}),
    ).resolves.toEqual({ updated: false, preservedOverride: false });

    const stored = await t.run((ctx) =>
      ctx.db
        .query('modelPricing')
        .withIndex('by_provider_model', (q) =>
          q.eq('provider', 'groq').eq('model', 'openai/gpt-oss-120b'),
        )
        .collect(),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      promptCostPerMillion: 150_000,
      cacheReadCostPerMillion: 75_000,
      source: 'default',
    });

    const body = vi.mocked(fetch).mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body as string)).toMatchObject({
      promptCostPerMillion: 150_000,
      cacheReadCostPerMillion: 75_000,
      source: 'default',
    });
  });

  it('preserves an explicit override while refreshing its KV serialization', async () => {
    const t = initConvexTest();
    await t.run((ctx) =>
      ctx.db.insert('modelPricing', {
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
        promptCostPerMillion: 140_000,
        completionCostPerMillion: 550_000,
        cacheReadCostPerMillion: 60_000,
        source: 'manual',
        updatedAt: 123,
      }),
    );

    await expect(
      t.mutation(internal.billing.modelPricing.repairGroqGptOss120bDefaultInternal, {}),
    ).resolves.toEqual({ updated: false, preservedOverride: true });
    await expect(
      t.action(internal.billing.modelPricing.syncGroqGptOss120bDefaultInternal, {}),
    ).resolves.toEqual({ updated: false, preservedOverride: true });

    const stored = await t.run((ctx) =>
      ctx.db
        .query('modelPricing')
        .withIndex('by_provider_model', (q) =>
          q.eq('provider', 'groq').eq('model', 'openai/gpt-oss-120b'),
        )
        .unique(),
    );
    expect(stored).toMatchObject({
      promptCostPerMillion: 140_000,
      completionCostPerMillion: 550_000,
      cacheReadCostPerMillion: 60_000,
      source: 'manual',
    });

    const body = vi.mocked(fetch).mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body as string)).toMatchObject({
      promptCostPerMillion: 140_000,
      cacheReadCostPerMillion: 60_000,
      source: 'manual',
    });
  });
});
