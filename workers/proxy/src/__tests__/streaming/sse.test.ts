import { describe, it, expect, vi } from 'vitest';
import { processSSEEvent, createSSEParser } from '../../streaming/sse';
import type { SSEMessageTiming, SSEMetadata } from '@observe/types';

describe('processSSEEvent', () => {
  it('should set messageStart timing on message_start event', () => {
    const timing: SSEMessageTiming = {};
    const metadata: SSEMetadata = {};
    const event = { event: 'message_start', data: '{}' };
    const timestamp = 1000;

    processSSEEvent(event, timestamp, timing, metadata);

    expect(timing.messageStart).toBe(1000);
  });

  it('should only set messageStart once', () => {
    const timing: SSEMessageTiming = { messageStart: 1000 };
    const metadata: SSEMetadata = {};
    const event = { event: 'message_start', data: '{}' };
    const timestamp = 2000;

    processSSEEvent(event, timestamp, timing, metadata);

    expect(timing.messageStart).toBe(1000);
  });

  it('should set contentBlockStart timing on content_block_start event', () => {
    const timing: SSEMessageTiming = {};
    const metadata: SSEMetadata = {};
    const event = { event: 'content_block_start', data: '{}' };
    const timestamp = 1500;

    processSSEEvent(event, timestamp, timing, metadata);

    expect(timing.contentBlockStart).toBe(1500);
  });

  it('should set firstDelta timing on content_block_delta event', () => {
    const timing: SSEMessageTiming = {};
    const metadata: SSEMetadata = {};
    const event = { event: 'content_block_delta', data: '{}' };
    const timestamp = 1600;

    processSSEEvent(event, timestamp, timing, metadata);

    expect(timing.firstDelta).toBe(1600);
  });

  it('should parse usage from message_delta event', () => {
    const timing: SSEMessageTiming = {};
    const metadata: SSEMetadata = {};
    const event = {
      event: 'message_delta',
      data: JSON.stringify({
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20,
          output_tokens: 50,
        },
      }),
    };
    const timestamp = 1700;

    processSSEEvent(event, timestamp, timing, metadata);

    expect(metadata.usage).toEqual({
      input_tokens: 100,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
      output_tokens: 50,
    });
  });

  it('should handle message_delta with partial usage', () => {
    const timing: SSEMessageTiming = {};
    const metadata: SSEMetadata = {};
    const event = {
      event: 'message_delta',
      data: JSON.stringify({
        usage: {
          output_tokens: 25,
        },
      }),
    };
    const timestamp = 1700;

    processSSEEvent(event, timestamp, timing, metadata);

    expect(metadata.usage).toEqual({
      input_tokens: undefined,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: undefined,
      output_tokens: 25,
    });
  });

  it('should set messageStop timing and finalUsage on message_stop event', () => {
    const timing: SSEMessageTiming = {};
    const metadata: SSEMetadata = {};
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

    processSSEEvent(event, timestamp, timing, metadata);

    expect(timing.messageStop).toBe(2000);
    expect(metadata.finalUsage).toEqual({
      input_tokens: 150,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 30,
      output_tokens: 75,
    });
  });

  it('should handle message_stop without usage', () => {
    const timing: SSEMessageTiming = {};
    const metadata: SSEMetadata = {};
    const event = {
      event: 'message_stop',
      data: JSON.stringify({}),
    };
    const timestamp = 2000;

    processSSEEvent(event, timestamp, timing, metadata);

    expect(timing.messageStop).toBe(2000);
    expect(metadata.finalUsage).toBeUndefined();
  });

  it('should handle invalid JSON in event data', () => {
    const timing: SSEMessageTiming = {};
    const metadata: SSEMetadata = {};
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const event = {
      event: 'message_delta',
      data: 'invalid json',
    };
    const timestamp = 1800;

    processSSEEvent(event, timestamp, timing, metadata);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(metadata.usage).toBeUndefined();

    consoleErrorSpy.mockRestore();
  });

  it('should handle event without usage field', () => {
    const timing: SSEMessageTiming = {};
    const metadata: SSEMetadata = {};
    const event = {
      event: 'message_delta',
      data: JSON.stringify({
        delta: 'some text',
      }),
    };
    const timestamp = 1700;

    processSSEEvent(event, timestamp, timing, metadata);

    expect(metadata.usage).toBeUndefined();
  });

  it('should handle unknown event types', () => {
    const timing: SSEMessageTiming = {};
    const metadata: SSEMetadata = {};
    const event = {
      event: 'unknown_event',
      data: '{}',
    };
    const timestamp = 1900;

    processSSEEvent(event, timestamp, timing, metadata);

    expect(timing).toEqual({});
    expect(metadata).toEqual({});
  });
});

describe('createSSEParser', () => {
  it('should create EventSourceParser that processes events', () => {
    const timing: SSEMessageTiming = {};
    const metadata: SSEMetadata = {};
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const parser = createSSEParser(timing, metadata);

    expect(parser).toBeDefined();
    expect(typeof parser.feed).toBe('function');

    parser.feed('event: message_start\n');
    parser.feed('data: {}\n\n');

    expect(timing.messageStart).toBeDefined();
    expect(consoleLogSpy).toHaveBeenCalled();

    consoleLogSpy.mockRestore();
  });

  it('should log SSE events with truncated data', () => {
    const timing: SSEMessageTiming = {};
    const metadata: SSEMetadata = {};
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const parser = createSSEParser(timing, metadata);
    const longData = 'a'.repeat(200);

    parser.feed(`event: message_start\n`);
    parser.feed(`data: ${longData}\n\n`);

    expect(consoleLogSpy).toHaveBeenCalledWith(
      'SSE Event:',
      expect.objectContaining({
        event: 'message_start',
        data: longData.substring(0, 100),
      }),
    );

    consoleLogSpy.mockRestore();
  });

  it('should process multiple events correctly', () => {
    const timing: SSEMessageTiming = {};
    const metadata: SSEMetadata = {};
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const parser = createSSEParser(timing, metadata);

    parser.feed('event: message_start\ndata: {}\n\n');
    parser.feed('event: content_block_start\ndata: {}\n\n');
    parser.feed('event: content_block_delta\ndata: {}\n\n');

    expect(timing.messageStart).toBeDefined();
    expect(timing.contentBlockStart).toBeDefined();
    expect(timing.firstDelta).toBeDefined();

    consoleLogSpy.mockRestore();
  });
});
