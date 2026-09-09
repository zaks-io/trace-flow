import { describe, expect, it, vi } from 'vitest';
import type { SSEStreamData } from '@trace-flow/types';
import { anthropic } from '../anthropic';
import { openai } from '../openai';

describe('provider parser logging', () => {
  it('does not log malformed request or SSE payload details', () => {
    const canary = 'provider-log-canary-7d3a';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      anthropic.parseRequestBody(`not json ${canary}`);
      anthropic.handleSSEEvent(
        { event: `malformed-${canary}`, data: `{"unterminated":"${canary}` },
        1,
        { messages: [] },
      );
      openai.handleSSEEvent(
        { event: `malformed-${canary}`, data: `{"unterminated":"${canary}` },
        1,
        { messages: [] },
      );
      const failingState = {
        get messages(): never {
          throw new Error(canary);
        },
      } as unknown as SSEStreamData;
      openai.handleSSEEvent({ data: '{}' }, 2, failingState);
      openai.handleSSEEvent({ data: '{}' }, 3, failingState);

      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(canary);
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(canary);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith('Provider SSE event handling failed');
      expect(warnSpy).toHaveBeenCalledWith('Provider request body parse failed');
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
