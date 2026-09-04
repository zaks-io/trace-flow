import { describe, expect, it } from 'vitest';
import type { QueueMessage } from '@trace-flow/types';
import { buildSpans } from '../spans';
import { baseQueueMessage } from './spansTest.setup';

describe('buildSpans tools, non-streaming responses, and costs', () => {
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

      const traces = buildSpans(message);

      const toolExecSpan = traces.find((t) => t.SpanName === 'gen_ai.tool.execution');
      expect(toolExecSpan).toBeDefined();
      expect(toolExecSpan?.Timestamp).toBe(500 * 1000000);
      expect(toolExecSpan?.Duration).toBe((1000 - 500) * 1000000);
      expect(toolExecSpan?.SpanAttributes['gen_ai.tool.id']).toBe('toolu_abc123');
      expect(toolExecSpan?.SpanAttributes['gen_ai.tool.name']).toBe('get_weather');
      expect(toolExecSpan?.SpanAttributes['gen_ai.original_trace_id']).toBe('original-trace-id');
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

      const traces = buildSpans(message);

      const toolExecSpans = traces.filter((t) => t.SpanName === 'gen_ai.tool.execution');
      expect(toolExecSpans.length).toBe(2);
    });
  });

  describe('non-streaming responses', () => {
    it('should create assistant response span for non-streaming responses', () => {
      const traces = buildSpans(baseQueueMessage);

      const responseSpan = traces.find((t) => t.SpanName === 'gen_ai.response.text');
      expect(responseSpan).toBeDefined();
      expect(responseSpan?.SpanAttributes['gen_ai.response.streaming']).toBe('false');
    });

    it('should not create assistant response span for error responses', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        response: {
          ...baseQueueMessage.response,
          status: 500,
        },
      };

      const traces = buildSpans(message);

      const responseSpan = traces.find((t) => t.SpanName === 'gen_ai.response.text');
      expect(responseSpan).toBeUndefined();
    });

    it('should create embedding response spans for non-streaming embedding requests', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        targetUrl: 'https://api.openai.com/v1/embeddings',
        request: {
          ...baseQueueMessage.request,
          model: 'text-embedding-3-small',
        },
        operationName: 'embeddings',
      };

      const traces = buildSpans(message);

      const responseSpan = traces.find((t) => t.SpanName === 'gen_ai.response.embedding');
      expect(responseSpan).toBeDefined();
      expect(responseSpan?.SpanAttributes['gen_ai.content.type']).toBe('embedding');

      const rootSpan = traces.find(
        (t) => t.SpanAttributes['gen_ai.operation.name'] === 'embeddings',
      );
      expect(rootSpan?.['Events.Name']).toContain('output.embedding');
      const eventIndex = rootSpan?.['Events.Name'].indexOf('output.embedding') ?? -1;
      const eventAttrs = JSON.parse(rootSpan?.['Events.Attributes'][eventIndex] ?? '{}');
      expect(eventAttrs['gen_ai.content.type']).toBe('embedding');
      expect(eventAttrs['gen_ai.response.streaming']).toBe('false');
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

      const traces = buildSpans(message, samplePricing);
      const rootSpan = traces[0]!;

      // 1000 * 3M / 1M = 3000 microdollars = $0.003
      expect(rootSpan.SpanAttributes['gen_ai.cost.input']).toBe('0.003');
      // 500 * 15M / 1M = 7500 microdollars = $0.0075
      expect(rootSpan.SpanAttributes['gen_ai.cost.output']).toBe('0.0075');
      // Total = 10500 microdollars = $0.0105
      expect(rootSpan.SpanAttributes['gen_ai.cost.total']).toBe('0.0105');
    });

    it('should not add cost attributes when pricing is not provided', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 1000,
          completionTokens: 500,
        },
      };

      const traces = buildSpans(message);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['gen_ai.cost.input']).toBeUndefined();
      expect(rootSpan.SpanAttributes['gen_ai.cost.output']).toBeUndefined();
      expect(rootSpan.SpanAttributes['gen_ai.cost.total']).toBeUndefined();
    });

    it('should not add cost attributes when pricing is null', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 1000,
          completionTokens: 500,
        },
      };

      const traces = buildSpans(message, null);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['gen_ai.cost.input']).toBeUndefined();
      expect(rootSpan.SpanAttributes['gen_ai.cost.output']).toBeUndefined();
      expect(rootSpan.SpanAttributes['gen_ai.cost.total']).toBeUndefined();
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

      const traces = buildSpans(message, samplePricing);
      const rootSpan = traces[0]!;

      // 2000 * 300K / 1M = 600 microdollars = $0.0006
      expect(rootSpan.SpanAttributes['gen_ai.cost.cache_read']).toBe('0.0006');
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

      const traces = buildSpans(message, samplePricing);
      const rootSpan = traces[0]!;

      // 1000 * 3.75M / 1M = 3750 microdollars = $0.00375
      expect(rootSpan.SpanAttributes['gen_ai.cost.cache_creation']).toBe('0.00375');
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

      const traces = buildSpans(message, samplePricing);
      const rootSpan = traces[0]!;

      // 200 * 15M / 1M = 3000 microdollars = $0.003
      expect(rootSpan.SpanAttributes['gen_ai.cost.reasoning']).toBe('0.003');
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

      const traces = buildSpans(message, samplePricing);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['gen_ai.cost.cache_read']).toBeUndefined();
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

      const traces = buildSpans(message, samplePricing);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['gen_ai.cost.cache_creation']).toBeUndefined();
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

      const traces = buildSpans(message, samplePricing);
      const rootSpan = traces[0]!;

      expect(rootSpan.SpanAttributes['gen_ai.cost.reasoning']).toBeUndefined();
    });

    it('should format costs as dollar strings not microdollars', () => {
      const message: QueueMessage = {
        ...baseQueueMessage,
        tokens: {
          promptTokens: 1000000, // 1 million tokens
          completionTokens: 0,
        },
      };

      const traces = buildSpans(message, samplePricing);
      const rootSpan = traces[0]!;

      // 1M * 3M / 1M = 3M microdollars = $3
      expect(rootSpan.SpanAttributes['gen_ai.cost.input']).toBe('3');
      expect(rootSpan.SpanAttributes['gen_ai.cost.total']).toBe('3');
    });
  });
});
