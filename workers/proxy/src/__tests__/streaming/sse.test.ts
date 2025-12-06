import { describe, it, expect, vi } from 'vitest';
import { processSSEEvent, createSSEParser } from '../../streaming/sse';
import type { SSEStreamData } from '@trace-flow/types';

describe('processSSEEvent', () => {
  it('should create new message on message_start event', () => {
    const streamData: SSEStreamData = { messages: [] };
    const event = { event: 'message_start', data: '{}' };
    const timestamp = 1000;

    processSSEEvent(event, timestamp, streamData);

    expect(streamData.messages.length).toBe(1);
    expect(streamData.messages[0]?.messageStart).toBe(1000);
    expect(streamData.messages[0]?.events.length).toBe(1);
    expect(streamData.messages[0]?.events[0]?.type).toBe('message_start');
  });

  it('should add event to current message on non-message_start event', () => {
    const streamData: SSEStreamData = {
      messages: [
        { messageStart: 1000, events: [{ type: 'message_start', timestamp: 1000, data: '{}' }] },
      ],
    };
    const event = { event: 'content_block_start', data: '{}' };
    const timestamp = 1500;

    processSSEEvent(event, timestamp, streamData);

    expect(streamData.messages.length).toBe(1);
    expect(streamData.messages[0]?.events.length).toBe(2);
    expect(streamData.messages[0]?.events[1]?.type).toBe('content_block_start');
    expect(streamData.messages[0]?.events[1]?.timestamp).toBe(1500);
  });

  it('should handle content_block_delta event', () => {
    const streamData: SSEStreamData = {
      messages: [
        { messageStart: 1000, events: [{ type: 'message_start', timestamp: 1000, data: '{}' }] },
      ],
    };
    const event = { event: 'content_block_delta', data: '{"delta":{"text":"Hello"}}' };
    const timestamp = 1600;

    processSSEEvent(event, timestamp, streamData);

    expect(streamData.messages[0]?.events.length).toBe(2);
    expect(streamData.messages[0]?.events[1]?.type).toBe('content_block_delta');
    expect(streamData.messages[0]?.events[1]?.data).toBe('{"delta":{"text":"Hello"}}');
  });

  it('should set messageStop and usage on message_stop event', () => {
    const streamData: SSEStreamData = {
      messages: [
        { messageStart: 1000, events: [{ type: 'message_start', timestamp: 1000, data: '{}' }] },
      ],
    };
    const event = {
      event: 'message_stop',
      data: JSON.stringify({
        usage: {
          input_tokens: 150,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 30,
          output_tokens: 75,
        },
      }),
    };
    const timestamp = 2000;

    processSSEEvent(event, timestamp, streamData);

    expect(streamData.messages[0]?.messageStop).toBe(2000);
    expect(streamData.messages[0]?.usage).toEqual({
      input_tokens: 150,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 30,
      output_tokens: 75,
    });
    expect(streamData.messages[0]?.events.length).toBe(2);
  });

  it('should handle message_stop without usage', () => {
    const streamData: SSEStreamData = {
      messages: [
        { messageStart: 1000, events: [{ type: 'message_start', timestamp: 1000, data: '{}' }] },
      ],
    };
    const event = {
      event: 'message_stop',
      data: JSON.stringify({}),
    };
    const timestamp = 2000;

    processSSEEvent(event, timestamp, streamData);

    expect(streamData.messages[0]?.messageStop).toBe(2000);
    expect(streamData.messages[0]?.usage).toBeUndefined();
  });

  it('should support multiple messages in one stream', () => {
    const streamData: SSEStreamData = { messages: [] };

    processSSEEvent({ event: 'message_start', data: '{}' }, 1000, streamData);
    processSSEEvent({ event: 'content_block_delta', data: '{}' }, 1100, streamData);
    processSSEEvent({ event: 'message_stop', data: '{}' }, 1200, streamData);

    processSSEEvent({ event: 'message_start', data: '{}' }, 2000, streamData);
    processSSEEvent({ event: 'content_block_delta', data: '{}' }, 2100, streamData);
    processSSEEvent({ event: 'message_stop', data: '{}' }, 2200, streamData);

    expect(streamData.messages.length).toBe(2);
    expect(streamData.messages[0]?.messageStart).toBe(1000);
    expect(streamData.messages[0]?.messageStop).toBe(1200);
    expect(streamData.messages[1]?.messageStart).toBe(2000);
    expect(streamData.messages[1]?.messageStop).toBe(2200);
  });

  it('should warn when event arrives before message_start', () => {
    const streamData: SSEStreamData = { messages: [] };
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const event = { event: 'content_block_start', data: '{}' };
    const timestamp = 1500;

    processSSEEvent(event, timestamp, streamData);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'Received SSE event before message_start:',
      'content_block_start',
    );
    expect(streamData.messages.length).toBe(0);

    consoleWarnSpy.mockRestore();
  });

  it('should handle invalid JSON in event data', () => {
    const streamData: SSEStreamData = {
      messages: [
        { messageStart: 1000, events: [{ type: 'message_start', timestamp: 1000, data: '{}' }] },
      ],
    };
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const event = {
      event: 'message_stop',
      data: 'invalid json',
    };
    const timestamp = 1800;

    processSSEEvent(event, timestamp, streamData);

    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('should handle OpenAI-style event without event type', () => {
    const streamData: SSEStreamData = { messages: [] };
    const event = { data: '{"id":"chatcmpl-123","choices":[{"delta":{"content":"Hello"}}]}' };
    const timestamp = 1900;

    processSSEEvent(event, timestamp, streamData);

    // OpenAI-style events (no event type) should create a message
    expect(streamData.messages.length).toBe(1);
    expect(streamData.messages[0]?.messageStart).toBe(1900);
    expect(streamData.messages[0]?.events.length).toBe(1);
    expect(streamData.messages[0]?.events[0]?.type).toBe('content_block_delta');
  });

  it('should handle [DONE] event for OpenAI-style streaming', () => {
    const streamData: SSEStreamData = {
      messages: [{ messageStart: 1000, events: [] }],
    };
    const event = { data: '[DONE]' };
    const timestamp = 2000;

    processSSEEvent(event, timestamp, streamData);

    expect(streamData.messages[0]?.messageStop).toBe(2000);
  });

  it('should skip empty data for OpenAI-style events', () => {
    const streamData: SSEStreamData = { messages: [] };
    const event = { data: '' };
    const timestamp = 1900;

    processSSEEvent(event, timestamp, streamData);

    expect(streamData.messages.length).toBe(0);
  });
});

describe('content block tracking', () => {
  it('should parse content_block_start for text block', () => {
    const streamData: SSEStreamData = {
      messages: [
        { messageStart: 1000, events: [{ type: 'message_start', timestamp: 1000, data: '{}' }] },
      ],
    };
    const event = {
      event: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    };
    const timestamp = 1100;

    processSSEEvent(event, timestamp, streamData);

    expect(streamData.messages[0]?.contentBlocks).toBeDefined();
    expect(streamData.messages[0]?.contentBlocks?.length).toBe(1);
    expect(streamData.messages[0]?.contentBlocks?.[0]).toEqual({
      index: 0,
      type: 'text',
      startTimestamp: 1100,
    });
  });

  it('should parse content_block_start for tool_use block', () => {
    const streamData: SSEStreamData = {
      messages: [
        { messageStart: 1000, events: [{ type: 'message_start', timestamp: 1000, data: '{}' }] },
      ],
    };
    const event = {
      event: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'toolu_01abc123',
          name: 'get_weather',
          input: {},
        },
      }),
    };
    const timestamp = 1200;

    processSSEEvent(event, timestamp, streamData);

    expect(streamData.messages[0]?.contentBlocks).toBeDefined();
    expect(streamData.messages[0]?.contentBlocks?.length).toBe(1);
    expect(streamData.messages[0]?.contentBlocks?.[0]).toEqual({
      index: 1,
      type: 'tool_use',
      toolUseId: 'toolu_01abc123',
      toolName: 'get_weather',
      startTimestamp: 1200,
    });
  });

  it('should set stopTimestamp on content_block_stop', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [{ type: 'message_start', timestamp: 1000, data: '{}' }],
          contentBlocks: [{ index: 0, type: 'text', startTimestamp: 1100 }],
        },
      ],
    };
    const event = {
      event: 'content_block_stop',
      data: JSON.stringify({ type: 'content_block_stop', index: 0 }),
    };
    const timestamp = 1500;

    processSSEEvent(event, timestamp, streamData);

    expect(streamData.messages[0]?.contentBlocks?.[0]?.stopTimestamp).toBe(1500);
  });

  it('should track multiple content blocks in sequence', () => {
    const streamData: SSEStreamData = { messages: [] };

    // message_start
    processSSEEvent({ event: 'message_start', data: '{}' }, 1000, streamData);

    // First text block
    processSSEEvent(
      {
        event: 'content_block_start',
        data: JSON.stringify({ index: 0, content_block: { type: 'text', text: '' } }),
      },
      1100,
      streamData,
    );
    processSSEEvent(
      { event: 'content_block_stop', data: JSON.stringify({ index: 0 }) },
      1200,
      streamData,
    );

    // Tool use block
    processSSEEvent(
      {
        event: 'content_block_start',
        data: JSON.stringify({
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_xyz', name: 'search', input: {} },
        }),
      },
      1300,
      streamData,
    );
    processSSEEvent(
      { event: 'content_block_stop', data: JSON.stringify({ index: 1 }) },
      1400,
      streamData,
    );

    // Second text block
    processSSEEvent(
      {
        event: 'content_block_start',
        data: JSON.stringify({ index: 2, content_block: { type: 'text', text: '' } }),
      },
      1500,
      streamData,
    );
    processSSEEvent(
      { event: 'content_block_stop', data: JSON.stringify({ index: 2 }) },
      1600,
      streamData,
    );

    expect(streamData.messages[0]?.contentBlocks?.length).toBe(3);
    expect(streamData.messages[0]?.contentBlocks?.[0]).toEqual({
      index: 0,
      type: 'text',
      startTimestamp: 1100,
      stopTimestamp: 1200,
    });
    expect(streamData.messages[0]?.contentBlocks?.[1]).toEqual({
      index: 1,
      type: 'tool_use',
      toolUseId: 'toolu_xyz',
      toolName: 'search',
      startTimestamp: 1300,
      stopTimestamp: 1400,
    });
    expect(streamData.messages[0]?.contentBlocks?.[2]).toEqual({
      index: 2,
      type: 'text',
      startTimestamp: 1500,
      stopTimestamp: 1600,
    });
  });

  it('should not create content block when data is missing required fields', () => {
    const streamData: SSEStreamData = {
      messages: [
        { messageStart: 1000, events: [{ type: 'message_start', timestamp: 1000, data: '{}' }] },
      ],
    };
    // Missing index
    const event = {
      event: 'content_block_start',
      data: JSON.stringify({ content_block: { type: 'text' } }),
    };

    processSSEEvent(event, 1100, streamData);

    expect(streamData.messages[0]?.contentBlocks).toBeUndefined();
  });
});

describe('createSSEParser', () => {
  it('should create EventSourceParser that processes events', () => {
    const streamData: SSEStreamData = { messages: [] };

    const parser = createSSEParser(streamData);

    expect(parser).toBeDefined();
    expect(typeof parser.feed).toBe('function');

    parser.feed('event: message_start\n');
    parser.feed('data: {}\n\n');

    expect(streamData.messages.length).toBe(1);
    expect(streamData.messages[0]?.messageStart).toBeDefined();
  });

  it('should process multiple events correctly', () => {
    const streamData: SSEStreamData = { messages: [] };

    const parser = createSSEParser(streamData);

    parser.feed('event: message_start\ndata: {}\n\n');
    parser.feed('event: content_block_start\ndata: {}\n\n');
    parser.feed('event: content_block_delta\ndata: {}\n\n');

    expect(streamData.messages.length).toBe(1);
    expect(streamData.messages[0]?.events.length).toBe(3);
    expect(streamData.messages[0]?.events[0]?.type).toBe('message_start');
    expect(streamData.messages[0]?.events[1]?.type).toBe('content_block_start');
    expect(streamData.messages[0]?.events[2]?.type).toBe('content_block_delta');
  });
});
