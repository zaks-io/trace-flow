import { describe, it, expect } from 'vitest';
import { formatBodyForDisplay } from '../index';

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

    it('should handle malformed SSE as text', () => {
      const malformed = 'event: test\ndata:';
      const result = formatBodyForDisplay(malformed);
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
