import { describe, it, expect } from 'vitest';
import { formatEventRow, type EventRow } from '../tools/getTraceEventsAction';

describe('formatEventRow', () => {
  const baseRow: EventRow = {
    TraceId: 'abcdef0123456789abcdef0123456789',
    SpanId: '1234567890abcdef',
    SpanName: 'gen_ai.request',
    event_name: 'input.text',
    event_timestamp: 1700000000000000000,
    event_attributes: JSON.stringify({ 'gen_ai.message.role': 'user', content: 'Hello' }),
    total_count: 1,
  };

  it('parses basic event fields', () => {
    const result = formatEventRow(baseRow);
    expect(result.span_id).toBe('1234567890abcdef');
    expect(result.span_name).toBe('gen_ai.request');
    expect(result.event_name).toBe('input.text');
  });

  it('converts timestamp from nanoseconds to ISO string', () => {
    const result = formatEventRow(baseRow);
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });

  it('parses JSON attributes', () => {
    const result = formatEventRow(baseRow);
    expect(result.attributes).toEqual({
      'gen_ai.message.role': 'user',
      content: 'Hello',
    });
  });

  it('handles invalid JSON in attributes', () => {
    const row: EventRow = {
      ...baseRow,
      event_attributes: 'not valid json',
    };
    const result = formatEventRow(row);
    expect(result.attributes).toEqual({});
  });

  it('returns empty object for empty attributes string', () => {
    const row: EventRow = {
      ...baseRow,
      event_attributes: '',
    };
    const result = formatEventRow(row);
    expect(result.attributes).toEqual({});
  });

  it('handles empty JSON object in attributes', () => {
    const row: EventRow = {
      ...baseRow,
      event_attributes: '{}',
    };
    const result = formatEventRow(row);
    expect(result.attributes).toEqual({});
  });

  it('preserves nested attribute values', () => {
    const row: EventRow = {
      ...baseRow,
      event_attributes: JSON.stringify({
        'gen_ai.message.content': 'test message',
        'gen_ai.message.role': 'assistant',
        'gen_ai.content.type': 'text',
      }),
    };
    const result = formatEventRow(row);
    expect(result.attributes['gen_ai.message.content']).toBe('test message');
    expect(result.attributes['gen_ai.message.role']).toBe('assistant');
    expect(result.attributes['gen_ai.content.type']).toBe('text');
  });
});
