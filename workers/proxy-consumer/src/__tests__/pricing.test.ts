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

      const result = await getPricing(mockKV as unknown as KVNamespace, 'openai', 'gpt-4');

      expect(mockKV.get).toHaveBeenCalledWith('pricing:openai:gpt-4', 'json');
      expect(result).toEqual(samplePricing);
    });

    it('should return pricing via prefix match when model has date suffix', async () => {
      mockKV.get.mockResolvedValueOnce(null).mockResolvedValueOnce(samplePricing);

      const result = await getPricing(
        mockKV as unknown as KVNamespace,
        'anthropic',
        'claude-3-5-sonnet-20250929',
      );

      expect(mockKV.get).toHaveBeenCalledWith(
        'pricing:anthropic:claude-3-5-sonnet-20250929',
        'json',
      );
      expect(mockKV.get).toHaveBeenCalledWith('pricing:anthropic:claude-3-5-sonnet', 'json');
      expect(result).toEqual(samplePricing);
    });

    it('should return null when no match found', async () => {
      mockKV.get.mockResolvedValue(null);

      const result = await getPricing(
        mockKV as unknown as KVNamespace,
        'openai',
        'unknown-model-20250929',
      );

      expect(result).toBeNull();
    });

    it('should return null for model without date suffix when not found', async () => {
      mockKV.get.mockResolvedValue(null);

      const result = await getPricing(mockKV as unknown as KVNamespace, 'openai', 'gpt-4');

      expect(mockKV.get).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    it('should not attempt prefix match for partial date patterns', async () => {
      mockKV.get.mockResolvedValue(null);

      const result = await getPricing(mockKV as unknown as KVNamespace, 'test', 'model-2025');

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
      expect(result.totalCostMicrodollars).toBe(10500);
    });

    it('should calculate all token types with specific pricing', () => {
      const pricing: ModelPricing = {
        ...basePricing,
        cacheReadCostPerMillion: 300000, // $0.30 per million
        cacheWriteCostPerMillion: 3750000, // $3.75 per million
        reasoningCostPerMillion: 15000000, // $15 per million
      };

      const tokens: LLMTokenUsage = {
        promptTokens: 1000,
        completionTokens: 500,
        cacheReadTokens: 2000,
        cacheCreationTokens: 100,
        reasoningTokens: 200,
      };

      const result = calculateCost(tokens, pricing);

      expect(result.inputCostMicrodollars).toBe(3000); // 1000 * 3M / 1M
      expect(result.outputCostMicrodollars).toBe(7500); // 500 * 15M / 1M
      expect(result.cacheReadCostMicrodollars).toBe(600); // 2000 * 300K / 1M
      expect(result.cacheWriteCostMicrodollars).toBe(375); // 100 * 3.75M / 1M
      expect(result.reasoningCostMicrodollars).toBe(3000); // 200 * 15M / 1M
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
