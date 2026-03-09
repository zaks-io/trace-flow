import { describe, it, expect } from 'vitest';
import { parseTokenUsage } from '../../parsers/providers';

describe('parseTokenUsage (dispatcher)', () => {
  describe('with provider specified', () => {
    it('should parse OpenAI tokens when provider is openai', () => {
      const response = JSON.stringify({
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });

      const result = parseTokenUsage(response, 'openai');

      expect(result).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        uncachedInputTokens: 100,
      });
    });

    it('should normalize Anthropic tokens when provider is anthropic', () => {
      const response = JSON.stringify({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 25,
        },
      });

      const result = parseTokenUsage(response, 'anthropic');

      expect(result).toEqual({
        promptTokens: 125, // 100 + 25
        completionTokens: 50,
        totalTokens: 175,
        cacheReadTokens: 25,
        uncachedInputTokens: 100,
      });
    });

    it('should parse Google tokens when provider is google', () => {
      const response = JSON.stringify({
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          totalTokenCount: 150,
        },
      });

      const result = parseTokenUsage(response, 'google');

      expect(result).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        uncachedInputTokens: 100,
      });
    });
  });

  describe('cache normalization per provider', () => {
    it('should handle Anthropic with no cache (just input + output)', () => {
      const response = JSON.stringify({
        usage: { input_tokens: 500, output_tokens: 100 },
      });

      const result = parseTokenUsage(response, 'anthropic');

      expect(result).toEqual({
        promptTokens: 500,
        completionTokens: 100,
        totalTokens: 600,
        uncachedInputTokens: 500,
      });
    });

    it('should handle Anthropic with both cache read and write', () => {
      const response = JSON.stringify({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 200,
        },
      });

      const result = parseTokenUsage(response, 'anthropic');

      expect(result).toEqual({
        promptTokens: 1100, // 100 + 800 + 200
        completionTokens: 50,
        totalTokens: 1150,
        uncachedInputTokens: 100,
        cacheReadTokens: 800,
        cacheCreationTokens: 200,
      });
    });

    it('should handle OpenAI with cached_tokens', () => {
      const response = JSON.stringify({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          total_tokens: 1200,
          prompt_tokens_details: { cached_tokens: 600 },
        },
      });

      const result = parseTokenUsage(response, 'openai');

      expect(result).toEqual({
        promptTokens: 1000,
        completionTokens: 200,
        totalTokens: 1200,
        cacheReadTokens: 600,
        uncachedInputTokens: 400,
      });
    });

    it('should handle OpenRouter with cache_write_tokens', () => {
      const response = JSON.stringify({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          total_tokens: 1200,
          prompt_tokens_details: {
            cached_tokens: 300,
            cache_write_tokens: 500,
          },
          cost: 0.0042,
        },
      });

      const result = parseTokenUsage(response, 'openrouter');

      expect(result).toEqual({
        promptTokens: 1000,
        completionTokens: 200,
        totalTokens: 1200,
        cacheReadTokens: 300,
        cacheCreationTokens: 500,
        uncachedInputTokens: 200,
        upstreamCost: 0.0042,
      });
    });

    it('should handle Groq (no caching, uncachedInputTokens = promptTokens)', () => {
      const response = JSON.stringify({
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });

      const result = parseTokenUsage(response, 'groq');

      expect(result).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        uncachedInputTokens: 100,
      });
    });

    it('should handle Google with cachedContentTokenCount', () => {
      const response = JSON.stringify({
        usageMetadata: {
          promptTokenCount: 500,
          candidatesTokenCount: 100,
          totalTokenCount: 600,
          cachedContentTokenCount: 300,
        },
      });

      const result = parseTokenUsage(response, 'google');

      expect(result).toEqual({
        promptTokens: 500,
        completionTokens: 100,
        totalTokens: 600,
        cacheReadTokens: 300,
        uncachedInputTokens: 200,
      });
    });
  });

  describe('auto-detect (no provider)', () => {
    it('should auto-detect OpenAI-style tokens', () => {
      const response = JSON.stringify({
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });

      const result = parseTokenUsage(response);

      expect(result?.promptTokens).toBe(100);
      expect(result?.completionTokens).toBe(50);
    });

    it('should auto-detect Google-style tokens', () => {
      const response = JSON.stringify({
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      });

      const result = parseTokenUsage(response);

      expect(result?.promptTokens).toBe(10);
      expect(result?.completionTokens).toBe(5);
    });
  });

  describe('anthropic cache breakdown', () => {
    it('should extract Anthropic ephemeral cache breakdown via dispatcher', () => {
      const response = JSON.stringify({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 600,
          cache_read_input_tokens: 0,
          cache_creation: {
            ephemeral_5m_input_tokens: 500,
            ephemeral_1h_input_tokens: 100,
          },
        },
      });

      const result = parseTokenUsage(response, 'anthropic');

      expect(result?.promptTokens).toBe(700); // input_tokens + cache_read (0) + cache_creation (600)
      expect(result?.uncachedInputTokens).toBe(100);
      expect(result?.cacheCreationTokens).toBe(600);
      expect(result?.cacheCreation5mTokens).toBe(500);
      expect(result?.cacheCreation1hTokens).toBe(100);
    });
  });

  describe('edge cases', () => {
    it('should return undefined for response without usage field', () => {
      const response = JSON.stringify({ id: 'chatcmpl-123', choices: [] });
      expect(parseTokenUsage(response)).toBeUndefined();
    });

    it('should return undefined for invalid JSON', () => {
      expect(parseTokenUsage('not valid json')).toBeUndefined();
    });

    it('should return undefined for non-object response', () => {
      expect(parseTokenUsage(JSON.stringify('string value'))).toBeUndefined();
    });
  });
});
