import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal, api } from '../_generated/api';
import { list } from '../billing/modelPricing';
import schema from '../schema';
import { initConvexTest } from './convexTest.setup';

const flex = {
  promptCostPerMillion: 0,
  completionCostPerMillion: 0,
  cacheReadCostPerMillion: 0,
  referenceUrl: 'https://platform.openai.com/docs/guides/flex-processing',
  contextTier: {
    thresholdTokens: 272_000,
    promptCostPerMillion: 1_000_000,
    completionCostPerMillion: 2_000_000,
    cacheReadCostPerMillion: 0,
  },
};

const pricing = {
  provider: 'openai',
  model: 'test-tiered-model',
  promptCostPerMillion: 3_000_000,
  completionCostPerMillion: 6_000_000,
  source: 'manual' as const,
};

describe('service tier pricing storage', () => {
  beforeEach(() => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account');
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');
    vi.stubEnv('CLOUDFLARE_PRICING_KV_NAMESPACE_ID', 'test-namespace');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('keeps explicit zero and context rates through internal upsert, catalog refresh, and KV sync', async () => {
    const t = initConvexTest();
    await t.mutation(internal.billing.modelPricing.upsertInternal, {
      ...pricing,
      serviceTiers: { flex },
    });
    await t.mutation(internal.billing.modelPricing.upsertInternal, {
      ...pricing,
      promptCostPerMillion: 4_000_000,
      source: 'models.dev',
    });

    const stored = await t.query(internal.billing.modelPricing.getInternal, {
      provider: pricing.provider,
      model: pricing.model,
    });
    expect(stored?.promptCostPerMillion).toBe(4_000_000);
    expect(stored?.serviceTiers?.flex).toEqual(flex);

    await t.action(internal.billing.pricingSync.syncToKV, {
      provider: pricing.provider,
      model: pricing.model,
    });
    const body = vi.mocked(fetch).mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body as string)).toMatchObject({
      promptCostPerMillion: 4_000_000,
      serviceTiers: { flex },
      source: 'models.dev',
    });

    const tokenIdentifier = 'reader-test';
    await t.run((ctx) =>
      ctx.db.insert('users', { tokenIdentifier, email: 'reader@example.com', enabled: true }),
    );
    const reader = t.withIdentity({ tokenIdentifier });
    const publicList = await reader.query(api.billing.modelPricing.list, {
      provider: pricing.provider,
    });
    expect(publicList[0]?.serviceTiers?.flex).toEqual(flex);
  });

  it('preserves omitted tiers during admin edits and clears explicitly empty tiers', async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    await t.mutation(internal.billing.modelPricing.upsertInternal, {
      ...pricing,
      serviceTiers: { flex },
    });
    const tokenIdentifier = 'admin-test';
    await t.run((ctx) =>
      ctx.db.insert('users', {
        tokenIdentifier,
        email: 'admin@example.com',
        enabled: true,
        isAdmin: true,
      }),
    );
    const admin = t.withIdentity({ tokenIdentifier });
    await admin.mutation(api.billing.modelPricing.upsert, pricing);
    expect(
      (await admin.query(api.billing.modelPricing.list, { provider: pricing.provider }))[0]
        ?.serviceTiers,
    ).toEqual({ flex });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string).serviceTiers).toEqual({
      flex,
    });

    await admin.mutation(api.billing.modelPricing.upsert, { ...pricing, serviceTiers: {} });
    expect(
      (await admin.query(api.billing.modelPricing.list, { provider: pricing.provider }))[0]
        ?.serviceTiers,
    ).toEqual({});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const calls = vi.mocked(fetch).mock.calls;
    expect(JSON.parse(calls[calls.length - 1]?.[1]?.body as string).serviceTiers).toEqual({});
  });

  it('rejects invalid rates and undocumented tiers before writing', async () => {
    const t = initConvexTest();
    await expect(
      t.mutation(internal.billing.modelPricing.upsertInternal, {
        ...pricing,
        serviceTiers: { flex: { ...flex, cacheReadCostPerMillion: -1 } },
      }),
    ).rejects.toThrow('finite and nonnegative');
    await expect(
      t.mutation(internal.billing.modelPricing.upsertInternal, {
        ...pricing,
        serviceTiers: { flex: { ...flex, referenceUrl: 'http://example.com/pricing' } },
      }),
    ).rejects.toThrow('HTTPS provider documentation');
    await expect(
      t.mutation(internal.billing.modelPricing.upsertInternal, {
        ...pricing,
        serviceTiers: {
          flex: { ...flex, contextTier: { ...flex.contextTier, thresholdTokens: 0 } },
        },
      }),
    ).rejects.toThrow('Invalid pricing context threshold');
  });
});

describe('public pricing return contracts', () => {
  it('returns every schema field, including service tiers, from list', () => {
    const schemaFields = (
      schema.tables.modelPricing.validator as unknown as {
        json: { value: Record<string, unknown> };
      }
    ).json.value;
    const listDocument = JSON.parse(
      (list as unknown as { exportReturns(): string }).exportReturns(),
    ).value;

    for (const document of [listDocument]) {
      const { _id, _creationTime, ...returnedFields } = document.value;
      expect(_id.fieldType).toEqual({ type: 'id', tableName: 'modelPricing' });
      expect(_creationTime.fieldType).toEqual({ type: 'number' });
      expect(returnedFields).toEqual(schemaFields);
      expect(returnedFields).toHaveProperty(
        'serviceTiers.fieldType.value.flex.fieldType.value.referenceUrl',
        { fieldType: { type: 'string' }, optional: false },
      );
    }
  });
});
