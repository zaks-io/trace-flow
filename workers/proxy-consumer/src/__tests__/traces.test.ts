import { describe, it, expect } from 'vitest';
import { buildTraces } from '../traces';
import type { QueueMessage } from '@observe/types';

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
  };

  describe('basic trace generation', () => {
    it('should generate root span with correct structure', () => {
      const traces = buildTraces(baseQueueMessage);

      expect(traces.length).toBeGreaterThanOrEqual(1);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanName).toBe('llm.request');
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
        'llm.request_id': 'test-request-123',
        'llm.provider': 'openai',
        'llm.model': 'gpt-4',
        'llm.target_url': 'https://api.openai.com/v1/chat/completions',
        'http.status_code': '200',
      });
    });

    it('should calculate root span timing correctly', () => {
      const traces = buildTraces(baseQueueMessage);
      const rootSpan = traces[0]!;

      expect(rootSpan.Timestamp).toBe(1000 * 1000000);
      expect(rootSpan.Duration).toBe((1500 - 1000) * 1000000);
    });

    it('should generate request send span', () => {
      const traces = buildTraces(baseQueueMessage);

      const requestSpan = traces.find((t) => t.SpanName === 'llm.request.send');
      expect(requestSpan).toBeDefined();
      expect(requestSpan?.SpanKind).toBe('SPAN_KIND_INTERNAL');
      expect(requestSpan?.ParentSpanId).toBe(traces[0]!.SpanId);
      expect(requestSpan?.Timestamp).toBe(1000 * 1000000);
      expect(requestSpan?.Duration).toBe((1100 - 1000) * 1000000);
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

      expect(rootSpan.SpanAttributes['llm.tokens.prompt']).toBe('100');
      expect(rootSpan.SpanAttributes['llm.tokens.completion']).toBe('50');
      expect(rootSpan.SpanAttributes['llm.tokens.total']).toBe('150');
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

      expect(rootSpan.SpanAttributes['llm.cached']).toBe('true');
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

      expect(rootSpan.SpanAttributes['llm.tokens.prompt']).toBe('100');
      expect(rootSpan.SpanAttributes['llm.tokens.completion']).toBeUndefined();
      expect(rootSpan.SpanAttributes['llm.tokens.total']).toBeUndefined();
    });

    it('should handle no token usage', () => {
      const traces = buildTraces(baseQueueMessage);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['llm.tokens.prompt']).toBeUndefined();
      expect(rootSpan.SpanAttributes['llm.tokens.completion']).toBeUndefined();
      expect(rootSpan.SpanAttributes['llm.tokens.total']).toBeUndefined();
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

  describe('TTFT and streaming spans', () => {
    it('should generate TTFT span when firstTokenReceived is present', () => {
      const traces = buildTraces(baseQueueMessage);

      const ttftSpan = traces.find((t) => t.SpanName === 'llm.request.ttft');
      expect(ttftSpan).toBeDefined();
      expect(ttftSpan?.Timestamp).toBe(1100 * 1000000);
      expect(ttftSpan?.Duration).toBe((1200 - 1100) * 1000000);
      expect(ttftSpan?.SpanAttributes['llm.time_to_first_token_ms']).toBe('100');
    });

    it('should generate streaming span when firstTokenReceived is present', () => {
      const traces = buildTraces(baseQueueMessage);

      const streamingSpan = traces.find((t) => t.SpanName === 'llm.response.streaming');
      expect(streamingSpan).toBeDefined();
      expect(streamingSpan?.Timestamp).toBe(1200 * 1000000);
      expect(streamingSpan?.Duration).toBe((1500 - 1200) * 1000000);
    });

    it('should not generate TTFT/streaming spans when firstTokenReceived is missing', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        timing: {
          ...baseQueueMessage.timing,
          firstTokenReceived: undefined,
        },
      };

      const traces = buildTraces(message);

      const ttftSpan = traces.find((t) => t.SpanName === 'llm.request.ttft');
      const streamingSpan = traces.find((t) => t.SpanName === 'llm.response.streaming');

      expect(ttftSpan).toBeUndefined();
      expect(streamingSpan).toBeUndefined();
    });
  });

  describe('SSE spans', () => {
    it('should generate SSE message span when SSE timing is present', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseMessageTiming: {
          messageStart: 1150,
          firstDelta: 1250,
          messageStop: 1480,
        },
      };

      const traces = buildTraces(message);

      const messageSpan = traces.find((t) => t.SpanName === 'llm.stream.message');
      expect(messageSpan).toBeDefined();
      expect(messageSpan?.Timestamp).toBe(1150 * 1000000);
      expect(messageSpan?.Duration).toBe((1480 - 1150) * 1000000);
      expect(messageSpan?.SpanAttributes['llm.time_to_first_token_ms']).toBe('100');
    });

    it('should include SSE token usage from metadata', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseMessageTiming: {
          messageStart: 1150,
          messageStop: 1480,
        },
        sseMetadata: {
          finalUsage: {
            input_tokens: 120,
            output_tokens: 80,
          },
        },
      };

      const traces = buildTraces(message);

      const messageSpan = traces.find((t) => t.SpanName === 'llm.stream.message');
      expect(messageSpan?.SpanAttributes['llm.tokens.input']).toBe('120');
      expect(messageSpan?.SpanAttributes['llm.tokens.output']).toBe('80');
    });

    it('should handle SSE metadata with invalid input_tokens type', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseMessageTiming: {
          messageStart: 1150,
          messageStop: 1480,
        },
        sseMetadata: {
          finalUsage: {
            input_tokens: '120' as unknown as number,
            output_tokens: 80,
          },
        },
      };

      const traces = buildTraces(message);

      const messageSpan = traces.find((t) => t.SpanName === 'llm.stream.message');
      expect(messageSpan?.SpanAttributes['llm.tokens.input']).toBeUndefined();
      expect(messageSpan?.SpanAttributes['llm.tokens.output']).toBe('80');
    });

    it('should handle SSE metadata with invalid output_tokens type', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseMessageTiming: {
          messageStart: 1150,
          messageStop: 1480,
        },
        sseMetadata: {
          finalUsage: {
            input_tokens: 120,
            output_tokens: null as unknown as number,
          },
        },
      };

      const traces = buildTraces(message);

      const messageSpan = traces.find((t) => t.SpanName === 'llm.stream.message');
      expect(messageSpan?.SpanAttributes['llm.tokens.input']).toBe('120');
      expect(messageSpan?.SpanAttributes['llm.tokens.output']).toBeUndefined();
    });

    it('should handle SSE metadata with missing finalUsage', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseMessageTiming: {
          messageStart: 1150,
          messageStop: 1480,
        },
        sseMetadata: {
          usage: {
            input_tokens: 100,
            output_tokens: 50,
          },
        },
      };

      const traces = buildTraces(message);

      const messageSpan = traces.find((t) => t.SpanName === 'llm.stream.message');
      expect(messageSpan?.SpanAttributes['llm.tokens.input']).toBeUndefined();
      expect(messageSpan?.SpanAttributes['llm.tokens.output']).toBeUndefined();
    });

    it('should handle SSE timing without firstDelta', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseMessageTiming: {
          messageStart: 1150,
          messageStop: 1480,
        },
      };

      const traces = buildTraces(message);

      const messageSpan = traces.find((t) => t.SpanName === 'llm.stream.message');
      expect(messageSpan).toBeDefined();
      expect(messageSpan?.SpanAttributes['llm.time_to_first_token_ms']).toBeUndefined();
    });

    it('should not generate SSE span when timing is incomplete', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseMessageTiming: {
          messageStart: 1150,
        },
      };

      const traces = buildTraces(message);

      const messageSpan = traces.find((t) => t.SpanName === 'llm.stream.message');
      expect(messageSpan).toBeUndefined();
    });

    it('should prefer SSE spans over TTFT spans when both are available', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseMessageTiming: {
          messageStart: 1150,
          messageStop: 1480,
        },
      };

      const traces = buildTraces(message);

      const messageSpan = traces.find((t) => t.SpanName === 'llm.stream.message');
      const ttftSpan = traces.find((t) => t.SpanName === 'llm.request.ttft');

      expect(messageSpan).toBeDefined();
      expect(ttftSpan).toBeUndefined();
    });
  });

  describe('span hierarchy', () => {
    it('should create correct parent-child relationships', () => {
      const traces = buildTraces(baseQueueMessage);

      const rootSpan = traces.find((t) => t.SpanName === 'llm.request')!;
      const requestSpan = traces.find((t) => t.SpanName === 'llm.request.send')!;
      const ttftSpan = traces.find((t) => t.SpanName === 'llm.request.ttft')!;

      expect(rootSpan.ParentSpanId).toBe('');
      expect(requestSpan.ParentSpanId).toBe(rootSpan.SpanId);
      expect(ttftSpan.ParentSpanId).toBe(rootSpan.SpanId);
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

      expect(rootSpan.SpanAttributes['llm.provider']).toBe('anthropic');
      expect(rootSpan.SpanAttributes['llm.target_url']).toBe(
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

      expect(rootSpan.SpanAttributes['llm.provider']).toBe('google');
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
});
