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

      expect(result?.promptTokens).toBe(100); // input_tokens + cache_read_input_tokens (0)
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
