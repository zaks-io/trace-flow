import { describe, it, expect } from 'vitest';
import { formatBodyForDisplay, mergeSSEEvents, type ParsedSSEEvent } from '../index';

describe('formatBodyForDisplay', () => {
  describe('null/empty handling', () => {
    it('should return null for null input', () => {
      expect(formatBodyForDisplay(null)).toBeNull();
    });

    it('should handle empty string as text', () => {
      const result = formatBodyForDisplay('');
      expect(result).toEqual({
        format: 'text',
        content: '',
        raw: '',
      });
    });

    it('should handle whitespace-only string as text', () => {
      const result = formatBodyForDisplay('   \n  \t  ');
      expect(result).toEqual({
        format: 'text',
        content: '   \n  \t  ',
        raw: '   \n  \t  ',
      });
    });
  });

  describe('JSON format', () => {
    it('should parse valid JSON object', () => {
      const json = '{"model":"gpt-4","messages":[{"role":"user","content":"Hello"}]}';
      const result = formatBodyForDisplay(json);
      expect(result?.format).toBe('json');
      expect(result?.content).toEqual({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
      });
      expect(result?.raw).toBe(json);
    });

    it('should parse valid JSON array', () => {
      const json = '[{"id":1},{"id":2}]';
      const result = formatBodyForDisplay(json);
      expect(result?.format).toBe('json');
      expect(result?.content).toEqual([{ id: 1 }, { id: 2 }]);
      expect(result?.raw).toBe(json);
    });

    it('should parse JSON with whitespace', () => {
      const json = '  \n  {"key": "value"}  \n  ';
      const result = formatBodyForDisplay(json);
      expect(result?.format).toBe('json');
      expect(result?.content).toEqual({ key: 'value' });
    });

    it('should handle malformed JSON as text', () => {
      const malformed = '{"key": "value"';
      const result = formatBodyForDisplay(malformed);
      expect(result?.format).toBe('text');
      expect(result?.content).toBe(malformed);
    });

    it('should handle JSON-like but invalid syntax as text', () => {
      const invalid = '{not valid json}';
      const result = formatBodyForDisplay(invalid);
      expect(result?.format).toBe('text');
      expect(result?.content).toBe(invalid);
    });
  });

  describe('SSE format', () => {
    it('should parse Anthropic SSE stream', () => {
      const sseBody = `event: message_start
data: {"type":"message_start","message":{"model":"claude-sonnet-4-5-20250929","id":"msg_01BK1fpyqpgrrGvA4HTgaNCu","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":8,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":3,"service_tier":"standard"}}  }

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello! How"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" can I help you today?"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":8,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":12}}

event: message_stop
data: {"type":"message_stop"}

`;

      const result = formatBodyForDisplay(sseBody);
      expect(result?.format).toBe('sse');
      expect(Array.isArray(result?.content)).toBe(true);

      const events = result?.content as { event: string | null; data: string }[];
      expect(events).toBeDefined();
      expect(events.length).toBe(7);
      expect(events[0]?.event).toBe('message_start');
      expect(events[0]?.data).toContain('claude-sonnet-4-5-20250929');
      expect(events[6]?.event).toBe('message_stop');
    });

    it('should parse SSE without event names', () => {
      const sseBody = `data: first message

data: second message

`;

      const result = formatBodyForDisplay(sseBody);
      expect(result?.format).toBe('sse');

      const events = result?.content as { event: string | null; data: string }[];
      expect(events).toBeDefined();
      expect(events.length).toBe(2);
      expect(events[0]?.event).toBeNull();
      expect(events[0]?.data).toBe('first message');
      expect(events[1]?.data).toBe('second message');
    });

    it('should parse SSE with IDs', () => {
      const sseBody = `id: 123
event: update
data: test data

`;

      const result = formatBodyForDisplay(sseBody);
      expect(result?.format).toBe('sse');

      const events = result?.content as { event: string | null; data: string; id?: string }[];
      expect(events).toBeDefined();
      expect(events.length).toBe(1);
      expect(events[0]?.id).toBe('123');
      expect(events[0]?.event).toBe('update');
      expect(events[0]?.data).toBe('test data');
    });

    it('should handle SSE without trailing newline', () => {
      // Per SSE spec, events are only dispatched after a blank line
      // So incomplete SSE without trailing \n\n produces no events
      const malformed = 'event: test\ndata:';
      const result = formatBodyForDisplay(malformed);
      expect(result?.format).toBe('sse');

      const events = result?.content as { event: string | null; data: string }[];
      expect(events).toBeDefined();
      expect(events.length).toBe(0);
    });

    it('should parse SSE with empty data field', () => {
      const sse = 'event: test\ndata:\n\n';
      const result = formatBodyForDisplay(sse);
      expect(result?.format).toBe('sse');

      const events = result?.content as { event: string | null; data: string }[];
      expect(events).toBeDefined();
      expect(events.length).toBe(1);
      expect(events[0]?.event).toBe('test');
      expect(events[0]?.data).toBe('');
    });
  });

  describe('plain text format', () => {
    it('should handle plain text', () => {
      const text = 'This is just plain text';
      const result = formatBodyForDisplay(text);
      expect(result?.format).toBe('text');
      expect(result?.content).toBe(text);
      expect(result?.raw).toBe(text);
    });

    it('should handle multi-line text', () => {
      const text = 'Line 1\nLine 2\nLine 3';
      const result = formatBodyForDisplay(text);
      expect(result?.format).toBe('text');
      expect(result?.content).toBe(text);
    });

    it('should handle text with special characters', () => {
      const text = 'Text with <html> tags and {braces}';
      const result = formatBodyForDisplay(text);
      expect(result?.format).toBe('text');
      expect(result?.content).toBe(text);
    });

    it('should handle binary-looking data as text', () => {
      const text = '\x00\x01\x02\x03';
      const result = formatBodyForDisplay(text);
      expect(result?.format).toBe('text');
      expect(result?.content).toBe(text);
    });
  });

  describe('edge cases', () => {
    it('should handle text that looks like JSON start but is not complete', () => {
      const text = '{ this is not json';
      const result = formatBodyForDisplay(text);
      expect(result?.format).toBe('text');
    });

    it('should handle text that contains "event:" but is not SSE', () => {
      const text = 'The event: field should be defined';
      const result = formatBodyForDisplay(text);
      expect(result?.format).toBe('sse');
    });

    it('should handle very large JSON', () => {
      const largeObj = { data: Array(1000).fill('x').join('') };
      const json = JSON.stringify(largeObj);
      const result = formatBodyForDisplay(json);
      expect(result?.format).toBe('json');
      expect(result?.content).toEqual(largeObj);
    });
  });
});

describe('mergeSSEEvents', () => {
  describe('OpenAI format', () => {
    it('should merge OpenAI streaming response', () => {
      const events: ParsedSSEEvent[] = [
        {
          event: null,
          data: '{"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
        },
        {
          event: null,
          data: '{"id":"chatcmpl-123","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
        },
        {
          event: null,
          data: '{"id":"chatcmpl-123","choices":[{"index":0,"delta":{"content":" world!"},"finish_reason":null}]}',
        },
        {
          event: null,
          data: '{"id":"chatcmpl-123","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
        },
        { event: null, data: '[DONE]' },
      ];

      const result = mergeSSEEvents(events);

      expect(result.id).toBe('chatcmpl-123');
      expect(result.model).toBe('gpt-4');
      expect(result.created).toBe(1234567890);
      expect(result.choices.length).toBe(1);
      expect(result.choices[0]!.message.role).toBe('assistant');
      expect(result.choices[0]!.message.content).toBe('Hello world!');
      expect(result.choices[0]!.finish_reason).toBe('stop');
      expect(result.usage?.prompt_tokens).toBe(10);
      expect(result.usage?.completion_tokens).toBe(5);
    });

    it('should handle OpenAI tool calls', () => {
      const events: ParsedSSEEvent[] = [
        {
          event: null,
          data: '{"id":"chatcmpl-123","model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}',
        },
        {
          event: null,
          data: '{"id":"chatcmpl-123","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}',
        },
        {
          event: null,
          data: '{"id":"chatcmpl-123","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"NYC\\"}"}}]}}]}',
        },
        {
          event: null,
          data: '{"id":"chatcmpl-123","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        },
      ];

      const result = mergeSSEEvents(events);

      expect(result.choices[0]!.message.tool_calls).toBeDefined();
      expect(result.choices[0]!.message.tool_calls?.length).toBe(1);
      expect(result.choices[0]!.message.tool_calls?.[0]!.id).toBe('call_123');
      expect(result.choices[0]!.message.tool_calls?.[0]!.function.name).toBe('get_weather');
      expect(result.choices[0]!.message.tool_calls?.[0]!.function.arguments).toBe('{"city":"NYC"}');
      expect(result.choices[0]!.finish_reason).toBe('tool_calls');
    });
  });

  describe('Anthropic format', () => {
    it('should merge Anthropic streaming response', () => {
      const events: ParsedSSEEvent[] = [
        {
          event: 'message_start',
          data: '{"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","model":"claude-sonnet-4-5-20250929","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}',
        },
        {
          event: 'content_block_start',
          data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        },
        {
          event: 'content_block_delta',
          data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
        },
        {
          event: 'content_block_delta',
          data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world!"}}',
        },
        {
          event: 'content_block_stop',
          data: '{"type":"content_block_stop","index":0}',
        },
        {
          event: 'message_delta',
          data: '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
        },
        {
          event: 'message_stop',
          data: '{"type":"message_stop"}',
        },
      ];

      const result = mergeSSEEvents(events);

      expect(result.id).toBe('msg_123');
      expect(result.model).toBe('claude-sonnet-4-5-20250929');
      expect(result.choices.length).toBe(1);
      expect(result.choices[0]!.message.role).toBe('assistant');
      expect(result.choices[0]!.message.content).toBe('Hello world!');
      expect(result.choices[0]!.finish_reason).toBe('end_turn');
      expect(result.usage?.input_tokens).toBe(10);
      expect(result.usage?.output_tokens).toBe(5);
    });

    it('should handle Anthropic usage with cache tokens', () => {
      const events: ParsedSSEEvent[] = [
        {
          event: 'message_start',
          data: '{"type":"message_start","message":{"id":"msg_123","model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":50,"output_tokens":1}}}',
        },
        {
          event: 'content_block_delta',
          data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Test"}}',
        },
        {
          event: 'message_delta',
          data: '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}',
        },
      ];

      const result = mergeSSEEvents(events);

      expect(result.usage?.input_tokens).toBe(10);
      expect(result.usage?.cache_creation_input_tokens).toBe(100);
      expect(result.usage?.cache_read_input_tokens).toBe(50);
      expect(result.usage?.output_tokens).toBe(10);
    });
  });

  describe('edge cases', () => {
    it('should handle empty events array', () => {
      const result = mergeSSEEvents([]);

      expect(result.choices.length).toBe(1);
      expect(result.choices[0]!.message.content).toBe('');
      expect(result.choices[0]!.message.role).toBe('assistant');
    });

    it('should skip non-JSON data', () => {
      const events: ParsedSSEEvent[] = [
        { event: null, data: 'not json' },
        {
          event: null,
          data: '{"choices":[{"index":0,"delta":{"content":"Hello"}}]}',
        },
      ];

      const result = mergeSSEEvents(events);

      expect(result.choices[0]!.message.content).toBe('Hello');
    });

    it('should handle done events', () => {
      const events: ParsedSSEEvent[] = [
        {
          event: null,
          data: '{"choices":[{"index":0,"delta":{"content":"Hello"}}]}',
        },
        { event: 'done', data: '' },
        { event: null, data: '[DONE]' },
      ];

      const result = mergeSSEEvents(events);

      expect(result.choices[0]!.message.content).toBe('Hello');
    });
  });
});
