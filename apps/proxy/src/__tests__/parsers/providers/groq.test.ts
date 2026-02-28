import { describe, it, expect } from 'vitest';
import { parseGroqTokens } from '../../../parsers/providers/groq';

describe('parseGroqTokens', () => {
  it('should parse basic tokens with reasoning_tokens', () => {
    const body = JSON.stringify({
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

    const result = parseGroqTokens(body);

    expect(result).toEqual({
      promptTokens: 399,
      completionTokens: 92,
      totalTokens: 491,
      reasoningTokens: 71,
    });
  });

  it('should parse basic tokens without reasoning', () => {
    const body = JSON.stringify({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    });

    const result = parseGroqTokens(body);

    expect(result).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
  });

  it('should return undefined when no token fields found', () => {
    const body = JSON.stringify({ id: 'chat-123', choices: [] });
    expect(parseGroqTokens(body)).toBeUndefined();
  });
});
