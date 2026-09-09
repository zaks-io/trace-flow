import { describe, expect, it, vi } from 'vitest';
import {
  getProvider,
  MAX_SSE_EVENTS_PER_MESSAGE,
  MAX_SSE_RETAINED_EVENTS,
} from '@trace-flow/llm-providers';
import type { SSEStreamData } from '@trace-flow/types';
import { createSSEParser, MAX_SSE_PARSER_BUFFER_SIZE } from '../../streaming/sse';

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

  it('preserves a terminal Responses event larger than 1 MiB', () => {
    const streamData: SSEStreamData = { messages: [] };
    const provider = getProvider('openai');
    const parser = createSSEParser(streamData, provider);
    parser.feed(
      `event: response.created\ndata: ${JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_large', object: 'response' },
      })}\n\n`,
    );

    const canary = `LARGE_TERMINAL_RAW_CANARY${'x'.repeat(2 * 1024 * 1024)}`;
    parser.feed(
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: {
          output: [{ content: [{ type: 'output_text', text: canary }] }],
          status: 'completed',
          usage: { input_tokens: 233, output_tokens: 144 },
        },
      })}\n\n`,
    );

    expect(provider.aggregateSSETokens(streamData)).toMatchObject({
      promptTokens: 233,
      completionTokens: 144,
    });
    expect(streamData.messages[0]?.metadata?.finishReason).toBe('completed');
    expect(streamData.messages[0]?.messageStop).toEqual(expect.any(Number));
    expect(JSON.stringify(streamData)).not.toContain('LARGE_TERMINAL_RAW_CANARY');
  });

  it.each([
    ['LF', ['\n', '\n']],
    ['CRLF', ['\r', '\n\r', '\n']],
  ])('recovers at a %s blank line after a parser buffer overflow', (_name, boundarySlices) => {
    const streamData: SSEStreamData = { messages: [] };
    const provider = getProvider('openai');
    const handleEvent = vi.spyOn(provider, 'handleSSEEvent');
    const parser = createSSEParser(streamData, provider);
    const canary = `OVERFLOW_RAW_CANARY${'x'.repeat(MAX_SSE_PARSER_BUFFER_SIZE + 1)}`;

    try {
      parser.feed(`data: {"content":"${canary}`);
      for (const slice of boundarySlices) parser.feed(slice);
      parser.feed(
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 55, completion_tokens: 34 },
        })}\n\ndata: [DONE]\n\n`,
      );

      expect(handleEvent).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(handleEvent.mock.calls)).not.toContain('OVERFLOW_RAW_CANARY');
      expect(provider.aggregateSSETokens(streamData)).toMatchObject({
        promptTokens: 55,
        completionTokens: 34,
      });
      expect(streamData.messages[0]?.messageStop).toEqual(expect.any(Number));
      expect(JSON.stringify(streamData)).not.toContain('OVERFLOW_RAW_CANARY');
    } finally {
      handleEvent.mockRestore();
    }
  });
});
