import { describe, it, expect } from 'vitest';
import type { SSEStreamData } from '@trace-flow/types';
import { openrouter } from '../openrouter';
import { MAX_SSE_EVENT_DATA_LENGTH } from '../sse-state';

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

  it('uses the first bounded cost after the first usage marker', () => {
    const state: SSEStreamData = { messages: [] };

    openrouter.handleSSEEvent(
      {
        data: JSON.stringify({
          cost: 99,
          usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0025 },
          trailing: { cost: 88 },
        }),
      },
      1000,
      state,
    );

    expect(openrouter.aggregateSSETokens(state)?.upstreamCost).toBeCloseTo(0.0025);
  });

  it('does not scan cost without a usage marker', () => {
    const state: SSEStreamData = { messages: [] };

    openrouter.handleSSEEvent({ data: JSON.stringify({ choices: [], cost: 0.5 }) }, 1000, state);

    expect(openrouter.aggregateSSETokens(state)).toBeUndefined();
  });

  it('ignores cost values with an overlong numeric component', () => {
    const state: SSEStreamData = { messages: [] };

    openrouter.handleSSEEvent(
      {
        data: '{"usage":{"prompt_tokens":10,"cost":123456789012345678901}}',
      },
      1000,
      state,
    );

    const tokens = openrouter.aggregateSSETokens(state);
    expect(tokens?.promptTokens).toBe(10);
    expect(tokens?.upstreamCost).toBeUndefined();
  });

  it('scans repeated usage markers without quadratic backtracking', () => {
    const state: SSEStreamData = { messages: [] };
    const repeatedUsage = '"usage":{},'.repeat(32_000);
    const data = `{"padding":"${'x'.repeat(MAX_SSE_EVENT_DATA_LENGTH)}",${repeatedUsage}"end":true}`;

    const startedAt = performance.now();
    openrouter.handleSSEEvent({ data }, 1000, state);
    const elapsedMs = performance.now() - startedAt;

    expect(state.messages[0]?.usage).toBeUndefined();
    expect(elapsedMs).toBeLessThan(1500);
  });
});
