import { describe, it, expect } from 'vitest';
import { parseOpenAITokens } from '../../../parsers/providers/openai';

describe('parseOpenAITokens', () => {
  it('should parse basic prompt/completion/total', () => {
    const body = JSON.stringify({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    });

    const result = parseOpenAITokens(body);

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

    const result = parseOpenAITokens(body);

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

    const result = parseOpenAITokens(body);

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

    const result = parseOpenAITokens(body);

    expect(result?.promptTokens).toBe(100);
    expect(result?.completionTokens).toBeUndefined();
  });

  it('should return undefined when no token fields found', () => {
    const body = JSON.stringify({ id: 'chatcmpl-123', choices: [] });
    expect(parseOpenAITokens(body)).toBeUndefined();
  });
});
