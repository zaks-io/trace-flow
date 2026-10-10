import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPENROUTER_MODELS_URL, OPENROUTER_PRICING_TTL_SECONDS } from '@trace-flow/pricing';
import { internal } from '../_generated/api';
import { initConvexTest } from './convexTest.setup';

const jev = {
  id: 'typesafe/jev-1.13',
  canonical_slug: 'typesafe/jev-1.13-20260917',
  pricing: { prompt: '0.000000042', completion: '0' },
};
const alias = {
  id: '~typesafe/jev-latest',
  alias_target: { slug: jev.id },
  pricing: { prompt: '0.0001', completion: '0' },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account');
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');
  vi.stubEnv('CLOUDFLARE_PRICING_KV_NAMESPACE_ID', 'test-namespace');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === OPENROUTER_MODELS_URL) {
        return Response.json({ data: [alias, jev] });
      }
      return new Response('');
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('OpenRouter catalog refresh', () => {
  it('refreshes decision model ids, canonical slugs, and aliases in both storage and KV', async () => {
    const t = initConvexTest();
    await expect(
      t.action(internal.billing.modelPricing.importFromOpenRouterInternal, {}),
    ).resolves.toEqual({ imported: 3 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await t.query(internal.billing.modelPricing.listAll, {});
    expect(rows.map((row) => row.model).sort()).toEqual(
      [jev.id, jev.canonical_slug, alias.id].sort(),
    );
    expect(rows.every((row) => row.promptCostPerMillion === 42_000)).toBe(true);
    expect(rows.every((row) => row.completionCostPerMillion === 0)).toBe(true);
    const writes = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(writes).toHaveLength(3);
    for (const [url, init] of writes) {
      expect(new URL(String(url)).searchParams.get('expiration_ttl')).toBe(
        String(OPENROUTER_PRICING_TTL_SECONDS),
      );
      expect(JSON.parse(init!.body as string)).toMatchObject({
        promptCostPerMillion: 42_000,
        completionCostPerMillion: 0,
        source: 'openrouter',
      });
    }
  });

  it('preserves a manual override during refresh', async () => {
    const t = initConvexTest();
    await t.mutation(internal.billing.modelPricing.upsertInternal, {
      provider: 'openrouter',
      model: alias.id,
      promptCostPerMillion: 21_000,
      completionCostPerMillion: 0,
      source: 'manual',
    });
    await t.action(internal.billing.modelPricing.importFromOpenRouterInternal, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await t.query(internal.billing.modelPricing.getInternal, {
        provider: 'openrouter',
        model: alias.id,
      }),
    ).toMatchObject({ promptCostPerMillion: 21_000, source: 'manual' });
    const aliasWrites = vi
      .mocked(fetch)
      .mock.calls.filter(
        ([url, init]) =>
          init?.method === 'PUT' && decodeURIComponent(String(url)).includes(alias.id),
      );
    expect(aliasWrites).toHaveLength(0);
  });
});
