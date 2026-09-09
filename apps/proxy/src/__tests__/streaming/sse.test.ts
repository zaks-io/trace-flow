import { describe, expect, it } from 'vitest';
import {
  getProvider,
  MAX_SSE_EVENTS_PER_MESSAGE,
  MAX_SSE_RETAINED_EVENTS,
} from '@trace-flow/llm-providers';
import type { SSEStreamData } from '@trace-flow/types';
import { createSSEParser } from '../../streaming/sse';

describe('createSSEParser', () => {
  it('keeps final usage and stop timing after retained event state fills', () => {
    const streamData: SSEStreamData = { messages: [] };
    const provider = getProvider('openai');
    const parser = createSSEParser(streamData, provider);
    const delta = `data: ${JSON.stringify({
      choices: [{ delta: { content: 'PARSER_RAW_CANARY' } }],
    })}\n\n`;

    parser.feed(delta.repeat(MAX_SSE_RETAINED_EVENTS + 1));
    parser.feed(
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 34, completion_tokens: 21 },
      })}\n\ndata: [DONE]\n\n`,
    );

    const message = streamData.messages[0];
    expect(message?.events).toHaveLength(MAX_SSE_EVENTS_PER_MESSAGE);
    expect(message?.messageStop).toEqual(expect.any(Number));
    expect(provider.aggregateSSETokens(streamData)).toMatchObject({
      promptTokens: 34,
      completionTokens: 21,
    });
    expect(JSON.stringify(streamData)).not.toContain('PARSER_RAW_CANARY');
  });
});
