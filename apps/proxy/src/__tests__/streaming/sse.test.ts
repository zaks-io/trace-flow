import { describe, it, expect, vi } from 'vitest';
import { processSSEEvent, createSSEParser, aggregateSSETokens } from '../../streaming/sse';
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

  it('should track thinking text length from thinking_delta events', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [{ type: 'message_start', timestamp: 1000, data: '{}' }],
          contentBlocks: [{ index: 0, type: 'thinking', startTimestamp: 1100 }],
        },
      ],
    };

    // First thinking delta
    processSSEEvent(
      {
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Let me analyze this' },
        }),
      },
      1150,
      streamData,
    );

    // Second thinking delta
    processSSEEvent(
      {
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: ' step by step.' },
        }),
      },
      1160,
      streamData,
    );

    expect(streamData.messages[0]?.contentBlocks?.[0]?.thinkingTextLength).toBe(
      'Let me analyze this'.length + ' step by step.'.length,
    );
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

describe('aggregateSSETokens', () => {
  it('should return undefined for empty stream data', () => {
    const streamData: SSEStreamData = { messages: [] };

    const result = aggregateSSETokens(streamData);

    expect(result).toBeUndefined();
  });

  it('should return undefined when no messages have usage', () => {
    const streamData: SSEStreamData = {
      messages: [{ messageStart: 1000, events: [] }],
    };

    const result = aggregateSSETokens(streamData);

    expect(result).toBeUndefined();
  });

  it('should aggregate tokens from single message', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
          },
        },
      ],
    };

    const result = aggregateSSETokens(streamData);

    expect(result).toEqual({
      promptTokens: 100,
      uncachedInputTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
  });

  it('should aggregate tokens with cache fields', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 10,
          },
        },
      ],
    };

    const result = aggregateSSETokens(streamData);

    expect(result).toEqual({
      promptTokens: 100,
      uncachedInputTokens: 60,
      completionTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
    });
  });

  it('should sum tokens from multiple messages', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
          },
        },
        {
          messageStart: 2000,
          events: [],
          usage: {
            input_tokens: 200,
            output_tokens: 100,
          },
        },
      ],
    };

    const result = aggregateSSETokens(streamData);

    expect(result).toEqual({
      promptTokens: 300,
      uncachedInputTokens: 300,
      completionTokens: 150,
      totalTokens: 450,
    });
  });

  it('should handle messages with partial usage data', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            input_tokens: 100,
          },
        },
        {
          messageStart: 2000,
          events: [],
          usage: {
            output_tokens: 50,
          },
        },
      ],
    };

    const result = aggregateSSETokens(streamData);

    expect(result?.promptTokens).toBe(100);
    expect(result?.completionTokens).toBe(50);
  });

  it('should skip messages without usage when aggregating', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
          },
        },
        {
          messageStart: 2000,
          events: [],
          // No usage
        },
        {
          messageStart: 3000,
          events: [],
          usage: {
            input_tokens: 50,
            output_tokens: 25,
          },
        },
      ],
    };

    const result = aggregateSSETokens(streamData);

    expect(result).toEqual({
      promptTokens: 150,
      uncachedInputTokens: 150,
      completionTokens: 75,
      totalTokens: 225,
    });
  });

  it('should aggregate reasoning_tokens from SSE usage', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            input_tokens: 100,
            output_tokens: 500,
            reasoning_tokens: 350,
          },
        },
      ],
    };

    const result = aggregateSSETokens(streamData);

    expect(result).toEqual({
      promptTokens: 100,
      uncachedInputTokens: 100,
      completionTokens: 500,
      totalTokens: 600,
      reasoningTokens: 350,
    });
  });

  it('should estimate reasoning tokens from Anthropic thinking content blocks', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            input_tokens: 100,
            output_tokens: 200,
          },
          contentBlocks: [
            { index: 0, type: 'thinking', startTimestamp: 1100, thinkingTextLength: 400 },
            { index: 1, type: 'text', startTimestamp: 1200 },
          ],
        },
      ],
    };

    const result = aggregateSSETokens(streamData);

    expect(result?.reasoningTokens).toBe(100); // Math.ceil(400 / 4)
  });

  it('should prefer provider-reported reasoning tokens over estimation', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            input_tokens: 100,
            output_tokens: 500,
            reasoning_tokens: 350,
          },
          contentBlocks: [
            { index: 0, type: 'thinking', startTimestamp: 1100, thinkingTextLength: 800 },
          ],
        },
      ],
    };

    const result = aggregateSSETokens(streamData);

    expect(result?.reasoningTokens).toBe(350);
  });

  it('should normalize Anthropic: promptTokens = uncached + cache_read + cache_write', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            input_tokens: 972,
            output_tokens: 150,
            cache_read_input_tokens: 2236,
            cache_creation_input_tokens: 0,
          },
        },
      ],
    };

    const result = aggregateSSETokens(streamData, 'anthropic');

    expect(result).toEqual({
      promptTokens: 3208, // 972 + 2236
      uncachedInputTokens: 972,
      completionTokens: 150,
      totalTokens: 3358,
      cacheReadTokens: 2236,
    });
  });

  it('should NOT normalize non-Anthropic providers (promptTokens = input_tokens as-is)', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 30,
          },
        },
      ],
    };

    // OpenAI: prompt_tokens already includes cached, so no normalization
    const result = aggregateSSETokens(streamData, 'openai');

    expect(result).toEqual({
      promptTokens: 100,
      uncachedInputTokens: 70,
      completionTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 30,
    });
  });

  it('should unify Google cached_content_token_count into cacheReadTokens', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            prompt_token_count: 100,
            candidates_token_count: 50,
            cached_content_token_count: 80,
            total_token_count: 150,
          },
        },
      ],
    };

    const result = aggregateSSETokens(streamData, 'google');

    expect(result).toEqual({
      promptTokens: 100,
      uncachedInputTokens: 20,
      completionTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 80,
    });
  });

  it('should aggregate OpenRouter cost and cache_write_tokens from SSE', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            input_tokens: 6497,
            output_tokens: 87,
            cache_write_tokens: 6494,
            cost: 0.06713,
          },
        },
      ],
    };

    const result = aggregateSSETokens(streamData, 'openrouter');

    expect(result).toEqual({
      promptTokens: 6497,
      uncachedInputTokens: 3,
      completionTokens: 87,
      totalTokens: 6584,
      cacheCreationTokens: 6494,
      upstreamCost: 0.06713,
    });
  });

  it('should normalize Anthropic with zero cache tokens (no inflation)', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            input_tokens: 500,
            output_tokens: 100,
          },
        },
      ],
    };

    const result = aggregateSSETokens(streamData, 'anthropic');

    // No cache_read_input_tokens → no normalization applied
    expect(result).toEqual({
      promptTokens: 500,
      uncachedInputTokens: 500,
      completionTokens: 100,
      totalTokens: 600,
    });
  });

  it('should normalize Anthropic with zero input_tokens but non-zero cache_read', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            input_tokens: 0,
            output_tokens: 50,
            cache_read_input_tokens: 1000,
          },
        },
      ],
    };

    const result = aggregateSSETokens(streamData, 'anthropic');

    expect(result).toEqual({
      promptTokens: 1000,
      uncachedInputTokens: 0,
      completionTokens: 50,
      totalTokens: 1050,
      cacheReadTokens: 1000,
    });
  });

  it('should omit totalTokens when only promptTokens is present', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: { input_tokens: 100 },
        },
      ],
    };

    const result = aggregateSSETokens(streamData, 'openai');

    expect(result).toEqual({ promptTokens: 100, uncachedInputTokens: 100 });
    expect(result?.totalTokens).toBeUndefined();
  });

  it('should aggregate ephemeral 5m/1h cache creation breakdown', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 556,
            cache_read_input_tokens: 0,
            ephemeral_5m_input_tokens: 456,
            ephemeral_1h_input_tokens: 100,
          },
        },
      ],
    };

    const result = aggregateSSETokens(streamData, 'anthropic');

    expect(result?.cacheCreationTokens).toBe(556);
    expect(result?.cacheCreation5mTokens).toBe(456);
    expect(result?.cacheCreation1hTokens).toBe(100);
  });

  it('should sum ephemeral breakdown across multiple messages', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            input_tokens: 50,
            output_tokens: 20,
            cache_creation_input_tokens: 200,
            ephemeral_5m_input_tokens: 150,
            ephemeral_1h_input_tokens: 50,
          },
        },
        {
          messageStart: 2000,
          events: [],
          usage: {
            input_tokens: 30,
            output_tokens: 10,
            cache_creation_input_tokens: 100,
            ephemeral_5m_input_tokens: 60,
            ephemeral_1h_input_tokens: 40,
          },
        },
      ],
    };

    const result = aggregateSSETokens(streamData, 'anthropic');

    expect(result?.cacheCreationTokens).toBe(300);
    expect(result?.cacheCreation5mTokens).toBe(210);
    expect(result?.cacheCreation1hTokens).toBe(90);
  });

  it('should aggregate ephemeral fields from SSE events through processSSEEvent', () => {
    const streamData: SSEStreamData = { messages: [] };

    // Simulate Anthropic message_start with usage including ephemeral breakdown
    const messageStartData = JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_123',
        model: 'claude-sonnet-4-20250514',
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 600,
          cache_read_input_tokens: 50,
          ephemeral_5m_input_tokens: 400,
          ephemeral_1h_input_tokens: 200,
        },
      },
    });
    processSSEEvent({ event: 'message_start', data: messageStartData }, 1000, streamData);

    // Simulate message_delta with output tokens
    const messageDeltaData = JSON.stringify({
      type: 'message_delta',
      usage: { output_tokens: 75 },
    });
    processSSEEvent({ event: 'message_delta', data: messageDeltaData }, 2000, streamData);

    const result = aggregateSSETokens(streamData, 'anthropic');

    expect(result?.promptTokens).toBe(750); // 100 + 50 + 600
    expect(result?.uncachedInputTokens).toBe(100);
    expect(result?.completionTokens).toBe(75);
    expect(result?.cacheCreationTokens).toBe(600);
    expect(result?.cacheCreation5mTokens).toBe(400);
    expect(result?.cacheCreation1hTokens).toBe(200);
    expect(result?.cacheReadTokens).toBe(50);
  });

  it('should omit ephemeral fields when they are zero', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 200,
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 0,
          },
        },
      ],
    };

    const result = aggregateSSETokens(streamData, 'anthropic');

    expect(result?.cacheCreationTokens).toBe(200);
    expect(result?.cacheCreation5mTokens).toBeUndefined();
    expect(result?.cacheCreation1hTokens).toBeUndefined();
  });

  it('should persist Google tokens from processSSEEvent (no event type)', () => {
    const streamData: SSEStreamData = { messages: [] };

    // Google SSE chunk with usageMetadata (no event type, like OpenAI-style)
    const googleChunk = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 20,
        candidatesTokenCount: 10,
        totalTokenCount: 30,
      },
      modelVersion: 'gemini-2.0-flash',
    });

    processSSEEvent({ data: googleChunk }, 1000, streamData);

    expect(streamData.messages.length).toBe(1);
    expect(streamData.messages[0]?.usage).toBeDefined();
    expect(streamData.messages[0]?.usage?.prompt_token_count).toBe(20);
    expect(streamData.messages[0]?.usage?.candidates_token_count).toBe(10);
    expect(streamData.messages[0]?.usage?.total_token_count).toBe(30);
  });

  it('should aggregate Google tokens end-to-end through processSSEEvent (no [DONE])', () => {
    const streamData: SSEStreamData = { messages: [] };

    // First chunk (content, no tokens yet — Google doesn't send [DONE])
    processSSEEvent(
      { data: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hi' }] } }] }) },
      1000,
      streamData,
    );

    // Last chunk with usage (stream ends after this — no [DONE])
    processSSEEvent(
      {
        data: JSON.stringify({
          candidates: [{ content: { parts: [{ text: '!' }] }, finishReason: 'STOP' }],
          usageMetadata: {
            promptTokenCount: 50,
            candidatesTokenCount: 25,
            totalTokenCount: 75,
            cachedContentTokenCount: 10,
          },
        }),
      },
      2000,
      streamData,
    );

    const result = aggregateSSETokens(streamData, 'google');
    expect(result).toEqual({
      promptTokens: 50,
      uncachedInputTokens: 40,
      completionTokens: 25,
      totalTokens: 75,
      cacheReadTokens: 10,
    });
  });

  it('should aggregate Google thoughtsTokenCount as reasoningTokens', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: {
            prompt_token_count: 100,
            candidates_token_count: 200,
            thoughts_token_count: 150,
            total_token_count: 300,
          },
        },
      ],
    };

    const result = aggregateSSETokens(streamData, 'google');

    expect(result).toEqual({
      promptTokens: 100,
      uncachedInputTokens: 100,
      completionTokens: 200,
      totalTokens: 300,
      reasoningTokens: 150,
    });
  });

  it('should use Google totalTokenCount (includes thinking) over computed sum', () => {
    const streamData: SSEStreamData = { messages: [] };
    const parser = createSSEParser(streamData);

    // Simulates gemini-2.5-flash single-chunk response with thinking tokens
    const chunk = JSON.stringify({
      candidates: [{ content: { parts: [{ text: '1, 2, 3' }] }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 6,
        candidatesTokenCount: 7,
        totalTokenCount: 36,
        thoughtsTokenCount: 23,
      },
      modelVersion: 'gemini-2.5-flash',
    });

    parser.feed(`data: ${chunk}\n\n`);

    const result = aggregateSSETokens(streamData, 'google');
    expect(result).toEqual({
      promptTokens: 6,
      uncachedInputTokens: 6,
      completionTokens: 7,
      totalTokens: 36, // Google's total includes thinking (6+7+23), NOT just 6+7=13
      reasoningTokens: 23,
    });
  });

  it('should omit totalTokens when only completionTokens is present', () => {
    const streamData: SSEStreamData = {
      messages: [
        {
          messageStart: 1000,
          events: [],
          usage: { output_tokens: 50 },
        },
      ],
    };

    const result = aggregateSSETokens(streamData, 'anthropic');

    expect(result).toEqual({ completionTokens: 50 });
    expect(result?.totalTokens).toBeUndefined();
  });

  it('should extract Google tokens through createSSEParser (with trailing blank line)', () => {
    const streamData: SSEStreamData = { messages: [] };
    const parser = createSSEParser(streamData);

    const chunk1 = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 0, totalTokenCount: 8 },
    });
    const chunk2 = JSON.stringify({
      candidates: [{ content: { parts: [{ text: ' world' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 5, totalTokenCount: 13 },
      modelVersion: 'gemini-2.0-flash',
    });

    // Feed raw SSE text with proper formatting (trailing blank line)
    parser.feed(`data: ${chunk1}\n\ndata: ${chunk2}\n\n`);

    expect(streamData.messages.length).toBe(1);

    const result = aggregateSSETokens(streamData, 'google');
    expect(result).toEqual({
      promptTokens: 8,
      uncachedInputTokens: 8,
      completionTokens: 5,
      totalTokens: 13,
    });
  });

  it('should extract Google tokens through createSSEParser (no trailing blank line, requires flush)', () => {
    const streamData: SSEStreamData = { messages: [] };
    const parser = createSSEParser(streamData);

    const chunk1 = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 0, totalTokenCount: 8 },
    });
    const chunk2 = JSON.stringify({
      candidates: [{ content: { parts: [{ text: ' world' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 5, totalTokenCount: 13 },
    });

    // Feed raw SSE text WITHOUT trailing blank line — last event is buffered
    parser.feed(`data: ${chunk1}\n\ndata: ${chunk2}\n`);

    // Without flush, last event's tokens are stuck in parser buffer
    // Only first chunk's data was dispatched
    expect(streamData.messages.length).toBe(1);
    expect(streamData.messages[0]?.usage?.candidates_token_count).toBe(0);

    // Flush the parser — simulates what index.ts does after pipePromise resolves
    parser.feed('\n\n');

    // Now the last event should be dispatched with the final cumulative tokens
    expect(streamData.messages[0]?.usage?.candidates_token_count).toBe(5);

    const result = aggregateSSETokens(streamData, 'google');
    expect(result).toEqual({
      promptTokens: 8,
      uncachedInputTokens: 8,
      completionTokens: 5,
      totalTokens: 13,
    });
  });

  describe('OpenAI Responses API + cached_tokens', () => {
    it('should aggregate cached_tokens from Chat Completions stream into cacheReadTokens', () => {
      const streamData: SSEStreamData = { messages: [] };
      const finalChunk = JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1500,
          completion_tokens: 50,
          total_tokens: 1550,
          prompt_tokens_details: { cached_tokens: 1280 },
        },
      });

      processSSEEvent({ data: finalChunk }, 1000, streamData);

      const result = aggregateSSETokens(streamData, 'openai');
      expect(result).toEqual({
        promptTokens: 1500,
        uncachedInputTokens: 220,
        completionTokens: 50,
        totalTokens: 1550,
        cacheReadTokens: 1280,
      });
    });

    it('should create a message on response.created (Responses API stream open)', () => {
      const streamData: SSEStreamData = { messages: [] };
      const createdData = JSON.stringify({
        type: 'response.created',
        response: {
          id: 'resp_abc123',
          created_at: 1762193197,
          model: 'gpt-4.1-mini',
        },
      });

      processSSEEvent({ event: 'response.created', data: createdData }, 1000, streamData);

      expect(streamData.messages.length).toBe(1);
      expect(streamData.messages[0]?.messageStart).toBe(1000);
      expect(streamData.messages[0]?.metadata?.id).toBe('resp_abc123');
      expect(streamData.messages[0]?.metadata?.model).toBe('gpt-4.1-mini');
    });

    it('should extract usage on response.completed (Responses API terminal event)', () => {
      const streamData: SSEStreamData = { messages: [] };

      processSSEEvent(
        {
          event: 'response.created',
          data: JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_xyz', created_at: 1, model: 'gpt-4.1-mini' },
          }),
        },
        1000,
        streamData,
      );

      processSSEEvent(
        {
          event: 'response.completed',
          data: JSON.stringify({
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 2006,
                output_tokens: 300,
                total_tokens: 2306,
                input_tokens_details: { cached_tokens: 1920 },
                output_tokens_details: { reasoning_tokens: 0 },
              },
            },
          }),
        },
        2000,
        streamData,
      );

      expect(streamData.messages[0]?.messageStop).toBe(2000);

      const result = aggregateSSETokens(streamData, 'openai');
      expect(result).toEqual({
        promptTokens: 2006,
        uncachedInputTokens: 86,
        completionTokens: 300,
        totalTokens: 2306,
        cacheReadTokens: 1920,
      });
    });

    it('should stamp messageStop and capture partial usage on response.failed', () => {
      const streamData: SSEStreamData = { messages: [] };

      processSSEEvent(
        {
          event: 'response.created',
          data: JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_failed', created_at: 1, model: 'gpt-4.1-mini' },
          }),
        },
        1000,
        streamData,
      );

      processSSEEvent(
        {
          event: 'response.failed',
          data: JSON.stringify({
            type: 'response.failed',
            response: {
              usage: {
                input_tokens: 150,
                output_tokens: 12,
                total_tokens: 162,
              },
            },
          }),
        },
        1500,
        streamData,
      );

      expect(streamData.messages[0]?.messageStop).toBe(1500);

      const result = aggregateSSETokens(streamData, 'openai');
      expect(result).toEqual({
        promptTokens: 150,
        uncachedInputTokens: 150,
        completionTokens: 12,
        totalTokens: 162,
      });
    });
  });
});
