import { describe, expect, it } from 'vitest';
import type { LLMTokenUsage } from '@trace-flow/types';
import { calculateCost, type ModelPricing } from '../pricing';
import { priceCanonicalUsage, type CanonicalUsage } from '../canonical';

// $3/M in, $15/M out; reasoning falls back to the completion rate unless a test overrides it.
const pricing: ModelPricing = {
  promptCostPerMillion: 3_000_000,
  completionCostPerMillion: 15_000_000,
  updatedAt: 0,
  source: 'manual',
};

const withReasoningRate: ModelPricing = { ...pricing, reasoningCostPerMillion: 20_000_000 };

describe('calculateCost reasoning for providers whose completion includes reasoning', () => {
  it.each([undefined, 'openai', 'groq', 'anthropic', 'openrouter'])(
    'prices reasoning once for provider %s',
    (provider) => {
      const tokens: LLMTokenUsage = {
        promptTokens: 0,
        completionTokens: 1000,
        reasoningTokens: 200,
      };

      const cost = calculateCost(tokens, pricing, provider);

      expect(cost.outputCostMicrodollars).toBe(12_000); // (1000 - 200) * 15M / 1M
      expect(cost.reasoningCostMicrodollars).toBe(3_000); // 200 * 15M / 1M
      expect(cost.totalCostMicrodollars).toBe(15_000); // 1000 output-side tokens at 15M / 1M
    },
  );

  it('prices reasoning in full when completion is absent', () => {
    const cost = calculateCost({ reasoningTokens: 400 }, pricing, 'openai');

    expect(cost.outputCostMicrodollars).toBe(0);
    expect(cost.reasoningCostMicrodollars).toBe(6_000);
    expect(cost.totalCostMicrodollars).toBe(6_000);
  });

  it("keeps the thinking estimate for an interrupted Anthropic stream holding message_start's output", () => {
    const tokens: LLMTokenUsage = { completionTokens: 1, reasoningTokens: 5_000 };

    const cost = calculateCost(tokens, pricing, 'anthropic');

    expect(cost.outputCostMicrodollars).toBe(0);
    expect(cost.reasoningCostMicrodollars).toBe(75_000); // 5000 * 15M / 1M
    expect(cost.totalCostMicrodollars).toBe(75_000);
  });

  it('charges the full thinking estimate when it exceeds the final completion count', () => {
    const tokens: LLMTokenUsage = { completionTokens: 800, reasoningTokens: 1_000 };

    const cost = calculateCost(tokens, pricing, 'anthropic');

    // Output-side tokens = max(800, 1000); the 200-token estimate overshoot is accepted.
    expect(cost.outputCostMicrodollars).toBe(0);
    expect(cost.reasoningCostMicrodollars).toBe(15_000);
    expect(cost.totalCostMicrodollars).toBe(15_000);
  });

  it('prices the reasoning subset at an explicit reasoning rate', () => {
    const tokens: LLMTokenUsage = { completionTokens: 1000, reasoningTokens: 200 };

    const cost = calculateCost(tokens, withReasoningRate, 'openai');

    expect(cost.outputCostMicrodollars).toBe(12_000); // 800 * 15M / 1M
    expect(cost.reasoningCostMicrodollars).toBe(4_000); // 200 * 20M / 1M
    expect(cost.totalCostMicrodollars).toBe(16_000);
  });

  it('prices zero or absent reasoning the same as completion-only usage', () => {
    const completionOnly = calculateCost({ completionTokens: 1000 }, pricing, 'openai');
    const zeroReasoning = calculateCost(
      { completionTokens: 1000, reasoningTokens: 0 },
      pricing,
      'openai',
    );

    expect(zeroReasoning).toEqual(completionOnly);
    expect(completionOnly.outputCostMicrodollars).toBe(15_000);
    expect(completionOnly.totalCostMicrodollars).toBe(15_000);
  });
});

describe('calculateCost reasoning for Google, whose candidates exclude thoughts', () => {
  it('prices thoughts in full when there are no candidates', () => {
    const cost = calculateCost(
      { completionTokens: 0, reasoningTokens: 400 },
      withReasoningRate,
      'google',
    );

    expect(cost.outputCostMicrodollars).toBe(0);
    expect(cost.reasoningCostMicrodollars).toBe(8_000); // 400 * 20M / 1M
    expect(cost.totalCostMicrodollars).toBe(8_000);
  });

  it('prices candidates and thoughts independently when thoughts exceed candidates', () => {
    const cost = calculateCost(
      { completionTokens: 300, reasoningTokens: 1_000 },
      withReasoningRate,
      'google',
    );

    expect(cost.outputCostMicrodollars).toBe(4_500); // 300 * 15M / 1M, not clamped
    expect(cost.reasoningCostMicrodollars).toBe(20_000); // 1000 * 20M / 1M
    expect(cost.totalCostMicrodollars).toBe(24_500);
  });
});

describe('calculateCost matches canonical pricing for equivalent buckets', () => {
  const cachedPricing: ModelPricing = {
    ...withReasoningRate,
    cacheReadCostPerMillion: 300_000,
    cacheWriteCostPerMillion: 3_750_000,
  };
  const resolved = { key: 'pricing:test:model', pricing: cachedPricing };
  const canonical = (outputNonReasoning: number, reasoning: number): CanonicalUsage => ({
    inputUncached: 1_000,
    cacheRead: 2_000,
    cacheWrite: 100,
    outputNonReasoning,
    reasoning,
    unclassified: 0,
  });
  const promptSide: LLMTokenUsage = {
    promptTokens: 3_100,
    uncachedInputTokens: 1_000,
    cacheReadTokens: 2_000,
    cacheCreationTokens: 100,
  };

  it.each([undefined, 'openai', 'groq', 'anthropic', 'openrouter'])(
    'inclusive %s usage prices like disjoint canonical usage',
    (provider) => {
      const inclusive = calculateCost(
        { ...promptSide, completionTokens: 500, reasoningTokens: 200 },
        cachedPricing,
        provider,
      );
      const disjoint = priceCanonicalUsage(canonical(300, 200), resolved, {
        reported: 'default',
      });

      expect(disjoint.status).toBe('priced');
      expect(inclusive).toEqual(disjoint.breakdown);
    },
  );

  it('Google usage prices like canonical usage with candidates as non-reasoning output', () => {
    const google = calculateCost(
      { ...promptSide, completionTokens: 500, reasoningTokens: 200 },
      cachedPricing,
      'google',
    );
    const disjoint = priceCanonicalUsage(canonical(500, 200), resolved, { reported: 'default' });

    expect(disjoint.status).toBe('priced');
    expect(google).toEqual(disjoint.breakdown);
  });
});
