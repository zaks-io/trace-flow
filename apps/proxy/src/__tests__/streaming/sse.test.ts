import { describe, expect, it, vi } from 'vitest';
import { MAX_SSE_RETAINED_EVENTS, type Provider } from '@trace-flow/llm-providers';
import type { SSEStreamData } from '@trace-flow/types';
import { createSSEParser } from '../../streaming/sse';

describe('createSSEParser', () => {
  it('stops dispatching after the request-wide retained event budget', () => {
    const streamData: SSEStreamData = { messages: [] };
    const handleSSEEvent = vi.fn();
    const provider = { handleSSEEvent } as unknown as Provider;
    const parser = createSSEParser(streamData, provider);

    parser.feed('data: {}\n\n'.repeat(MAX_SSE_RETAINED_EVENTS + 100));

    expect(handleSSEEvent).toHaveBeenCalledTimes(MAX_SSE_RETAINED_EVENTS);
  });
});
