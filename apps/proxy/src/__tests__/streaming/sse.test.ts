import { describe, expect, it, vi } from 'vitest';
import {
  getProvider,
  MAX_SSE_EVENTS_PER_MESSAGE,
  MAX_SSE_RETAINED_EVENTS,
} from '@trace-flow/llm-providers';
import type { SSEStreamData } from '@trace-flow/types';
import { createSSEParser, MAX_SSE_PARSER_BUFFER_SIZE } from '../../streaming/sse';
import {
  MAX_SSE_LINES_PER_EVENT,
  MAX_SSE_NON_DATA_LINE_CHARS,
} from '../../streaming/sseInputGuard';

const FINAL_USAGE_EVENTS = `data: ${JSON.stringify({
  choices: [],
  usage: { prompt_tokens: 55, completion_tokens: 34 },
})}\n\ndata: [DONE]\n\n`;

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
  ])('recovers at a %s blank line after an input guard overflow', (_name, boundarySlices) => {
    const streamData: SSEStreamData = { messages: [] };
    const provider = getProvider('openai');
    const handleEvent = vi.spyOn(provider, 'handleSSEEvent');
    const parser = createSSEParser(streamData, provider);
    const canary = `OVERFLOW_RAW_CANARY${'x'.repeat(MAX_SSE_PARSER_BUFFER_SIZE + 1)}`;

    try {
      parser.feed(`data: {"content":"${canary}`);
      for (const slice of boundarySlices) parser.feed(slice);
      parser.feed(FINAL_USAGE_EVENTS);

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

  it('bounds one-character feeds and recovers terminal usage', () => {
    const streamData: SSEStreamData = { messages: [] };
    const provider = getProvider('openai');
    const handleEvent = vi.spyOn(provider, 'handleSSEEvent');
    const parser = createSSEParser(streamData, provider);

    try {
      for (const character of 'data: {"content":"TINY_FEED_RAW_CANARY') parser.feed(character);
      for (let index = 0; index < MAX_SSE_PARSER_BUFFER_SIZE; index++) parser.feed('x');
      parser.feed(`\n\n${FINAL_USAGE_EVENTS}`);

      expect(handleEvent).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(handleEvent.mock.calls)).not.toContain('TINY_FEED_RAW_CANARY');
      expect(provider.aggregateSSETokens(streamData)).toMatchObject({
        promptTokens: 55,
        completionTokens: 34,
      });
      expect(streamData.messages[0]?.messageStop).toEqual(expect.any(Number));
      expect(JSON.stringify(streamData)).not.toContain('TINY_FEED_RAW_CANARY');
    } finally {
      handleEvent.mockRestore();
    }
  }, 60_000);

  it('rejects an adversarial multi-data event before parser concatenation', () => {
    const streamData: SSEStreamData = { messages: [] };
    const provider = getProvider('openai');
    const handleEvent = vi.spyOn(provider, 'handleSSEEvent');
    const parser = createSSEParser(streamData, provider);

    try {
      parser.feed('data: {"content":"MULTILINE_RAW_CANARY"}\n');
      parser.feed(`${'data: x\n'.repeat((6 * 1024 * 1024) / 8)}\n${FINAL_USAGE_EVENTS}`);

      expect(handleEvent).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(handleEvent.mock.calls)).not.toContain('MULTILINE_RAW_CANARY');
      expect(provider.aggregateSSETokens(streamData)).toMatchObject({
        promptTokens: 55,
        completionTokens: 34,
      });
      expect(streamData.messages[0]?.messageStop).toEqual(expect.any(Number));
      expect(JSON.stringify(streamData)).not.toContain('MULTILINE_RAW_CANARY');
    } finally {
      handleEvent.mockRestore();
    }
  });

  it.each([
    [
      'an oversized non-data line',
      `id: NON_DATA_RAW_CANARY${'x'.repeat(MAX_SSE_NON_DATA_LINE_CHARS)}\n\n`,
      'NON_DATA_RAW_CANARY',
    ],
    [
      'too many field lines',
      `${'event: LINE_COUNT_RAW_CANARY\n'.repeat(MAX_SSE_LINES_PER_EVENT + 1)}\n`,
      'LINE_COUNT_RAW_CANARY',
    ],
  ])('rejects %s and resumes terminal parsing', (_name, offendingEvent, canary) => {
    const streamData: SSEStreamData = { messages: [] };
    const provider = getProvider('openai');
    const handleEvent = vi.spyOn(provider, 'handleSSEEvent');
    const parser = createSSEParser(streamData, provider);

    try {
      parser.feed(`${offendingEvent}${FINAL_USAGE_EVENTS}`);

      expect(handleEvent).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(handleEvent.mock.calls)).not.toContain(canary);
      expect(provider.aggregateSSETokens(streamData)).toMatchObject({
        promptTokens: 55,
        completionTokens: 34,
      });
      expect(streamData.messages[0]?.messageStop).toEqual(expect.any(Number));
      expect(JSON.stringify(streamData)).not.toContain(canary);
    } finally {
      handleEvent.mockRestore();
    }
  });
});
