import { describe, it, expect } from 'vitest';
import { buildTraces } from '../traces';
import type { QueueMessage } from '@trace-flow/types';

describe('buildTraces', () => {
  const baseQueueMessage: QueueMessage = {
    requestId: 'test-request-123',
    apiKey: 'test-api-key',
    targetUrl: 'https://api.openai.com/v1/chat/completions',
    request: {
      id: 'test-request-123',
      provider: 'openai',
      model: 'gpt-4',
      messages: [],
      timestamp: 1000,
    },
    response: {
      id: 'test-request-123',
      provider: 'openai',
      status: 200,
      timestamp: 1500,
      latency: 500,
    },
    requestBodyKey: 'requests/test-request-123',
    responseBodyKey: 'responses/test-request-123',
    timing: {
      requestStart: 1000,
      requestSent: 1100,
      firstTokenReceived: 1200,
      responseComplete: 1500,
    },
    receivedAt: 1000000000000000,
  };

  describe('basic trace generation', () => {
    it('should generate root span with correct structure', () => {
      const traces = buildTraces(baseQueueMessage);

      expect(traces.length).toBeGreaterThanOrEqual(1);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanName).toBe('ai.request');
      expect(rootSpan.SpanKind).toBe('SPAN_KIND_CLIENT');
      expect(rootSpan.TraceId).toBe('test-request-123');
      expect(rootSpan.ParentSpanId).toBe('');
      expect(rootSpan.ServiceName).toBe('llm-observability');
      expect(rootSpan.StatusCode).toBe('STATUS_CODE_OK');
      expect(rootSpan.StatusMessage).toBe('');
    });

    it('should set root span attributes correctly', () => {
      const traces = buildTraces(baseQueueMessage);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes).toMatchObject({
        'ai.request_id': 'test-request-123',
        'ai.provider': 'openai',
        'ai.model': 'gpt-4',
        'ai.target_url': 'https://api.openai.com/v1/chat/completions',
        'http.status_code': '200',
      });
    });

    it('should calculate root span timing correctly', () => {
      const traces = buildTraces(baseQueueMessage);
      const rootSpan = traces[0]!;

      expect(rootSpan.Timestamp).toBe(1000 * 1000000);
      expect(rootSpan.Duration).toBe((1500 - 1000) * 1000000);
    });
  });

  describe('token usage', () => {
    it('should include token usage in root span when provided', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        },
      };

      const traces = buildTraces(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['ai.tokens.prompt']).toBe('100');
      expect(rootSpan.SpanAttributes['ai.tokens.completion']).toBe('50');
      expect(rootSpan.SpanAttributes['ai.tokens.total']).toBe('150');
    });

    it('should include cached tokens count when present (OpenAI)', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          cachedTokens: 25,
        },
      };

      const traces = buildTraces(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['ai.tokens.cached']).toBe('25');
    });

    it('should include reasoning tokens when present', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          reasoningTokens: 20,
        },
      };

      const traces = buildTraces(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['ai.tokens.reasoning']).toBe('20');
    });

    it('should include Anthropic cache tokens when present', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 100,
          completionTokens: 50,
          cacheReadTokens: 30,
          cacheCreationTokens: 10,
        },
      };

      const traces = buildTraces(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['ai.tokens.cache_read']).toBe('30');
      expect(rootSpan.SpanAttributes['ai.tokens.cache_creation']).toBe('10');
    });

    it('should handle partial token usage', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 100,
        },
      };

      const traces = buildTraces(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['ai.tokens.prompt']).toBe('100');
      expect(rootSpan.SpanAttributes['ai.tokens.completion']).toBeUndefined();
      expect(rootSpan.SpanAttributes['ai.tokens.total']).toBeUndefined();
    });

    it('should handle no token usage', () => {
      const traces = buildTraces(baseQueueMessage);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['ai.tokens.prompt']).toBeUndefined();
      expect(rootSpan.SpanAttributes['ai.tokens.completion']).toBeUndefined();
      expect(rootSpan.SpanAttributes['ai.tokens.total']).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should mark root span as error when error is present', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        response: {
          ...baseQueueMessage.response,
          status: 401,
        },
        error: {
          type: 'invalid_request_error',
          message: 'Invalid API key',
          code: 'invalid_api_key',
        },
      };

      const traces = buildTraces(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.StatusCode).toBe('STATUS_CODE_ERROR');
      expect(rootSpan.StatusMessage).toBe('Invalid API key');
      expect(rootSpan.SpanAttributes['error.type']).toBe('invalid_request_error');
      expect(rootSpan.SpanAttributes['error.code']).toBe('invalid_api_key');
      expect(rootSpan.SpanAttributes['http.status_code']).toBe('401');
    });

    it('should handle error without code', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        response: {
          ...baseQueueMessage.response,
          status: 500,
        },
        error: {
          type: 'server_error',
          message: 'Internal server error',
        },
      };

      const traces = buildTraces(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.StatusCode).toBe('STATUS_CODE_ERROR');
      expect(rootSpan.StatusMessage).toBe('Internal server error');
      expect(rootSpan.SpanAttributes['error.type']).toBe('server_error');
      expect(rootSpan.SpanAttributes['error.code']).toBeUndefined();
    });
  });

  describe('SSE streaming responses', () => {
    it('should include TTFT attribute on root span when content_block_delta is present', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseStreamData: {
          messages: [
            {
              messageStart: 1150,
              messageStop: 1480,
              events: [
                { type: 'message_start', timestamp: 1150, data: '{}' },
                { type: 'content_block_delta', timestamp: 1250, data: '{}' },
                { type: 'message_stop', timestamp: 1480, data: '{}' },
              ],
            },
          ],
        },
      };

      const traces = buildTraces(message);

      const rootSpan = traces.find((t) => t.SpanName === 'ai.request');
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.SpanAttributes['ai.time_to_first_token_ms']).toBe(
        String(1250 - baseQueueMessage.timing.requestStart),
      );
    });

    it('should not include TTFT attribute when no content_block_delta present', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseStreamData: {
          messages: [
            {
              messageStart: 1150,
              messageStop: 1480,
              events: [
                { type: 'message_start', timestamp: 1150, data: '{}' },
                { type: 'message_stop', timestamp: 1480, data: '{}' },
              ],
            },
          ],
        },
      };

      const traces = buildTraces(message);

      const rootSpan = traces.find((t) => t.SpanName === 'ai.request');
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.SpanAttributes['ai.time_to_first_token_ms']).toBeUndefined();
    });

    it('should not generate content block spans when message is incomplete', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseStreamData: {
          messages: [
            {
              messageStart: 1150,
              events: [{ type: 'message_start', timestamp: 1150, data: '{}' }],
              contentBlocks: [
                { index: 0, type: 'text', startTimestamp: 1200, stopTimestamp: 1400 },
              ],
            },
          ],
        },
      };

      const traces = buildTraces(message);

      const textSpan = traces.find((t) => t.SpanName === 'ai.response.text');
      expect(textSpan).toBeUndefined();
    });
  });

  describe('span hierarchy', () => {
    it('should create correct parent-child relationships for SSE responses', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseStreamData: {
          messages: [
            {
              messageStart: 1150,
              messageStop: 1480,
              events: [
                { type: 'message_start', timestamp: 1150, data: '{}' },
                { type: 'content_block_delta', timestamp: 1250, data: '{}' },
                { type: 'message_stop', timestamp: 1480, data: '{}' },
              ],
              contentBlocks: [
                { index: 0, type: 'text', startTimestamp: 1200, stopTimestamp: 1400 },
              ],
            },
          ],
        },
      };

      const traces = buildTraces(message);

      const rootSpan = traces.find((t) => t.SpanName === 'ai.request')!;
      const textSpan = traces.find((t) => t.SpanName === 'ai.response.text')!;

      expect(rootSpan.ParentSpanId).toBe('');
      expect(textSpan.ParentSpanId).toBe(rootSpan.SpanId);
      // TTFT is now an attribute on root span, not a separate span
      expect(rootSpan.SpanAttributes['ai.time_to_first_token_ms']).toBeDefined();
    });

    it('should generate unique span IDs', () => {
      const traces = buildTraces(baseQueueMessage);

      const spanIds = traces.map((t) => t.SpanId);
      const uniqueSpanIds = new Set(spanIds);

      expect(uniqueSpanIds.size).toBe(spanIds.length);
    });

    it('should use same trace ID for all spans', () => {
      const traces = buildTraces(baseQueueMessage);

      const traceIds = traces.map((t) => t.TraceId);
      expect(new Set(traceIds).size).toBe(1);
      expect(traceIds[0]).toBe('test-request-123');
    });
  });

  describe('different providers', () => {
    it('should handle Anthropic provider', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        targetUrl: 'https://api.anthropic.com/v1/messages',
        request: {
          ...baseQueueMessage.request,
          provider: 'anthropic',
        },
        response: {
          ...baseQueueMessage.response,
          provider: 'anthropic',
        },
      };

      const traces = buildTraces(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['ai.provider']).toBe('anthropic');
      expect(rootSpan.SpanAttributes['ai.target_url']).toBe(
        'https://api.anthropic.com/v1/messages',
      );
    });

    it('should handle Google provider', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        targetUrl: 'https://generativelanguage.googleapis.com/v1/models',
        request: {
          ...baseQueueMessage.request,
          provider: 'google',
        },
        response: {
          ...baseQueueMessage.response,
          provider: 'google',
        },
      };

      const traces = buildTraces(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['ai.provider']).toBe('google');
    });
  });

  describe('API key propagation', () => {
    it('should include API key in all spans', () => {
      const traces = buildTraces(baseQueueMessage);

      traces.forEach((trace) => {
        expect(trace.ApiKey).toBe('test-api-key');
      });
    });
  });

  describe('content block spans', () => {
    it('should create spans for text content blocks', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseStreamData: {
          messages: [
            {
              messageStart: 1150,
              messageStop: 1480,
              events: [
                { type: 'message_start', timestamp: 1150, data: '{}' },
                { type: 'message_stop', timestamp: 1480, data: '{}' },
              ],
              contentBlocks: [
                { index: 0, type: 'text', startTimestamp: 1200, stopTimestamp: 1400 },
              ],
            },
          ],
        },
      };

      const traces = buildTraces(message);

      const contentBlockSpan = traces.find((t) => t.SpanName === 'ai.response.text');
      expect(contentBlockSpan).toBeDefined();
      expect(contentBlockSpan?.Timestamp).toBe(1200 * 1000000);
      expect(contentBlockSpan?.Duration).toBe((1400 - 1200) * 1000000);
      expect(contentBlockSpan?.SpanAttributes['ai.message.index']).toBe('0');
      expect(contentBlockSpan?.SpanAttributes['ai.content.type']).toBe('text');
    });

    it('should create spans for tool_use content blocks', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseStreamData: {
          messages: [
            {
              messageStart: 1150,
              messageStop: 1480,
              events: [
                { type: 'message_start', timestamp: 1150, data: '{}' },
                { type: 'message_stop', timestamp: 1480, data: '{}' },
              ],
              contentBlocks: [
                {
                  index: 0,
                  type: 'tool_use',
                  startTimestamp: 1200,
                  stopTimestamp: 1400,
                  toolUseId: 'toolu_01abc123',
                  toolName: 'get_weather',
                },
              ],
            },
          ],
        },
      };

      const traces = buildTraces(message);

      const contentBlockSpan = traces.find((t) => t.SpanName === 'ai.response.tool_use');
      expect(contentBlockSpan).toBeDefined();
      expect(contentBlockSpan?.SpanAttributes['ai.message.index']).toBe('0');
      expect(contentBlockSpan?.SpanAttributes['ai.content.type']).toBe('tool_use');
      expect(contentBlockSpan?.SpanAttributes['ai.tool.id']).toBe('toolu_01abc123');
      expect(contentBlockSpan?.SpanAttributes['ai.tool.name']).toBe('get_weather');
    });

    it('should skip incomplete content blocks', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseStreamData: {
          messages: [
            {
              messageStart: 1150,
              messageStop: 1480,
              events: [
                { type: 'message_start', timestamp: 1150, data: '{}' },
                { type: 'message_stop', timestamp: 1480, data: '{}' },
              ],
              contentBlocks: [
                { index: 0, type: 'text', startTimestamp: 1200 }, // missing stopTimestamp
              ],
            },
          ],
        },
      };

      const traces = buildTraces(message);

      const contentBlockSpan = traces.find((t) => t.SpanName.includes('ai.response.'));
      expect(contentBlockSpan).toBeUndefined();
    });

    it('should create multiple content block spans with numbering', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseStreamData: {
          messages: [
            {
              messageStart: 1150,
              messageStop: 1480,
              events: [{ type: 'message_start', timestamp: 1150, data: '{}' }],
              contentBlocks: [
                { index: 0, type: 'text', startTimestamp: 1200, stopTimestamp: 1250 },
                {
                  index: 1,
                  type: 'tool_use',
                  startTimestamp: 1260,
                  stopTimestamp: 1350,
                  toolUseId: 'toolu_abc',
                  toolName: 'search',
                },
                { index: 2, type: 'text', startTimestamp: 1360, stopTimestamp: 1400 },
              ],
            },
          ],
        },
      };

      const traces = buildTraces(message);

      // When there are multiple of the same type, they should be numbered
      const textSpans = traces.filter((t) => t.SpanName.startsWith('ai.response.text'));
      const toolUseSpans = traces.filter((t) => t.SpanName.startsWith('ai.response.tool_use'));

      expect(textSpans.length).toBe(2);
      expect(toolUseSpans.length).toBe(1);

      // Text spans should be numbered since there are 2
      expect(textSpans[0]?.SpanName).toBe('ai.response.text.1');
      expect(textSpans[1]?.SpanName).toBe('ai.response.text.2');

      // Tool use span should not be numbered since there's only 1
      expect(toolUseSpans[0]?.SpanName).toBe('ai.response.tool_use');
    });

    it('should create thinking spans', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseStreamData: {
          messages: [
            {
              messageStart: 1150,
              messageStop: 1480,
              events: [{ type: 'message_start', timestamp: 1150, data: '{}' }],
              contentBlocks: [
                { index: 0, type: 'thinking', startTimestamp: 1160, stopTimestamp: 1200 },
                { index: 1, type: 'text', startTimestamp: 1200, stopTimestamp: 1400 },
              ],
            },
          ],
        },
      };

      const traces = buildTraces(message);

      const thinkingSpan = traces.find((t) => t.SpanName === 'ai.response.thinking');
      const textSpan = traces.find((t) => t.SpanName === 'ai.response.text');

      expect(thinkingSpan).toBeDefined();
      expect(textSpan).toBeDefined();
      expect(thinkingSpan?.SpanAttributes['ai.content.type']).toBe('thinking');
    });
  });

  describe('input message events', () => {
    it('should add event for system messages', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        inputMessages: [
          {
            role: 'system',
            index: 0,
            contentBlocks: [{ index: 0, type: 'text' }],
          },
        ],
      };

      const traces = buildTraces(message);

      const rootSpan = traces.find((t) => t.SpanName === 'ai.request');
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.['Events.Name']).toContain('input.system');
      const eventIndex = rootSpan?.['Events.Name'].indexOf('input.system');
      const eventAttrs = JSON.parse(rootSpan?.['Events.Attributes'][eventIndex!] ?? '{}');
      expect(eventAttrs['ai.message.role']).toBe('system');
      expect(eventAttrs['ai.message.index']).toBe('0');
    });

    it('should add input.text event for user text messages', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        inputMessages: [
          {
            role: 'user',
            index: 0,
            contentBlocks: [{ index: 0, type: 'text' }],
          },
        ],
      };

      const traces = buildTraces(message);

      const rootSpan = traces.find((t) => t.SpanName === 'ai.request');
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.['Events.Name']).toContain('input.text');
      const eventIndex = rootSpan?.['Events.Name'].indexOf('input.text');
      const eventAttrs = JSON.parse(rootSpan?.['Events.Attributes'][eventIndex!] ?? '{}');
      expect(eventAttrs['ai.message.role']).toBe('user');
      expect(eventAttrs['ai.content.type']).toBe('text');
    });

    it('should add input.text event for assistant messages in history', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        inputMessages: [
          {
            role: 'assistant',
            index: 0,
            contentBlocks: [{ index: 0, type: 'text' }],
          },
        ],
      };

      const traces = buildTraces(message);

      const rootSpan = traces.find((t) => t.SpanName === 'ai.request');
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.['Events.Name']).toContain('input.text');
      const eventIndex = rootSpan?.['Events.Name'].indexOf('input.text');
      const eventAttrs = JSON.parse(rootSpan?.['Events.Attributes'][eventIndex!] ?? '{}');
      expect(eventAttrs['ai.message.role']).toBe('assistant');
      expect(eventAttrs['ai.content.type']).toBe('text');
    });

    it('should add input.tool_result event for tool results', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        inputMessages: [
          {
            role: 'user',
            index: 0,
            contentBlocks: [{ index: 0, type: 'tool_result', toolResultId: 'toolu_abc123' }],
          },
        ],
      };

      const traces = buildTraces(message);

      const rootSpan = traces.find((t) => t.SpanName === 'ai.request');
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.['Events.Name']).toContain('input.tool_result');
      const eventIndex = rootSpan?.['Events.Name'].indexOf('input.tool_result');
      const eventAttrs = JSON.parse(rootSpan?.['Events.Attributes'][eventIndex!] ?? '{}');
      expect(eventAttrs['ai.message.role']).toBe('user');
      expect(eventAttrs['ai.tool.id']).toBe('toolu_abc123');
    });

    it('should add multiple input events based on content types', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        inputMessages: [
          { role: 'system', index: 0, contentBlocks: [{ index: 0, type: 'text' }] },
          { role: 'user', index: 1, contentBlocks: [{ index: 0, type: 'text' }] },
          { role: 'assistant', index: 2, contentBlocks: [{ index: 0, type: 'text' }] },
          { role: 'user', index: 3, contentBlocks: [{ index: 0, type: 'text' }] },
        ],
      };

      const traces = buildTraces(message);

      const rootSpan = traces.find((t) => t.SpanName === 'ai.request');
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.['Events.Name']).toContain('input.system');
      // 3 text blocks from user and assistant messages
      expect(rootSpan?.['Events.Name'].filter((n) => n === 'input.text').length).toBe(3);
    });

    it('should add input.tool_use events for assistant tool calls in history', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        inputMessages: [
          {
            role: 'assistant',
            index: 0,
            contentBlocks: [
              { index: 0, type: 'text' },
              { index: 1, type: 'tool_use', toolUseId: 'toolu_abc', toolName: 'get_weather' },
              { index: 2, type: 'tool_use', toolUseId: 'toolu_def', toolName: 'get_time' },
            ],
          },
        ],
      };

      const traces = buildTraces(message);

      const rootSpan = traces.find((t) => t.SpanName === 'ai.request');
      expect(rootSpan).toBeDefined();
      // Should have 1 text event and 2 tool_use events
      expect(rootSpan?.['Events.Name']).toContain('input.text');
      expect(rootSpan?.['Events.Name'].filter((n) => n === 'input.tool_use').length).toBe(2);

      // Check first tool_use event
      const toolUseIndex = rootSpan?.['Events.Name'].indexOf('input.tool_use');
      expect(toolUseIndex).toBeGreaterThanOrEqual(0);
      const firstToolAttrs = JSON.parse(rootSpan?.['Events.Attributes'][toolUseIndex!] ?? '{}');
      expect(firstToolAttrs['ai.tool.id']).toBe('toolu_abc');
      expect(firstToolAttrs['ai.tool.name']).toBe('get_weather');
    });
  });

  describe('output message events', () => {
    it('should add output events for SSE streaming text content', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseStreamData: {
          messages: [
            {
              messageStart: 1100,
              messageStop: 1500,
              contentBlocks: [
                {
                  type: 'text',
                  index: 0,
                  startTimestamp: 1150,
                  stopTimestamp: 1450,
                },
              ],
              events: [],
            },
          ],
        },
      };

      const traces = buildTraces(message);

      const rootSpan = traces.find((t) => t.SpanName === 'ai.request');
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.['Events.Name']).toContain('output.text');
      const eventIndex = rootSpan?.['Events.Name'].indexOf('output.text');
      const eventAttrs = JSON.parse(rootSpan?.['Events.Attributes'][eventIndex!] ?? '{}');
      expect(eventAttrs['ai.content.type']).toBe('text');
    });

    it('should add output events for tool_use with tool info', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseStreamData: {
          messages: [
            {
              messageStart: 1100,
              messageStop: 1500,
              contentBlocks: [
                {
                  type: 'tool_use',
                  index: 0,
                  startTimestamp: 1150,
                  stopTimestamp: 1450,
                  toolUseId: 'toolu_abc',
                  toolName: 'get_weather',
                },
              ],
              events: [],
            },
          ],
        },
      };

      const traces = buildTraces(message);

      const rootSpan = traces.find((t) => t.SpanName === 'ai.request');
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.['Events.Name']).toContain('output.tool_use');
      const eventIndex = rootSpan?.['Events.Name'].indexOf('output.tool_use');
      const eventAttrs = JSON.parse(rootSpan?.['Events.Attributes'][eventIndex!] ?? '{}');
      expect(eventAttrs['ai.tool.id']).toBe('toolu_abc');
      expect(eventAttrs['ai.tool.name']).toBe('get_weather');
    });

    it('should add output event for non-streaming responses', () => {
      const traces = buildTraces(baseQueueMessage);

      const rootSpan = traces.find((t) => t.SpanName === 'ai.request');
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.['Events.Name']).toContain('output.text');
      const eventIndex = rootSpan?.['Events.Name'].indexOf('output.text');
      const eventAttrs = JSON.parse(rootSpan?.['Events.Attributes'][eventIndex!] ?? '{}');
      expect(eventAttrs['ai.response.streaming']).toBe('false');
    });

    it('should add multiple output events for multiple content blocks', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseStreamData: {
          messages: [
            {
              messageStart: 1100,
              messageStop: 1500,
              contentBlocks: [
                { type: 'thinking', index: 0, startTimestamp: 1100, stopTimestamp: 1200 },
                { type: 'text', index: 1, startTimestamp: 1200, stopTimestamp: 1400 },
                {
                  type: 'tool_use',
                  index: 2,
                  startTimestamp: 1400,
                  stopTimestamp: 1450,
                  toolUseId: 'toolu_1',
                  toolName: 'search',
                },
              ],
              events: [],
            },
          ],
        },
      };

      const traces = buildTraces(message);

      const rootSpan = traces.find((t) => t.SpanName === 'ai.request');
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.['Events.Name']).toContain('output.thinking');
      expect(rootSpan?.['Events.Name']).toContain('output.text');
      expect(rootSpan?.['Events.Name']).toContain('output.tool_use');
    });
  });

  describe('tool execution spans', () => {
    it('should create spans for tool executions', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        toolExecutions: [
          {
            toolUseId: 'toolu_abc123',
            toolName: 'get_weather',
            startTimestamp: 500,
            endTimestamp: 1000,
            originalTraceId: 'original-trace-id',
          },
        ],
      };

      const traces = buildTraces(message);

      const toolExecSpan = traces.find((t) => t.SpanName === 'ai.tool.execution');
      expect(toolExecSpan).toBeDefined();
      expect(toolExecSpan?.Timestamp).toBe(500 * 1000000);
      expect(toolExecSpan?.Duration).toBe((1000 - 500) * 1000000);
      expect(toolExecSpan?.SpanAttributes['ai.tool.id']).toBe('toolu_abc123');
      expect(toolExecSpan?.SpanAttributes['ai.tool.name']).toBe('get_weather');
      expect(toolExecSpan?.SpanAttributes['ai.original_trace_id']).toBe('original-trace-id');
      expect(toolExecSpan?.['Links.TraceId']).toContain('original-trace-id');
    });

    it('should create multiple tool execution spans', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        toolExecutions: [
          {
            toolUseId: 'toolu_1',
            toolName: 'search',
            startTimestamp: 500,
            endTimestamp: 800,
            originalTraceId: 'trace-1',
          },
          {
            toolUseId: 'toolu_2',
            toolName: 'calculate',
            startTimestamp: 900,
            endTimestamp: 950,
            originalTraceId: 'trace-1',
          },
        ],
      };

      const traces = buildTraces(message);

      const toolExecSpans = traces.filter((t) => t.SpanName === 'ai.tool.execution');
      expect(toolExecSpans.length).toBe(2);
    });
  });

  describe('non-streaming responses', () => {
    it('should create assistant response span for non-streaming responses', () => {
      const traces = buildTraces(baseQueueMessage);

      const responseSpan = traces.find((t) => t.SpanName === 'ai.response.text');
      expect(responseSpan).toBeDefined();
      expect(responseSpan?.SpanAttributes['ai.response.streaming']).toBe('false');
    });

    it('should not create assistant response span for error responses', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        response: {
          ...baseQueueMessage.response,
          status: 500,
        },
      };

      const traces = buildTraces(message);

      const responseSpan = traces.find((t) => t.SpanName === 'ai.response.text');
      expect(responseSpan).toBeUndefined();
    });
  });

  describe('cost attributes', () => {
    const samplePricing = {
      promptCostPerMillion: 3000000, // $3 per million tokens
      completionCostPerMillion: 15000000, // $15 per million tokens
      cacheReadCostPerMillion: 300000, // $0.30 per million
      cacheWriteCostPerMillion: 3750000, // $3.75 per million
      reasoningCostPerMillion: 15000000, // $15 per million
      updatedAt: Date.now(),
      source: 'openrouter' as const,
    };

    it('should add cost attributes when pricing is provided', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 1000,
          completionTokens: 500,
        },
      };

      const traces = buildTraces(message, samplePricing);
      const rootSpan = traces[0]!;

      // 1000 * 3M / 1M = 3000 microdollars = $0.003
      expect(rootSpan.SpanAttributes['ai.cost.input']).toBe('0.003');
      // 500 * 15M / 1M = 7500 microdollars = $0.0075
      expect(rootSpan.SpanAttributes['ai.cost.output']).toBe('0.0075');
      // Total = 10500 microdollars = $0.0105
      expect(rootSpan.SpanAttributes['ai.cost.total']).toBe('0.0105');
    });

    it('should not add cost attributes when pricing is not provided', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 1000,
          completionTokens: 500,
        },
      };

      const traces = buildTraces(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['ai.cost.input']).toBeUndefined();
      expect(rootSpan.SpanAttributes['ai.cost.output']).toBeUndefined();
      expect(rootSpan.SpanAttributes['ai.cost.total']).toBeUndefined();
    });

    it('should not add cost attributes when pricing is null', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 1000,
          completionTokens: 500,
        },
      };

      const traces = buildTraces(message, null);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['ai.cost.input']).toBeUndefined();
      expect(rootSpan.SpanAttributes['ai.cost.output']).toBeUndefined();
      expect(rootSpan.SpanAttributes['ai.cost.total']).toBeUndefined();
    });

    it('should add cache_read cost when > 0', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 1000,
          completionTokens: 500,
          cacheReadTokens: 2000,
        },
      };

      const traces = buildTraces(message, samplePricing);
      const rootSpan = traces[0]!;

      // 2000 * 300K / 1M = 600 microdollars = $0.0006
      expect(rootSpan.SpanAttributes['ai.cost.cache_read']).toBe('0.0006');
    });

    it('should add cache_creation cost when > 0', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 1000,
          completionTokens: 500,
          cacheCreationTokens: 1000,
        },
      };

      const traces = buildTraces(message, samplePricing);
      const rootSpan = traces[0]!;

      // 1000 * 3.75M / 1M = 3750 microdollars = $0.00375
      expect(rootSpan.SpanAttributes['ai.cost.cache_creation']).toBe('0.00375');
    });

    it('should add reasoning cost when > 0', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 1000,
          completionTokens: 500,
          reasoningTokens: 200,
        },
      };

      const traces = buildTraces(message, samplePricing);
      const rootSpan = traces[0]!;

      // 200 * 15M / 1M = 3000 microdollars = $0.003
      expect(rootSpan.SpanAttributes['ai.cost.reasoning']).toBe('0.003');
    });

    it('should not include cache_read when cost is 0', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 1000,
          completionTokens: 500,
          cacheReadTokens: 0,
        },
      };

      const traces = buildTraces(message, samplePricing);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['ai.cost.cache_read']).toBeUndefined();
    });

    it('should not include cache_creation when cost is 0', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 1000,
          completionTokens: 500,
          cacheCreationTokens: 0,
        },
      };

      const traces = buildTraces(message, samplePricing);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['ai.cost.cache_creation']).toBeUndefined();
    });

    it('should not include reasoning when cost is 0', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 1000,
          completionTokens: 500,
          reasoningTokens: 0,
        },
      };

      const traces = buildTraces(message, samplePricing);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['ai.cost.reasoning']).toBeUndefined();
    });

    it('should format costs as dollar strings not microdollars', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 1000000, // 1 million tokens
          completionTokens: 0,
        },
      };

      const traces = buildTraces(message, samplePricing);
      const rootSpan = traces[0]!;

      // 1M * 3M / 1M = 3M microdollars = $3
      expect(rootSpan.SpanAttributes['ai.cost.input']).toBe('3');
      expect(rootSpan.SpanAttributes['ai.cost.total']).toBe('3');
    });
  });
});
