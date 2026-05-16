import { describe, it, expect } from 'vitest';
import { parseTokenUsage } from '../parseTokenUsage';

describe('parseTokenUsage (openai)', () => {
  it('should parse basic prompt/completion/total', () => {
    const body = JSON.stringify({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    });

    const result = parseTokenUsage(body, 'openai');

    expect(result).toEqual({
      promptTokens: 100,
      uncachedInputTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
  });

  it('should map cached_tokens to cacheReadTokens', () => {
    const body = JSON.stringify({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: {
          cached_tokens: 25,
        },
      },
    });

    const result = parseTokenUsage(body, 'openai');

    expect(result).toEqual({
      promptTokens: 100,
      uncachedInputTokens: 75,
      completionTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 25,
    });
  });

  it('should parse reasoning_tokens', () => {
    const body = JSON.stringify({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        completion_tokens_details: {
          reasoning_tokens: 20,
        },
      },
    });

    const result = parseTokenUsage(body, 'openai');

    expect(result).toEqual({
      promptTokens: 100,
      uncachedInputTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      reasoningTokens: 20,
    });
  });

  it('should handle partial usage data', () => {
    const body = JSON.stringify({
      usage: { prompt_tokens: 100 },
    });

    const result = parseTokenUsage(body, 'openai');

    expect(result?.promptTokens).toBe(100);
    expect(result?.completionTokens).toBeUndefined();
  });

  it('should return undefined when no token fields found', () => {
    const body = JSON.stringify({ id: 'chatcmpl-123', choices: [] });
    expect(parseTokenUsage(body, 'openai')).toBeUndefined();
  });

  describe('Responses API shape', () => {
    it('should parse input_tokens/output_tokens/total_tokens', () => {
      const body = JSON.stringify({
        usage: {
          input_tokens: 200,
          output_tokens: 80,
          total_tokens: 280,
        },
      });

      const result = parseTokenUsage(body, 'openai');

      expect(result).toEqual({
        promptTokens: 200,
        uncachedInputTokens: 200,
        completionTokens: 80,
        totalTokens: 280,
      });
    });

    it('should map cached_tokens under input_tokens_details to cacheReadTokens', () => {
      const body = JSON.stringify({
        usage: {
          input_tokens: 2006,
          output_tokens: 300,
          total_tokens: 2306,
          input_tokens_details: { cached_tokens: 1920 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      });

      const result = parseTokenUsage(body, 'openai');

      expect(result).toEqual({
        promptTokens: 2006,
        uncachedInputTokens: 86,
        completionTokens: 300,
        totalTokens: 2306,
        cacheReadTokens: 1920,
        reasoningTokens: 0,
      });
    });

    it('should parse reasoning_tokens nested under output_tokens_details', () => {
      const body = JSON.stringify({
        usage: {
          input_tokens: 100,
          output_tokens: 500,
          total_tokens: 600,
          output_tokens_details: { reasoning_tokens: 350 },
        },
      });

      const result = parseTokenUsage(body, 'openai');

      expect(result?.reasoningTokens).toBe(350);
      expect(result?.promptTokens).toBe(100);
      expect(result?.completionTokens).toBe(500);
    });
  });
});
