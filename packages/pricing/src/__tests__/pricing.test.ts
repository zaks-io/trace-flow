import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getPricing,
  calculateCost,
  microdollarsToDollars,
  formatCostAsString,
  type ModelPricing,
} from '../pricing';
import type { LLMTokenUsage } from '@trace-flow/types';

const createMockKV = () => ({
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  getWithMetadata: vi.fn(),
});

describe('pricing', () => {
  describe('getPricing', () => {
    let mockKV: ReturnType<typeof createMockKV>;

    const samplePricing: ModelPricing = {
      promptCostPerMillion: 3000000,
      completionCostPerMillion: 15000000,
      updatedAt: Date.now(),
      source: 'openrouter',
    };

    beforeEach(() => {
      mockKV = createMockKV();
    });

    it('should return pricing when exact match found', async () => {
      mockKV.get.mockResolvedValue(samplePricing);

      const result = await getPricing(mockKV, 'openai', 'gpt-4');

      expect(mockKV.get).toHaveBeenCalledWith('pricing:openai:gpt-4', 'json');
      expect(result).toEqual(samplePricing);
    });

    it('should return pricing via prefix match when model has date suffix', async () => {
      mockKV.get.mockResolvedValueOnce(null).mockResolvedValueOnce(samplePricing);

      const result = await getPricing(mockKV, 'anthropic', 'claude-3-5-sonnet-20250929');

      expect(mockKV.get).toHaveBeenCalledWith(
        'pricing:anthropic:claude-3-5-sonnet-20250929',
        'json',
      );
      expect(mockKV.get).toHaveBeenCalledWith('pricing:anthropic:claude-3-5-sonnet', 'json');
      expect(result).toEqual(samplePricing);
    });

    it('should return null when no match found (unpriced model → null cost)', async () => {
      mockKV.get.mockResolvedValue(null);

      const result = await getPricing(mockKV, 'openai', 'unknown-model-20250929');

      expect(result).toBeNull();
    });

    it('should return null for model without date suffix when not found', async () => {
      mockKV.get.mockResolvedValue(null);

      const result = await getPricing(mockKV, 'openai', 'gpt-4');

      expect(mockKV.get).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    it('should not attempt prefix match for version suffixes like claude-sonnet-4-6', async () => {
      mockKV.get.mockResolvedValue(null);

      const result = await getPricing(mockKV, 'anthropic', 'claude-sonnet-4-6');

      expect(mockKV.get).toHaveBeenCalledTimes(1);
      expect(mockKV.get).toHaveBeenCalledWith('pricing:anthropic:claude-sonnet-4-6', 'json');
      expect(result).toBeNull();
    });

    it('should not attempt prefix match for partial date patterns', async () => {
      mockKV.get.mockResolvedValue(null);

      const result = await getPricing(mockKV, 'test', 'model-2025');

      // Only one call because -2025 is not a valid 8-digit date suffix
      expect(mockKV.get).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });
  });

  describe('calculateCost', () => {
    const basePricing: ModelPricing = {
      promptCostPerMillion: 3000000, // $3 per million tokens
      completionCostPerMillion: 15000000, // $15 per million tokens
      updatedAt: Date.now(),
      source: 'manual',
    };

    it('should calculate basic prompt and completion costs', () => {
      const tokens: LLMTokenUsage = {
        promptTokens: 1000,
        completionTokens: 500,
      };

      const result = calculateCost(tokens, basePricing);

      // 1000 * 3000000 / 1_000_000 = 3000 microdollars
      expect(result.inputCostMicrodollars).toBe(3000);
      // 500 * 15000000 / 1_000_000 = 7500 microdollars
      expect(result.outputCostMicrodollars).toBe(7500);
      expect(result.promptBaselineCostMicrodollars).toBe(3000);
      expect(result.cacheImpactCostMicrodollars).toBe(0);
      expect(result.totalCostMicrodollars).toBe(10500);
    });

    it('should calculate all token types with specific pricing', () => {
      const pricing: ModelPricing = {
        ...basePricing,
        cacheReadCostPerMillion: 300000, // $0.30 per million
        cacheWriteCostPerMillion: 3750000, // $3.75 per million
        reasoningCostPerMillion: 15000000, // $15 per million
      };

      // Canonical prompt total = uncached + cache reads + cache writes.
      const tokens: LLMTokenUsage = {
        promptTokens: 3100,
        uncachedInputTokens: 1000,
        completionTokens: 500,
        cacheReadTokens: 2000,
        cacheCreationTokens: 100,
        reasoningTokens: 200,
      };

      const result = calculateCost(tokens, pricing);

      // Uncached input: 1000 * 3M / 1M = 3000
      expect(result.inputCostMicrodollars).toBe(3000);
      expect(result.outputCostMicrodollars).toBe(7500); // 500 * 15M / 1M
      expect(result.cacheReadCostMicrodollars).toBe(600); // 2000 * 300K / 1M
      expect(result.cacheWriteCostMicrodollars).toBe(375); // 100 * 3.75M / 1M
      expect(result.reasoningCostMicrodollars).toBe(3000); // 200 * 15M / 1M
      expect(result.promptBaselineCostMicrodollars).toBe(9300); // 3100 * 3M / 1M
      expect(result.cacheImpactCostMicrodollars).toBe(5325); // 9300 - (3000 + 600 + 375)
      expect(result.totalCostMicrodollars).toBe(14475);
    });

    it('should handle missing optional tokens as zero', () => {
      const tokens: LLMTokenUsage = {
        promptTokens: 1000,
      };

      const result = calculateCost(tokens, basePricing);

      expect(result.inputCostMicrodollars).toBe(3000);
      expect(result.outputCostMicrodollars).toBe(0);
      expect(result.cacheReadCostMicrodollars).toBe(0);
      expect(result.cacheWriteCostMicrodollars).toBe(0);
      expect(result.reasoningCostMicrodollars).toBe(0);
      expect(result.promptBaselineCostMicrodollars).toBe(3000);
      expect(result.cacheImpactCostMicrodollars).toBe(0);
      expect(result.totalCostMicrodollars).toBe(3000);
    });

    it('should fall back to prompt pricing for cache tokens when cache pricing unavailable', () => {
      const tokens: LLMTokenUsage = {
        promptTokens: 0,
        cacheReadTokens: 1000,
        cacheCreationTokens: 1000,
      };

      const result = calculateCost(tokens, basePricing);

      // Both should use prompt pricing ($3 per million)
      expect(result.cacheReadCostMicrodollars).toBe(3000);
      expect(result.cacheWriteCostMicrodollars).toBe(3000);
    });

    it('should fall back to completion pricing for reasoning tokens when reasoning pricing unavailable', () => {
      const tokens: LLMTokenUsage = {
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 1000,
      };

      const result = calculateCost(tokens, basePricing);

      // Should use completion pricing ($15 per million)
      expect(result.reasoningCostMicrodollars).toBe(15000);
    });

    it('should return zero for all costs when tokens are zero', () => {
      const tokens: LLMTokenUsage = {
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      };

      const result = calculateCost(tokens, basePricing);

      expect(result.inputCostMicrodollars).toBe(0);
      expect(result.outputCostMicrodollars).toBe(0);
      expect(result.cacheReadCostMicrodollars).toBe(0);
      expect(result.cacheWriteCostMicrodollars).toBe(0);
      expect(result.reasoningCostMicrodollars).toBe(0);
      expect(result.promptBaselineCostMicrodollars).toBe(0);
      expect(result.cacheImpactCostMicrodollars).toBe(0);
      expect(result.totalCostMicrodollars).toBe(0);
    });

    it('should handle large token counts', () => {
      const tokens: LLMTokenUsage = {
        promptTokens: 100000,
        completionTokens: 50000,
      };

      const result = calculateCost(tokens, basePricing);

      // 100000 * 3M / 1M = 300000 microdollars = $0.30
      expect(result.inputCostMicrodollars).toBe(300000);
      // 50000 * 15M / 1M = 750000 microdollars = $0.75
      expect(result.outputCostMicrodollars).toBe(750000);
      expect(result.totalCostMicrodollars).toBe(1050000);
    });

    it('should round to whole microdollars', () => {
      const pricing: ModelPricing = {
        ...basePricing,
        promptCostPerMillion: 1500000, // $1.50 per million (causes fractional result)
      };

      const tokens: LLMTokenUsage = {
        promptTokens: 1, // 1 * 1.5M / 1M = 1.5, should round to 2
      };

      const result = calculateCost(tokens, pricing);

      expect(Number.isInteger(result.inputCostMicrodollars)).toBe(true);
    });

    it('should not double-count cached input tokens', () => {
      // Anthropic-style: input_tokens includes cache_read_input_tokens
      const tokens: LLMTokenUsage = {
        promptTokens: 1000, // Total input (includes cached)
        completionTokens: 500,
        cacheReadTokens: 800, // 800 of the 1000 are cached
      };

      const pricing: ModelPricing = {
        promptCostPerMillion: 3_000_000, // $3/M
        completionCostPerMillion: 15_000_000, // $15/M
        cacheReadCostPerMillion: 300_000, // $0.30/M
        updatedAt: Date.now(),
        source: 'manual',
      };

      const cost = calculateCost(tokens, pricing);

      // Non-cached input: 200 tokens @ $3/M = 600 microdollars
      expect(cost.inputCostMicrodollars).toBe(600);
      // Cache read: 800 tokens @ $0.30/M = 240 microdollars
      expect(cost.cacheReadCostMicrodollars).toBe(240);
      // Output: 500 tokens @ $15/M = 7500 microdollars
      expect(cost.outputCostMicrodollars).toBe(7500);
      // Total: 600 + 240 + 7500 = 8340 microdollars
      expect(cost.totalCostMicrodollars).toBe(8340);
    });

    it('should charge zero input cost when all tokens are cached (100% cache hit)', () => {
      const tokens: LLMTokenUsage = {
        promptTokens: 1000,
        completionTokens: 500,
        cacheReadTokens: 1000,
      };

      const pricing: ModelPricing = {
        promptCostPerMillion: 3_000_000,
        completionCostPerMillion: 15_000_000,
        cacheReadCostPerMillion: 300_000,
        updatedAt: Date.now(),
        source: 'manual',
      };

      const cost = calculateCost(tokens, pricing);

      // All 1000 prompt tokens are cached → non-cached = max(0, 1000 - 1000) = 0
      expect(cost.inputCostMicrodollars).toBe(0);
      // Cache read: 1000 * 300K / 1M = 300
      expect(cost.cacheReadCostMicrodollars).toBe(300);
      // Output: 500 * 15M / 1M = 7500
      expect(cost.outputCostMicrodollars).toBe(7500);
      expect(cost.totalCostMicrodollars).toBe(7800);
    });

    it('should handle when cacheReadTokens exceeds promptTokens (edge case)', () => {
      // Defensive: if data is inconsistent, don't go negative
      const tokens: LLMTokenUsage = {
        promptTokens: 500,
        cacheReadTokens: 800, // More than prompt (shouldn't happen, but be safe)
      };

      const pricing: ModelPricing = {
        promptCostPerMillion: 3_000_000,
        completionCostPerMillion: 15_000_000,
        cacheReadCostPerMillion: 300_000,
        updatedAt: Date.now(),
        source: 'manual',
      };

      const cost = calculateCost(tokens, pricing);

      // Math.max(0, 500 - 800) = 0
      expect(cost.inputCostMicrodollars).toBe(0);
      // Cache read still charged: 800 * 0.3M / 1M = 240
      expect(cost.cacheReadCostMicrodollars).toBe(240);
    });

    it('should calculate tiered cache write cost with 5m/1h breakdown', () => {
      const tokens: LLMTokenUsage = {
        promptTokens: 1000,
        completionTokens: 500,
        cacheCreationTokens: 556,
        cacheCreation5mTokens: 456,
        cacheCreation1hTokens: 100,
      };

      const pricing: ModelPricing = {
        promptCostPerMillion: 3_000_000,
        completionCostPerMillion: 15_000_000,
        cacheWriteCostPerMillion: 3_750_000, // 5m rate (1.25x)
        cacheWrite1hCostPerMillion: 6_000_000, // 1h rate (2x)
        updatedAt: Date.now(),
        source: 'manual',
      };

      const cost = calculateCost(tokens, pricing);

      // 5m: 456 * 3.75M / 1M = 1710
      // 1h: 100 * 6M / 1M = 600
      // Total cache write: 2310
      expect(cost.cacheWriteCostMicrodollars).toBe(2310);
    });

    it('should fall back to cacheWriteCostPerMillion for 1h tier when cacheWrite1hCostPerMillion missing', () => {
      const tokens: LLMTokenUsage = {
        promptTokens: 1000,
        completionTokens: 500,
        cacheCreationTokens: 200,
        cacheCreation5mTokens: 100,
        cacheCreation1hTokens: 100,
      };

      const pricing: ModelPricing = {
        promptCostPerMillion: 3_000_000,
        completionCostPerMillion: 15_000_000,
        cacheWriteCostPerMillion: 3_750_000, // 5m rate
        // no cacheWrite1hCostPerMillion → falls back to cacheWriteCostPerMillion
        updatedAt: Date.now(),
        source: 'manual',
      };

      const cost = calculateCost(tokens, pricing);

      // 5m: 100 * 3.75M / 1M = 375
      // 1h: 100 * 3.75M / 1M = 375  (same as cacheWrite)
      expect(cost.cacheWriteCostMicrodollars).toBe(750);
    });

    it('should use aggregate cacheCreationTokens when no 5m/1h breakdown', () => {
      const tokens: LLMTokenUsage = {
        promptTokens: 1000,
        completionTokens: 500,
        cacheCreationTokens: 556,
        // no cacheCreation5mTokens or cacheCreation1hTokens
      };

      const pricing: ModelPricing = {
        promptCostPerMillion: 3_000_000,
        completionCostPerMillion: 15_000_000,
        cacheWriteCostPerMillion: 3_750_000,
        cacheWrite1hCostPerMillion: 6_000_000,
        updatedAt: Date.now(),
        source: 'manual',
      };

      const cost = calculateCost(tokens, pricing);

      // All at 5m rate: 556 * 3.75M / 1M = 2085
      expect(cost.cacheWriteCostMicrodollars).toBe(2085);
    });

    it('prices the aggregate when the 5m/1h split is explicitly 0/0 (older Claude transcripts)', () => {
      // The agent consumer always sets the split fields; older transcripts report 0/0 while the
      // aggregate is non-zero. This must price the aggregate, not $0.
      const tokens: LLMTokenUsage = {
        promptTokens: 1000,
        completionTokens: 500,
        cacheCreationTokens: 556,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
      };

      const pricing: ModelPricing = {
        promptCostPerMillion: 3_000_000,
        completionCostPerMillion: 15_000_000,
        cacheWriteCostPerMillion: 3_750_000,
        cacheWrite1hCostPerMillion: 6_000_000,
        updatedAt: Date.now(),
        source: 'manual',
      };

      const cost = calculateCost(tokens, pricing);

      // Falls back to the aggregate at the 5m rate: 556 * 3.75M / 1M = 2085 (not 0).
      expect(cost.cacheWriteCostMicrodollars).toBe(2085);
    });

    it('should correctly calculate cost with no cached tokens', () => {
      const tokens: LLMTokenUsage = {
        promptTokens: 1000,
        completionTokens: 500,
        // No cacheReadTokens
      };

      const pricing: ModelPricing = {
        promptCostPerMillion: 3_000_000,
        completionCostPerMillion: 15_000_000,
        cacheReadCostPerMillion: 300_000,
        updatedAt: Date.now(),
        source: 'manual',
      };

      const cost = calculateCost(tokens, pricing);

      // Full prompt charged: 1000 * 3M / 1M = 3000
      expect(cost.inputCostMicrodollars).toBe(3000);
      expect(cost.cacheReadCostMicrodollars).toBe(0);
      expect(cost.outputCostMicrodollars).toBe(7500);
      expect(cost.totalCostMicrodollars).toBe(10500);
    });
  });

  describe('gpt-5.5 context-tier pricing', () => {
    // gpt-5.5 prices ~2x above a 200k-token context; Codex runs near a 258k window, so a flat rate
    // would undercount it. Base $1.25/M in, $10/M out; tier $2.50/M in, $20/M out at >= 200k.
    const tieredPricing: ModelPricing = {
      promptCostPerMillion: 1_250_000,
      completionCostPerMillion: 10_000_000,
      contextTier: {
        thresholdTokens: 200_000,
        promptCostPerMillion: 2_500_000,
        completionCostPerMillion: 20_000_000,
      },
      updatedAt: Date.now(),
      source: 'manual',
    };

    it('charges the base rate below the 200k-token context threshold', () => {
      const tokens: LLMTokenUsage = { promptTokens: 199_999, completionTokens: 1000 };

      const cost = calculateCost(tokens, tieredPricing);

      // 199999 * 1.25M / 1M = 249998.75 → round 249999
      expect(cost.inputCostMicrodollars).toBe(249_999);
      // 1000 * 10M / 1M = 10000 (base completion rate)
      expect(cost.outputCostMicrodollars).toBe(10_000);
    });

    it('charges the tier rate at exactly the threshold (inclusive boundary)', () => {
      const tokens: LLMTokenUsage = { promptTokens: 200_000, completionTokens: 1000 };

      const cost = calculateCost(tokens, tieredPricing);

      // 200000 * 2.5M / 1M = 500000 (tier prompt rate)
      expect(cost.inputCostMicrodollars).toBe(500_000);
      // 1000 * 20M / 1M = 20000 (tier completion rate)
      expect(cost.outputCostMicrodollars).toBe(20_000);
    });

    it('charges the tier rate well above the threshold (258k Codex-style window)', () => {
      const tokens: LLMTokenUsage = { promptTokens: 258_000, completionTokens: 2000 };

      const cost = calculateCost(tokens, tieredPricing);

      // 258000 * 2.5M / 1M = 645000
      expect(cost.inputCostMicrodollars).toBe(645_000);
      // 2000 * 20M / 1M = 40000
      expect(cost.outputCostMicrodollars).toBe(40_000);
    });

    it('leaves pricing without a contextTier on the flat base rate at any context size', () => {
      const flat: ModelPricing = {
        promptCostPerMillion: 1_250_000,
        completionCostPerMillion: 10_000_000,
        updatedAt: Date.now(),
        source: 'manual',
      };
      const tokens: LLMTokenUsage = { promptTokens: 500_000, completionTokens: 1000 };

      const cost = calculateCost(tokens, flat);

      // 500000 * 1.25M / 1M = 625000 — no tier escalation
      expect(cost.inputCostMicrodollars).toBe(625_000);
      expect(cost.outputCostMicrodollars).toBe(10_000);
    });
  });

  describe('microdollarsToDollars', () => {
    it('should convert 1,000,000 microdollars to 1 dollar', () => {
      expect(microdollarsToDollars(1000000)).toBe(1);
    });

    it('should convert 0 microdollars to 0 dollars', () => {
      expect(microdollarsToDollars(0)).toBe(0);
    });

    it('should handle small amounts (fractional dollars)', () => {
      expect(microdollarsToDollars(500000)).toBe(0.5);
      expect(microdollarsToDollars(1)).toBe(0.000001);
      expect(microdollarsToDollars(100)).toBe(0.0001);
    });
  });

  describe('formatCostAsString', () => {
    it('should format whole dollar amounts', () => {
      expect(formatCostAsString(1000000)).toBe('1');
      expect(formatCostAsString(2000000)).toBe('2');
    });

    it('should strip trailing zeros', () => {
      expect(formatCostAsString(500000)).toBe('0.5');
      expect(formatCostAsString(1500000)).toBe('1.5');
    });

    it('should handle very small costs (up to 8 decimal places)', () => {
      expect(formatCostAsString(1)).toBe('0.000001');
      expect(formatCostAsString(10)).toBe('0.00001');
    });

    it('should return "0" for zero cost', () => {
      expect(formatCostAsString(0)).toBe('0');
    });

    it('should handle sub-microdollar precision correctly', () => {
      // 12345 microdollars = 0.012345 dollars
      expect(formatCostAsString(12345)).toBe('0.012345');
    });
  });
});
