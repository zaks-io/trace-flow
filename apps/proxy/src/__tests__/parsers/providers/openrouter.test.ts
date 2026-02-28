import { describe, it, expect } from 'vitest';
import { parseOpenRouterTokens } from '../../../parsers/providers/openrouter';

describe('parseOpenRouterTokens', () => {
  it('should parse full response with cost, cache_write_tokens, cached_tokens', () => {
    const body = JSON.stringify({
      id: 'gen-1768355145-SgNmN4luqmA9SQbSNGfU',
      provider: 'Google',
      model: 'anthropic/claude-opus-4.5',
      usage: {
        prompt_tokens: 6497,
        completion_tokens: 87,
        total_tokens: 6584,
        cost: 0.06713,
        prompt_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 6494,
          audio_tokens: 0,
          video_tokens: 0,
        },
        cost_details: {
          upstream_inference_cost: null,
          upstream_inference_prompt_cost: 0.064955,
          upstream_inference_completions_cost: 0.002175,
        },
        completion_tokens_details: {
          reasoning_tokens: 0,
        },
      },
    });

    const result = parseOpenRouterTokens(body);

    expect(result).toEqual({
      promptTokens: 6497,
      completionTokens: 87,
      totalTokens: 6584,
      cacheReadTokens: 0,
      cacheCreationTokens: 6494,
      reasoningTokens: 0,
      upstreamCost: 0.06713,
    });
  });

  it('should extract upstream cost', () => {
    const body = JSON.stringify({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
        cost: 0.012,
      },
    });

    const result = parseOpenRouterTokens(body);

    expect(result?.upstreamCost).toBe(0.012);
  });

  it('should parse both cache read and write tokens', () => {
    const body = JSON.stringify({
      usage: {
        prompt_tokens: 5000,
        completion_tokens: 100,
        total_tokens: 5100,
        prompt_tokens_details: {
          cached_tokens: 3000,
          cache_write_tokens: 2000,
        },
      },
    });

    const result = parseOpenRouterTokens(body);

    expect(result?.cacheReadTokens).toBe(3000);
    expect(result?.cacheCreationTokens).toBe(2000);
  });

  it('should return undefined when no token fields found', () => {
    const body = JSON.stringify({ id: 'gen-123', choices: [] });
    expect(parseOpenRouterTokens(body)).toBeUndefined();
  });
});
