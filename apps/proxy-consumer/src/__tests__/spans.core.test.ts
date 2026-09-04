import { describe, expect, it } from 'vitest';
import type { QueueMessage } from '@trace-flow/types';
import { buildSpans } from '../spans';
import { baseQueueMessage } from './spansTest.setup';

describe('buildSpans core trace generation', () => {
  describe('basic trace generation', () => {
    it('should generate root span with correct structure', () => {
      const traces = buildSpans(baseQueueMessage);

      expect(traces.length).toBeGreaterThanOrEqual(1);
      const rootSpan = traces[0]!;

      // OTel GenAI convention: "{gen_ai.operation.name} {model}"
      expect(rootSpan.SpanName).toBe('chat gpt-4');
      expect(rootSpan.SpanKind).toBe('SPAN_KIND_CLIENT');
      expect(rootSpan.TraceId).toBe('test-request-123');
      expect(rootSpan.ParentSpanId).toBe('');
      expect(rootSpan.ServiceName).toBe('llm-observability');
      expect(rootSpan.StatusCode).toBe('STATUS_CODE_OK');
      expect(rootSpan.StatusMessage).toBe('');
    });

    it('should set root span attributes correctly', () => {
      const traces = buildSpans(baseQueueMessage);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes).toMatchObject({
        'trace_flow.source': 'proxy',
        'gen_ai.request_id': 'test-request-123',
        'gen_ai.operation.name': 'chat',
        'gen_ai.system': 'openai',
        'gen_ai.request.model': 'gpt-4',
        'http.url': 'https://api.openai.com/v1/chat/completions',
        'http.response.status_code': '200',
      });
    });

    it('should calculate root span timing correctly', () => {
      const traces = buildSpans(baseQueueMessage);
      const rootSpan = traces[0]!;

      expect(rootSpan.Timestamp).toBe(1000 * 1000000);
      expect(rootSpan.Duration).toBe((1500 - 1000) * 1000000);
    });

    it('should include proxy overhead and upstream TTFB attributes', () => {
      const traces = buildSpans(baseQueueMessage);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['trace_flow.proxy_overhead_ms']).toBe('100');
      expect(rootSpan.SpanAttributes['trace_flow.upstream_ttfb_ms']).toBe('50');
    });
  });

  describe('token usage', () => {
    it('should include token usage in root span when provided', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 100,
          uncachedInputTokens: 75,
          completionTokens: 50,
          totalTokens: 150,
        },
      };

      const traces = buildSpans(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['gen_ai.usage.input_tokens']).toBe('100');
      expect(rootSpan.SpanAttributes['gen_ai.usage.input_tokens_uncached']).toBe('75');
      expect(rootSpan.SpanAttributes['gen_ai.usage.output_tokens']).toBe('50');
    });

    it('should include cached tokens count when present (OpenAI)', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          cacheReadTokens: 25,
        },
      };

      const traces = buildSpans(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['gen_ai.usage.cache_read_input_tokens']).toBe('25');
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

      const traces = buildSpans(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['gen_ai.usage.reasoning_tokens']).toBe('20');
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

      const traces = buildSpans(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['gen_ai.usage.cache_read_input_tokens']).toBe('30');
      expect(rootSpan.SpanAttributes['gen_ai.usage.cache_creation_input_tokens']).toBe('10');
    });

    it('should include cache baseline and impact costs when pricing is available', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 100,
          uncachedInputTokens: 20,
          completionTokens: 50,
          cacheReadTokens: 70,
          cacheCreationTokens: 10,
        },
      };

      const traces = buildSpans(message, {
        promptCostPerMillion: 3_000_000,
        completionCostPerMillion: 15_000_000,
        cacheReadCostPerMillion: 300_000,
        cacheWriteCostPerMillion: 3_750_000,
        updatedAt: Date.now(),
        source: 'manual',
      });
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['gen_ai.cost.prompt_baseline']).toBe('0.0003');
      expect(rootSpan.SpanAttributes['gen_ai.cost.cache_impact']).toBe('0.000181');
    });

    it('should include cache creation 5m/1h breakdown when present', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 100,
          completionTokens: 50,
          cacheCreationTokens: 556,
          cacheCreation5mTokens: 456,
          cacheCreation1hTokens: 100,
        },
      };

      const traces = buildSpans(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['gen_ai.usage.cache_creation_input_tokens']).toBe('556');
      expect(rootSpan.SpanAttributes['gen_ai.usage.cache_creation_5m_input_tokens']).toBe('456');
      expect(rootSpan.SpanAttributes['gen_ai.usage.cache_creation_1h_input_tokens']).toBe('100');
    });

    it('should include upstream cost when present (OpenRouter)', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 100,
          completionTokens: 50,
          upstreamCost: 0.06713,
        },
      };

      const traces = buildSpans(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['gen_ai.cost.upstream']).toBe('0.06713');
    });

    it('should handle partial token usage', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 100,
        },
      };

      const traces = buildSpans(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['gen_ai.usage.input_tokens']).toBe('100');
      expect(rootSpan.SpanAttributes['gen_ai.usage.output_tokens']).toBeUndefined();
    });

    it('should handle no token usage', () => {
      const traces = buildSpans(baseQueueMessage);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['gen_ai.usage.input_tokens']).toBeUndefined();
      expect(rootSpan.SpanAttributes['gen_ai.usage.output_tokens']).toBeUndefined();
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

      const traces = buildSpans(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.StatusCode).toBe('STATUS_CODE_ERROR');
      expect(rootSpan.StatusMessage).toBe('Invalid API key');
      expect(rootSpan.SpanAttributes['error.type']).toBe('invalid_request_error');
      expect(rootSpan.SpanAttributes['error.code']).toBe('invalid_api_key');
      expect(rootSpan.SpanAttributes['http.response.status_code']).toBe('401');
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

      const traces = buildSpans(message);
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

      const traces = buildSpans(message);

      const rootSpan = traces.find((t) => t.SpanAttributes['gen_ai.operation.name'] !== undefined);
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.SpanAttributes['gen_ai.server.time_to_first_token']).toBe(
        String(1250 - baseQueueMessage.timing.requestStart),
      );
    });

    it('should include TTFT attribute on root span when response.output_text.delta is present (Responses API)', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        sseStreamData: {
          messages: [
            {
              messageStart: 1150,
              messageStop: 1480,
              events: [
                { type: 'response.created', timestamp: 1150, data: '{}' },
                { type: 'response.output_text.delta', timestamp: 1250, data: '{}' },
                { type: 'response.completed', timestamp: 1480, data: '{}' },
              ],
            },
          ],
        },
      };

      const traces = buildSpans(message);

      const rootSpan = traces.find((t) => t.SpanAttributes['gen_ai.operation.name'] !== undefined);
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.SpanAttributes['gen_ai.server.time_to_first_token']).toBe(
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

      const traces = buildSpans(message);

      const rootSpan = traces.find((t) => t.SpanAttributes['gen_ai.operation.name'] !== undefined);
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.SpanAttributes['gen_ai.server.time_to_first_token']).toBeUndefined();
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

      const traces = buildSpans(message);

      const textSpan = traces.find((t) => t.SpanName === 'gen_ai.response.text');
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

      const traces = buildSpans(message);

      const rootSpan = traces.find((t) => t.SpanAttributes['gen_ai.operation.name'] !== undefined)!;
      const textSpan = traces.find((t) => t.SpanName === 'gen_ai.response.text')!;

      expect(rootSpan.ParentSpanId).toBe('');
      expect(textSpan.ParentSpanId).toBe(rootSpan.SpanId);
      // TTFT is now an attribute on root span, not a separate span
      expect(rootSpan.SpanAttributes['gen_ai.server.time_to_first_token']).toBeDefined();
    });

    it('should generate unique span IDs', () => {
      const traces = buildSpans(baseQueueMessage);

      const spanIds = traces.map((t) => t.SpanId);
      const uniqueSpanIds = new Set(spanIds);

      expect(uniqueSpanIds.size).toBe(spanIds.length);
    });

    it('should use same trace ID for all spans', () => {
      const traces = buildSpans(baseQueueMessage);

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

      const traces = buildSpans(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['gen_ai.system']).toBe('anthropic');
      expect(rootSpan.SpanAttributes['http.url']).toBe('https://api.anthropic.com/v1/messages');
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

      const traces = buildSpans(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['gen_ai.system']).toBe('google');
    });
  });

  describe('API key propagation', () => {
    it('should include API key in all spans', () => {
      const traces = buildSpans(baseQueueMessage);

      traces.forEach((trace) => {
        expect(trace.ApiKey).toBe('test-api-key');
      });
    });
  });
});
