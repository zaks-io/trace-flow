import { describe, it, expect } from 'vitest';
import { parseTokenUsage } from '../../parsers/tokens';

describe('parseTokenUsage', () => {
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
      cached: undefined,
    });
  });

  it('should parse response with cached tokens', () => {
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
      cached: true,
    });
  });

  it('should set cached to true only when cached_tokens > 0', () => {
    const response = JSON.stringify({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: {
          cached_tokens: 0,
        },
      },
    });

    const result = parseTokenUsage(response);

    expect(result).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cached: false,
    });
  });

  it('should handle partial usage data', () => {
    const response = JSON.stringify({
      usage: {
        prompt_tokens: 100,
      },
    });

    const result = parseTokenUsage(response);

    expect(result).toEqual({
      promptTokens: 100,
      completionTokens: undefined,
      totalTokens: undefined,
      cached: undefined,
    });
  });

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

  it('should handle usage with non-number token values', () => {
    const response = JSON.stringify({
      usage: {
        prompt_tokens: '100',
        completion_tokens: 50,
        total_tokens: null,
      },
    });

    const result = parseTokenUsage(response);

    expect(result).toEqual({
      promptTokens: undefined,
      completionTokens: 50,
      totalTokens: undefined,
      cached: undefined,
    });
  });
});
