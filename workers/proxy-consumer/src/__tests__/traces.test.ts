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

    it('should include cached token indicator when present', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          cached: true,
        },
      };

      const traces = buildTraces(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['ai.cached']).toBe('true');
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

  describe('input message spans', () => {
    it('should create spans for system messages', () => {
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

      const systemSpan = traces.find((t) => t.SpanName === 'ai.request.system');
      expect(systemSpan).toBeDefined();
      expect(systemSpan?.Duration).toBe(0);
      expect(systemSpan?.SpanAttributes['ai.message.role']).toBe('system');
      expect(systemSpan?.SpanAttributes['ai.message.index']).toBe('0');
    });

    it('should create spans for user messages', () => {
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

      const userSpan = traces.find((t) => t.SpanName === 'ai.request.user');
      expect(userSpan).toBeDefined();
      expect(userSpan?.Duration).toBe(0);
      expect(userSpan?.SpanAttributes['ai.message.role']).toBe('user');
    });

    it('should create spans for assistant messages in history', () => {
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

      const assistantSpan = traces.find((t) => t.SpanName === 'ai.request.assistant');
      expect(assistantSpan).toBeDefined();
      expect(assistantSpan?.SpanAttributes['ai.message.role']).toBe('assistant');
    });

    it('should create spans for tool_result messages', () => {
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

      const toolResultSpan = traces.find((t) => t.SpanName === 'ai.request.tool_result');
      expect(toolResultSpan).toBeDefined();
      expect(toolResultSpan?.SpanAttributes['ai.message.role']).toBe('user');
      expect(toolResultSpan?.SpanAttributes['ai.tool.id']).toBe('toolu_abc123');
    });

    it('should create multiple input message spans', () => {
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

      const inputSpans = traces.filter(
        (t) =>
          t.SpanName === 'ai.request.system' ||
          t.SpanName === 'ai.request.user' ||
          t.SpanName === 'ai.request.assistant',
      );
      expect(inputSpans.length).toBe(4);
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
});
