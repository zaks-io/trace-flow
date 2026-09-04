import { describe, expect, it } from 'vitest';
import type { QueueMessage } from '@trace-flow/types';
import { buildSpans } from '../spans';
import { baseQueueMessage } from './spansTest.setup';

describe('buildSpans message events', () => {
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

      const traces = buildSpans(message);

      const contentBlockSpan = traces.find((t) => t.SpanName === 'gen_ai.response.text');
      expect(contentBlockSpan).toBeDefined();
      expect(contentBlockSpan?.Timestamp).toBe(1200 * 1000000);
      expect(contentBlockSpan?.Duration).toBe((1400 - 1200) * 1000000);
      expect(contentBlockSpan?.SpanAttributes['gen_ai.message.index']).toBe('0');
      expect(contentBlockSpan?.SpanAttributes['gen_ai.content.type']).toBe('text');
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

      const traces = buildSpans(message);

      const contentBlockSpan = traces.find((t) => t.SpanName === 'gen_ai.response.tool_use');
      expect(contentBlockSpan).toBeDefined();
      expect(contentBlockSpan?.SpanAttributes['gen_ai.message.index']).toBe('0');
      expect(contentBlockSpan?.SpanAttributes['gen_ai.content.type']).toBe('tool_use');
      expect(contentBlockSpan?.SpanAttributes['gen_ai.tool.id']).toBe('toolu_01abc123');
      expect(contentBlockSpan?.SpanAttributes['gen_ai.tool.name']).toBe('get_weather');
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

      const traces = buildSpans(message);

      const contentBlockSpan = traces.find((t) => t.SpanName.includes('gen_ai.response.'));
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

      const traces = buildSpans(message);

      // When there are multiple of the same type, they should be numbered
      const textSpans = traces.filter((t) => t.SpanName.startsWith('gen_ai.response.text'));
      const toolUseSpans = traces.filter((t) => t.SpanName.startsWith('gen_ai.response.tool_use'));

      expect(textSpans.length).toBe(2);
      expect(toolUseSpans.length).toBe(1);

      // Text spans should be numbered since there are 2
      expect(textSpans[0]?.SpanName).toBe('gen_ai.response.text.1');
      expect(textSpans[1]?.SpanName).toBe('gen_ai.response.text.2');

      // Tool use span should not be numbered since there's only 1
      expect(toolUseSpans[0]?.SpanName).toBe('gen_ai.response.tool_use');
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

      const traces = buildSpans(message);

      const thinkingSpan = traces.find((t) => t.SpanName === 'gen_ai.response.thinking');
      const textSpan = traces.find((t) => t.SpanName === 'gen_ai.response.text');

      expect(thinkingSpan).toBeDefined();
      expect(textSpan).toBeDefined();
      expect(thinkingSpan?.SpanAttributes['gen_ai.content.type']).toBe('thinking');
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

      const traces = buildSpans(message);

      const rootSpan = traces.find((t) => t.SpanAttributes['gen_ai.operation.name'] !== undefined);
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.['Events.Name']).toContain('input.system');
      const eventIndex = rootSpan?.['Events.Name'].indexOf('input.system');
      const eventAttrs = JSON.parse(rootSpan?.['Events.Attributes'][eventIndex!] ?? '{}');
      expect(eventAttrs['gen_ai.message.role']).toBe('system');
      expect(eventAttrs['gen_ai.message.index']).toBe('0');
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

      const traces = buildSpans(message);

      const rootSpan = traces.find((t) => t.SpanAttributes['gen_ai.operation.name'] !== undefined);
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.['Events.Name']).toContain('input.text');
      const eventIndex = rootSpan?.['Events.Name'].indexOf('input.text');
      const eventAttrs = JSON.parse(rootSpan?.['Events.Attributes'][eventIndex!] ?? '{}');
      expect(eventAttrs['gen_ai.message.role']).toBe('user');
      expect(eventAttrs['gen_ai.content.type']).toBe('text');
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

      const traces = buildSpans(message);

      const rootSpan = traces.find((t) => t.SpanAttributes['gen_ai.operation.name'] !== undefined);
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.['Events.Name']).toContain('input.text');
      const eventIndex = rootSpan?.['Events.Name'].indexOf('input.text');
      const eventAttrs = JSON.parse(rootSpan?.['Events.Attributes'][eventIndex!] ?? '{}');
      expect(eventAttrs['gen_ai.message.role']).toBe('assistant');
      expect(eventAttrs['gen_ai.content.type']).toBe('text');
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

      const traces = buildSpans(message);

      const rootSpan = traces.find((t) => t.SpanAttributes['gen_ai.operation.name'] !== undefined);
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.['Events.Name']).toContain('input.tool_result');
      const eventIndex = rootSpan?.['Events.Name'].indexOf('input.tool_result');
      const eventAttrs = JSON.parse(rootSpan?.['Events.Attributes'][eventIndex!] ?? '{}');
      expect(eventAttrs['gen_ai.message.role']).toBe('user');
      expect(eventAttrs['gen_ai.tool.id']).toBe('toolu_abc123');
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

      const traces = buildSpans(message);

      const rootSpan = traces.find((t) => t.SpanAttributes['gen_ai.operation.name'] !== undefined);
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

      const traces = buildSpans(message);

      const rootSpan = traces.find((t) => t.SpanAttributes['gen_ai.operation.name'] !== undefined);
      expect(rootSpan).toBeDefined();
      // Should have 1 text event and 2 tool_use events
      expect(rootSpan?.['Events.Name']).toContain('input.text');
      expect(rootSpan?.['Events.Name'].filter((n) => n === 'input.tool_use').length).toBe(2);

      // Check first tool_use event
      const toolUseIndex = rootSpan?.['Events.Name'].indexOf('input.tool_use');
      expect(toolUseIndex).toBeGreaterThanOrEqual(0);
      const firstToolAttrs = JSON.parse(rootSpan?.['Events.Attributes'][toolUseIndex!] ?? '{}');
      expect(firstToolAttrs['gen_ai.tool.id']).toBe('toolu_abc');
      expect(firstToolAttrs['gen_ai.tool.name']).toBe('get_weather');
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

      const traces = buildSpans(message);

      const rootSpan = traces.find((t) => t.SpanAttributes['gen_ai.operation.name'] !== undefined);
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.['Events.Name']).toContain('output.text');
      const eventIndex = rootSpan?.['Events.Name'].indexOf('output.text');
      const eventAttrs = JSON.parse(rootSpan?.['Events.Attributes'][eventIndex!] ?? '{}');
      expect(eventAttrs['gen_ai.content.type']).toBe('text');
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

      const traces = buildSpans(message);

      const rootSpan = traces.find((t) => t.SpanAttributes['gen_ai.operation.name'] !== undefined);
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.['Events.Name']).toContain('output.tool_use');
      const eventIndex = rootSpan?.['Events.Name'].indexOf('output.tool_use');
      const eventAttrs = JSON.parse(rootSpan?.['Events.Attributes'][eventIndex!] ?? '{}');
      expect(eventAttrs['gen_ai.tool.id']).toBe('toolu_abc');
      expect(eventAttrs['gen_ai.tool.name']).toBe('get_weather');
    });

    it('should add output event for non-streaming responses', () => {
      const traces = buildSpans(baseQueueMessage);

      const rootSpan = traces.find((t) => t.SpanAttributes['gen_ai.operation.name'] !== undefined);
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.['Events.Name']).toContain('output.text');
      const eventIndex = rootSpan?.['Events.Name'].indexOf('output.text');
      const eventAttrs = JSON.parse(rootSpan?.['Events.Attributes'][eventIndex!] ?? '{}');
      expect(eventAttrs['gen_ai.response.streaming']).toBe('false');
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

      const traces = buildSpans(message);

      const rootSpan = traces.find((t) => t.SpanAttributes['gen_ai.operation.name'] !== undefined);
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.['Events.Name']).toContain('output.thinking');
      expect(rootSpan?.['Events.Name']).toContain('output.text');
      expect(rootSpan?.['Events.Name']).toContain('output.tool_use');
    });
  });
});
