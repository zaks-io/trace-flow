import { describe, it, expect } from 'vitest';
import type { SSEStreamData } from '@trace-flow/types';
import { openrouter } from '../openrouter';

describe('openrouter provider — upstream cost', () => {
  it('extracts cost from whole-body response', () => {
    const tokens = openrouter.parseResponseTokenUsage(
      JSON.stringify({
        id: 'gen-1',
        model: 'openai/gpt-4o-mini',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001234 },
      }),
    );
    expect(tokens?.upstreamCost).toBeCloseTo(0.0001234);
  });

  it('aggregates cost from streaming usage chunk', () => {
    const state: SSEStreamData = { messages: [] };
    openrouter.handleSSEEvent(
      {
        data: JSON.stringify({
          id: 'gen-1',
          model: 'openai/gpt-4o-mini',
          choices: [{ delta: { content: 'hi' } }],
        }),
      },
      1000,
      state,
    );
    openrouter.handleSSEEvent(
      {
        data: JSON.stringify({
          choices: [{ finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0005 },
        }),
      },
      1010,
      state,
    );
    openrouter.handleSSEEvent({ data: '[DONE]' }, 1020, state);

    const tokens = openrouter.aggregateSSETokens(state);
    expect(tokens?.promptTokens).toBe(10);
    expect(tokens?.completionTokens).toBe(5);
    expect(tokens?.upstreamCost).toBeCloseTo(0.0005);
  });

  it('omits cost when not present in usage block', () => {
    const tokens = openrouter.parseResponseTokenUsage(
      JSON.stringify({
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
    expect(tokens?.upstreamCost).toBeUndefined();
  });
});
