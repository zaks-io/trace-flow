import { describe, expect, it } from 'vitest';
import { TraceSpanRowSchema } from '../TraceSpanRow';

const minimalValid = {
  Timestamp: 1_700_000_000_000_000_000,
  TraceId: 'abc123',
  SpanId: 'def456',
  SpanName: 'chat openai gpt-4',
  ServiceName: 'trace-flow-proxy',
  Duration: 1_500_000_000,
  StatusCode: 'OK',
  SpanAttributes: '{"gen_ai.system":"openai"}',
};

describe('TraceSpanRowSchema', () => {
  it('parses a minimal row from traces_list', () => {
    expect(() => TraceSpanRowSchema.parse(minimalValid)).not.toThrow();
  });

  it('parses a full row from trace_detail with Events arrays', () => {
    const row = {
      ...minimalValid,
      ReceivedAt: 1_700_000_000_000_000_000,
      ParentSpanId: 'parent-1',
      SpanKind: 'CLIENT',
      StatusMessage: '',
      ResourceAttributes: '{"service.name":"trace-flow-proxy"}',
      'Events.Timestamp': [1_700_000_000_500_000_000],
      'Events.Name': ['gen_ai.choice'],
      'Events.Attributes': ['{"finish_reason":"stop"}'],
    };
    expect(() => TraceSpanRowSchema.parse(row)).not.toThrow();
  });

  it('parses a row with BaggageOperation', () => {
    const row = { ...minimalValid, BaggageOperation: 'summarize' };
    const parsed = TraceSpanRowSchema.parse(row);
    expect(parsed.BaggageOperation).toBe('summarize');
  });

  it('rejects a row missing a required field', () => {
    const { TraceId: _omit, ...broken } = minimalValid;
    expect(() => TraceSpanRowSchema.parse(broken)).toThrow();
  });

  it('rejects a row with wrong type', () => {
    expect(() => TraceSpanRowSchema.parse({ ...minimalValid, Duration: 'not-a-number' })).toThrow();
  });

  it('rejects SpanAttributes that is an object (Tinybird sends JSON strings)', () => {
    expect(() =>
      TraceSpanRowSchema.parse({ ...minimalValid, SpanAttributes: { foo: 'bar' } }),
    ).toThrow();
  });
});
