import { describe, it, expect } from 'vitest';
import { parseTokenUsage } from '../../parsers/tokens';

describe('parseTokenUsage', () => {
  describe('OpenAI-style tokens', () => {
    it('should parse valid OpenAI response with full usage', () => {
      const response = JSON.stringify({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        },
      });

      const result = parseTokenUsage(response);

      expect(result).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      });
    });

    it('should parse response with cached tokens count', () => {
      const response = JSON.stringify({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          prompt_tokens_details: {
            cached_tokens: 25,
          },
        },
      });

      const result = parseTokenUsage(response);

      expect(result).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        cachedTokens: 25,
      });
    });

    it('should parse response with reasoning tokens', () => {
      const response = JSON.stringify({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          completion_tokens_details: {
            reasoning_tokens: 20,
          },
        },
      });

      const result = parseTokenUsage(response);

      expect(result).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        reasoningTokens: 20,
      });
    });

    it('should handle partial usage data', () => {
      const response = JSON.stringify({
        usage: {
          prompt_tokens: 100,
        },
      });

      const result = parseTokenUsage(response);

      expect(result?.promptTokens).toBe(100);
      expect(result?.completionTokens).toBeUndefined();
      expect(result?.totalTokens).toBeUndefined();
    });
  });

  describe('Anthropic-style tokens', () => {
    it('should parse Anthropic response with input/output tokens', () => {
      const response = JSON.stringify({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
      });

      const result = parseTokenUsage(response);

      expect(result).toEqual({
        promptTokens: 100,
        completionTokens: 50,
      });
    });

    it('should parse Anthropic response with cache tokens', () => {
      const response = JSON.stringify({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 25,
        },
      });

      const result = parseTokenUsage(response);

      expect(result).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        cacheCreationTokens: 10,
        cacheReadTokens: 25,
      });
    });

    it('should handle Anthropic response with only cache tokens', () => {
      const response = JSON.stringify({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 30,
        },
      });

      const result = parseTokenUsage(response);

      expect(result?.cacheReadTokens).toBe(30);
      expect(result?.cacheCreationTokens).toBe(0);
    });
  });

  describe('Groq-style tokens', () => {
    it('should parse Groq response with reasoning tokens', () => {
      const response = JSON.stringify({
        usage: {
          queue_time: 0.083181725,
          prompt_tokens: 399,
          prompt_time: 0.025346602,
          completion_tokens: 92,
          completion_time: 0.213261452,
          total_tokens: 491,
          total_time: 0.238608054,
          completion_tokens_details: {
            reasoning_tokens: 71,
          },
        },
      });

      const result = parseTokenUsage(response);

      expect(result).toEqual({
        promptTokens: 399,
        completionTokens: 92,
        totalTokens: 491,
        reasoningTokens: 71,
      });
    });
  });

  describe('edge cases', () => {
    it('should return undefined for response without usage field', () => {
      const response = JSON.stringify({
        id: 'chatcmpl-123',
        choices: [],
      });

      const result = parseTokenUsage(response);

      expect(result).toBeUndefined();
    });

    it('should return undefined for invalid JSON', () => {
      const response = 'not valid json';

      const result = parseTokenUsage(response);

      expect(result).toBeUndefined();
    });

    it('should return undefined for non-object response', () => {
      const response = JSON.stringify('string value');

      const result = parseTokenUsage(response);

      expect(result).toBeUndefined();
    });

    it('should return undefined when usage is not an object', () => {
      const response = JSON.stringify({
        usage: 'not an object',
      });

      const result = parseTokenUsage(response);

      expect(result).toBeUndefined();
    });

    it('should handle usage with non-number token values (quoted numbers)', () => {
      const response = JSON.stringify({
        usage: {
          prompt_tokens: '100',
          completion_tokens: 50,
          total_tokens: null,
        },
      });

      const result = parseTokenUsage(response);

      // Regex doesn't match quoted numbers, so prompt_tokens is undefined
      expect(result?.promptTokens).toBeUndefined();
      expect(result?.completionTokens).toBe(50);
      expect(result?.totalTokens).toBeUndefined();
    });

    it('should prefer OpenAI-style tokens when both formats are present', () => {
      const response = JSON.stringify({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          input_tokens: 90,
          output_tokens: 40,
        },
      });

      const result = parseTokenUsage(response);

      // OpenAI-style takes precedence
      expect(result?.promptTokens).toBe(100);
      expect(result?.completionTokens).toBe(50);
    });
  });
});
