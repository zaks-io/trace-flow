import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ModelPricing } from '@trace-flow/pricing';
import type { fetchOpenRouterPricing as FetchOpenRouterPricingType } from '../openrouter-pricing';

const createMockKV = () => ({
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  getWithMetadata: vi.fn(),
});

const sampleOpenRouterResponse = {
  data: [
    {
      id: 'anthropic/claude-3-5-sonnet',
      pricing: {
        prompt: '0.000003',
        completion: '0.000015',
        input_cache_read: '0.0000003',
        input_cache_write: '0.00000375',
      },
    },
    {
      id: 'openai/gpt-4',
      pricing: {
        prompt: '0.00003',
        completion: '0.00006',
      },
    },
    {
      id: 'anthropic/claude-3-5-sonnet:beta',
      pricing: {
        prompt: '0.000003',
        completion: '0.000015',
        internal_reasoning: '0.000015',
      },
    },
    {
      id: 'typesafe/jev-1.13',
      canonical_slug: 'typesafe/jev-1.13-20260917',
      pricing: { prompt: '0.000000042', completion: '0' },
    },
    {
      id: '~typesafe/jev-latest',
      alias_target: { slug: 'typesafe/jev-1.13' },
      pricing: { prompt: '0.000000042', completion: '0' },
    },
    {
      id: 'typesafe/invalid',
      pricing: { prompt: '-1', completion: '0' },
    },
  ],
};

describe('openrouter-pricing', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let originalFetch: typeof fetch;
  let fetchOpenRouterPricing: typeof FetchOpenRouterPricingType;

  beforeEach(async () => {
    vi.resetModules();
    mockKV = createMockKV();
    originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sampleOpenRouterResponse),
    });

    const module = await import('../openrouter-pricing');
    fetchOpenRouterPricing = module.fetchOpenRouterPricing;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('fetchOpenRouterPricing', () => {
    it('should return pricing for exact model match', async () => {
      const result = await fetchOpenRouterPricing('anthropic/claude-3-5-sonnet', mockKV);

      expect(result).not.toBeNull();
      // 0.000003 * 1_000_000_000_000 = 3_000_000
      expect(result?.promptCostPerMillion).toBe(3000000);
      // 0.000015 * 1_000_000_000_000 = 15_000_000
      expect(result?.completionCostPerMillion).toBe(15000000);
      expect(result?.cacheReadCostPerMillion).toBe(300000);
      expect(result?.cacheWriteCostPerMillion).toBe(3750000);
      expect(result?.source).toBe('openrouter');
    });

    it('should handle models without cache pricing', async () => {
      const result = await fetchOpenRouterPricing('openai/gpt-4', mockKV);

      expect(result).not.toBeNull();
      expect(result?.promptCostPerMillion).toBe(30000000);
      expect(result?.completionCostPerMillion).toBe(60000000);
      expect(result?.cacheReadCostPerMillion).toBeUndefined();
      expect(result?.cacheWriteCostPerMillion).toBeUndefined();
    });

    it('should handle models with reasoning pricing', async () => {
      const result = await fetchOpenRouterPricing('anthropic/claude-3-5-sonnet:beta', mockKV);

      expect(result).not.toBeNull();
      expect(result?.reasoningCostPerMillion).toBe(15000000);
    });

    it.each([
      'typesafe/jev-1.13',
      'typesafe/jev-1.13-20260917',
      '~typesafe/jev-latest',
      'jev-1.13',
      'jev-latest',
    ])('prices decision identity %s using the discovered catalog', async (model) => {
      const result = await fetchOpenRouterPricing(model, mockKV);
      expect(result).toMatchObject({ promptCostPerMillion: 42_000, completionCostPerMillion: 0 });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models?output_modalities=text,decisions',
      );
    });

    it.each([
      'typesafe/jev-1.14',
      'typesafe/jev-1.13-20261005',
      'other/jev-1.13',
      'typesafe/invalid',
    ])('leaves unknown or invalid model %s unpriced and uncached', async (model) => {
      expect(await fetchOpenRouterPricing(model, mockKV)).toBeNull();
      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it('should return null for unknown model', async () => {
      const result = await fetchOpenRouterPricing('unknown/model', mockKV);

      expect(result).toBeNull();
    });

    it('should match an unqualified exact model name', async () => {
      const result = await fetchOpenRouterPricing('claude-3-5-sonnet', mockKV);

      expect(result).not.toBeNull();
      expect(result?.promptCostPerMillion).toBe(3000000);
    });

    it('should cache result in KV with correct key and TTL', async () => {
      await fetchOpenRouterPricing('anthropic/claude-3-5-sonnet', mockKV);

      expect(mockKV.put).toHaveBeenCalledWith(
        'pricing:openrouter:anthropic/claude-3-5-sonnet',
        expect.any(String),
        { expirationTtl: 86400 },
      );

      const putCall = mockKV.put.mock.calls[0]!;
      const cachedPricing = JSON.parse(putCall[1]) as ModelPricing;
      expect(cachedPricing.promptCostPerMillion).toBe(3000000);
      expect(cachedPricing.source).toBe('openrouter');
    });

    it('should return null on API error', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      vi.resetModules();
      const module = await import('../openrouter-pricing');
      const result = await module.fetchOpenRouterPricing('anthropic/claude-3-5-sonnet', mockKV);

      expect(result).toBeNull();
    });

    it('should return null on network failure', async () => {
      vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('Network error'));

      vi.resetModules();
      const module = await import('../openrouter-pricing');
      const result = await module.fetchOpenRouterPricing('anthropic/claude-3-5-sonnet', mockKV);

      expect(result).toBeNull();
    });

    it('should cache with custom key when cacheKey is provided', async () => {
      await fetchOpenRouterPricing(
        'anthropic/claude-3-5-sonnet',
        mockKV,
        'pricing:google:gemini-2.5-pro',
      );

      expect(mockKV.put).toHaveBeenCalledWith('pricing:google:gemini-2.5-pro', expect.any(String), {
        expirationTtl: 86400,
      });
    });

    it('should set updatedAt timestamp', async () => {
      const beforeTime = Date.now();

      const result = await fetchOpenRouterPricing('anthropic/claude-3-5-sonnet', mockKV);

      const afterTime = Date.now();

      expect(result?.updatedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(result?.updatedAt).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('in-memory caching', () => {
    it('should reuse cached data within TTL', async () => {
      await fetchOpenRouterPricing('anthropic/claude-3-5-sonnet', mockKV);
      await fetchOpenRouterPricing('openai/gpt-4', mockKV);

      // fetch should only be called once due to in-memory cache
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('refreshes decision pricing after five minutes instead of reusing stale catalog rates', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
      await fetchOpenRouterPricing('typesafe/jev-1.13', mockKV);
      now.mockReturnValue(1000 + 5 * 60 * 1000 + 1);
      vi.mocked(globalThis.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'typesafe/jev-1.13', pricing: { prompt: '0.000000084', completion: '0' } }],
        }),
      } as Response);
      const result = await fetchOpenRouterPricing('typesafe/jev-1.13', mockKV);
      expect(result?.promptCostPerMillion).toBe(84_000);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
  });
});
