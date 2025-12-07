import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ModelPricing } from '../pricing';
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
      const result = await fetchOpenRouterPricing(
        'anthropic/claude-3-5-sonnet',
        mockKV as unknown as KVNamespace,
      );

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
      const result = await fetchOpenRouterPricing('openai/gpt-4', mockKV as unknown as KVNamespace);

      expect(result).not.toBeNull();
      expect(result?.promptCostPerMillion).toBe(30000000);
      expect(result?.completionCostPerMillion).toBe(60000000);
      expect(result?.cacheReadCostPerMillion).toBeUndefined();
      expect(result?.cacheWriteCostPerMillion).toBeUndefined();
    });

    it('should handle models with reasoning pricing', async () => {
      const result = await fetchOpenRouterPricing(
        'anthropic/claude-3-5-sonnet:beta',
        mockKV as unknown as KVNamespace,
      );

      expect(result).not.toBeNull();
      expect(result?.reasoningCostPerMillion).toBe(15000000);
    });

    it('should return null for unknown model', async () => {
      const result = await fetchOpenRouterPricing(
        'unknown/model',
        mockKV as unknown as KVNamespace,
      );

      expect(result).toBeNull();
    });

    it('should match by suffix for versioned models', async () => {
      // Model ID ends with our search term
      const result = await fetchOpenRouterPricing(
        'claude-3-5-sonnet',
        mockKV as unknown as KVNamespace,
      );

      expect(result).not.toBeNull();
      expect(result?.promptCostPerMillion).toBe(3000000);
    });

    it('should cache result in KV with correct key and TTL', async () => {
      await fetchOpenRouterPricing('anthropic/claude-3-5-sonnet', mockKV as unknown as KVNamespace);

      expect(mockKV.put).toHaveBeenCalledWith(
        'pricing:openrouter:anthropic/claude-3-5-sonnet',
        expect.any(String),
        { expirationTtl: 31536000 },
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
      const result = await module.fetchOpenRouterPricing(
        'anthropic/claude-3-5-sonnet',
        mockKV as unknown as KVNamespace,
      );

      expect(result).toBeNull();
    });

    it('should return null on network failure', async () => {
      vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('Network error'));

      vi.resetModules();
      const module = await import('../openrouter-pricing');
      const result = await module.fetchOpenRouterPricing(
        'anthropic/claude-3-5-sonnet',
        mockKV as unknown as KVNamespace,
      );

      expect(result).toBeNull();
    });

    it('should set updatedAt timestamp', async () => {
      const beforeTime = Date.now();

      const result = await fetchOpenRouterPricing(
        'anthropic/claude-3-5-sonnet',
        mockKV as unknown as KVNamespace,
      );

      const afterTime = Date.now();

      expect(result?.updatedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(result?.updatedAt).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('in-memory caching', () => {
    it('should reuse cached data within TTL', async () => {
      await fetchOpenRouterPricing('anthropic/claude-3-5-sonnet', mockKV as unknown as KVNamespace);
      await fetchOpenRouterPricing('openai/gpt-4', mockKV as unknown as KVNamespace);

      // fetch should only be called once due to in-memory cache
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });
});
