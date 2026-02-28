import { describe, it, expect } from 'vitest';
import { parseAnthropicTokens } from '../../../parsers/providers/anthropic';

describe('parseAnthropicTokens', () => {
  it('should normalize promptTokens = input_tokens + cache_read_input_tokens', () => {
    const body = JSON.stringify({
      usage: {
        input_tokens: 972,
        cache_read_input_tokens: 2236,
        output_tokens: 150,
      },
    });

    const result = parseAnthropicTokens(body);

    expect(result).toEqual({
      promptTokens: 3208, // 972 + 2236
      completionTokens: 150,
      totalTokens: 3358,
      cacheReadTokens: 2236,
    });
  });

  it('should handle basic input/output without cache tokens', () => {
    const body = JSON.stringify({
      usage: {
        input_tokens: 100,
        output_tokens: 50,
      },
    });

    const result = parseAnthropicTokens(body);

    expect(result).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
  });

  it('should handle cache_creation_input_tokens', () => {
    const body = JSON.stringify({
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 0,
      },
    });

    const result = parseAnthropicTokens(body);

    expect(result).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cacheCreationTokens: 500,
      cacheReadTokens: 0,
    });
  });

  it('should handle nested cache_creation, service_tier, and inference_geo fields', () => {
    const body = JSON.stringify({
      usage: {
        input_tokens: 643,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2640,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 0,
        },
        output_tokens: 43,
        service_tier: 'standard',
        inference_geo: 'global',
      },
    });

    const result = parseAnthropicTokens(body);

    expect(result).toEqual({
      promptTokens: 3283, // 643 + 2640
      completionTokens: 43,
      totalTokens: 3326,
      cacheCreationTokens: 0,
      cacheReadTokens: 2640,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
    });
  });

  it('should handle zero cache case', () => {
    const body = JSON.stringify({
      usage: {
        input_tokens: 500,
        output_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });

    const result = parseAnthropicTokens(body);

    expect(result).toEqual({
      promptTokens: 500,
      completionTokens: 100,
      totalTokens: 600,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
  });

  it('should return undefined when no token fields found', () => {
    const body = JSON.stringify({ id: 'msg_123', type: 'message' });
    expect(parseAnthropicTokens(body)).toBeUndefined();
  });

  it('should extract ephemeral_5m and ephemeral_1h cache creation breakdown', () => {
    const body = JSON.stringify({
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 556,
        cache_read_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: 456,
          ephemeral_1h_input_tokens: 100,
        },
      },
    });

    const result = parseAnthropicTokens(body);

    expect(result).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cacheCreationTokens: 556,
      cacheReadTokens: 0,
      cacheCreation5mTokens: 456,
      cacheCreation1hTokens: 100,
    });
  });

  it('should handle ephemeral breakdown with all zeros', () => {
    const body = JSON.stringify({
      usage: {
        input_tokens: 643,
        output_tokens: 43,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2640,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 0,
        },
      },
    });

    const result = parseAnthropicTokens(body);

    expect(result?.cacheCreation5mTokens).toBe(0);
    expect(result?.cacheCreation1hTokens).toBe(0);
  });

  it('should return undefined for invalid JSON', () => {
    expect(parseAnthropicTokens('not json')).toBeUndefined();
  });
});
