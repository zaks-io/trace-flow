import { describe, it, expect } from 'vitest';
import { createTokenAccumulator } from '../accumulator';
import { parseTokenUsage } from '../parseTokenUsage';

describe('createTokenAccumulator', () => {
  it('returns undefined when no events accepted', () => {
    const acc = createTokenAccumulator('openai');
    expect(acc.finalize()).toBeUndefined();
  });

  describe('openai single event parity with parseTokenUsage', () => {
    it('matches whole-body extraction for prompt + cached tokens', () => {
      const body = JSON.stringify({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          total_tokens: 1200,
          prompt_tokens_details: { cached_tokens: 600 },
        },
      });

      const bodyResult = parseTokenUsage(body, 'openai');

      const acc = createTokenAccumulator('openai');
      acc.acceptEvent({
        input_tokens: 1000,
        output_tokens: 200,
        cached_tokens: 600,
      });
      const accResult = acc.finalize();

      expect(accResult?.promptTokens).toBe(bodyResult?.promptTokens);
      expect(accResult?.uncachedInputTokens).toBe(bodyResult?.uncachedInputTokens);
      expect(accResult?.cacheReadTokens).toBe(bodyResult?.cacheReadTokens);
      expect(accResult?.completionTokens).toBe(bodyResult?.completionTokens);
    });
  });

  describe('anthropic normalization', () => {
    it('promptTokens = input + cacheRead + cacheCreation across multiple events', () => {
      const acc = createTokenAccumulator('anthropic');
      acc.acceptEvent({ input_tokens: 100 });
      acc.acceptEvent({ output_tokens: 50, cache_read_input_tokens: 800 });
      acc.acceptEvent({ cache_creation_input_tokens: 200 });

      const result = acc.finalize();

      expect(result).toEqual({
        promptTokens: 1100,
        uncachedInputTokens: 100,
        completionTokens: 50,
        totalTokens: 1150,
        cacheReadTokens: 800,
        cacheCreationTokens: 200,
      });
    });

    it('promotes nested ephemeral 5m/1h to cacheCreationTokens when missing', () => {
      const acc = createTokenAccumulator('anthropic');
      acc.acceptEvent({
        input_tokens: 100,
        output_tokens: 50,
        ephemeral_5m_input_tokens: 300,
        ephemeral_1h_input_tokens: 200,
      });

      const result = acc.finalize();

      expect(result?.cacheCreationTokens).toBe(500);
      expect(result?.cacheCreation5mTokens).toBe(300);
      expect(result?.cacheCreation1hTokens).toBe(200);
      expect(result?.promptTokens).toBe(600);
    });

    it('estimates reasoningTokens from thinking chars when no reasoning_tokens present', () => {
      const acc = createTokenAccumulator('anthropic');
      acc.acceptEvent({ input_tokens: 100, output_tokens: 50 });
      acc.acceptThinkingChars(400);

      const result = acc.finalize();

      expect(result?.reasoningTokens).toBe(100);
    });
  });

  describe('google normalization', () => {
    it('sums cumulative usageMetadata-style tokens and uses last total_token_count', () => {
      const acc = createTokenAccumulator('google');
      // Google sends cumulative metadata per chunk; the proxy currently feeds the raw
      // values per event. The accumulator's job is to track the last `total_token_count`.
      acc.acceptEvent({ prompt_token_count: 8, total_token_count: 8 });
      acc.acceptEvent({ candidates_token_count: 7, total_token_count: 15 });

      const result = acc.finalize();

      expect(result?.totalTokens).toBe(15);
      expect(result?.completionTokens).toBe(7);
    });

    it('maps cached_content_token_count to cacheReadTokens', () => {
      const acc = createTokenAccumulator('google');
      acc.acceptEvent({
        prompt_token_count: 500,
        candidates_token_count: 100,
        cached_content_token_count: 300,
        total_token_count: 600,
      });

      const result = acc.finalize();

      expect(result?.cacheReadTokens).toBe(300);
      expect(result?.uncachedInputTokens).toBe(200);
      expect(result?.totalTokens).toBe(600);
    });
  });

  describe('openrouter', () => {
    it('keeps last upstream cost across events', () => {
      const acc = createTokenAccumulator('openrouter');
      acc.acceptEvent({ input_tokens: 100, output_tokens: 50, cost: 0.001 });
      acc.acceptEvent({ cost: 0.0042 });

      const result = acc.finalize();

      expect(result?.upstreamCost).toBe(0.0042);
    });

    it('adds cache_write_tokens to cacheCreationTokens', () => {
      const acc = createTokenAccumulator('openrouter');
      acc.acceptEvent({
        input_tokens: 1000,
        output_tokens: 200,
        cached_tokens: 300,
        cache_write_tokens: 500,
      });

      const result = acc.finalize();

      expect(result?.cacheReadTokens).toBe(300);
      expect(result?.cacheCreationTokens).toBe(500);
      expect(result?.uncachedInputTokens).toBe(200);
    });
  });
});
