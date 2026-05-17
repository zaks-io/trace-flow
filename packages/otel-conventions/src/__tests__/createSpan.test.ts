import { describe, it, expect } from 'vitest';
import { createSpan, packEvents, SPAN_KIND, STATUS_CODE, type SpanBase } from '../index';

const base: SpanBase = {
  traceId: 'trace-123',
  receivedAt: 1_000_000,
  apiKey: 'tf-test',
  tierAtIngestion: 'hobby',
  retentionExpiresAt: 2_000_000,
  serviceName: 'llm-observability',
};

describe('packEvents', () => {
  it('repacks ms events into parallel ns arrays with JSON-stringified attributes', () => {
    const result = packEvents([
      { timestampMs: 100, name: 'tool_call.start', attributes: { a: '1' } },
      { timestampMs: 200, name: 'tool_call.end', attributes: { a: '2' } },
    ]);
    expect(result.Timestamp).toEqual([100_000_000, 200_000_000]);
    expect(result.Name).toEqual(['tool_call.start', 'tool_call.end']);
    expect(result.Attributes).toEqual([JSON.stringify({ a: '1' }), JSON.stringify({ a: '2' })]);
  });
});

describe('createSpan', () => {
  it('produces a 22-field TinybirdTrace with sensible defaults', () => {
    const span = createSpan(base, {
      spanId: 'span-1',
      spanName: 'chat gpt-4',
      spanKind: SPAN_KIND.CLIENT,
      parentSpanId: '',
      timestampMs: 1000,
      durationMs: 250,
      attributes: { 'gen_ai.system': 'openai' },
    });

    expect(span).toMatchObject({
      ReceivedAt: 1_000_000,
      Timestamp: 1_000_000_000,
      TraceId: 'trace-123',
      SpanId: 'span-1',
      ParentSpanId: '',
      TraceState: '',
      SpanName: 'chat gpt-4',
      SpanKind: 'SPAN_KIND_CLIENT',
      ServiceName: 'llm-observability',
      ResourceAttributes: { 'service.name': 'llm-observability' },
      SpanAttributes: { 'gen_ai.system': 'openai' },
      Duration: 250_000_000,
      StatusCode: 'STATUS_CODE_OK',
      StatusMessage: '',
      ApiKey: 'tf-test',
      'Events.Timestamp': [],
      'Events.Name': [],
      'Events.Attributes': [],
      'Links.TraceId': [],
      'Links.SpanId': [],
      'Links.TraceState': [],
      'Links.Attributes': [],
      TierAtIngestion: 'hobby',
      RetentionExpiresAt: 2_000_000,
    });
  });

  it('generates a SpanId when not provided', () => {
    const span = createSpan(base, {
      spanName: 'x',
      spanKind: SPAN_KIND.INTERNAL,
      parentSpanId: 'parent',
      timestampMs: 0,
      durationMs: 0,
      attributes: {},
    });
    expect(span.SpanId).toMatch(/^[0-9a-f]+$/);
    expect(span.SpanId.length).toBeGreaterThan(0);
  });

  it('packs events and links when supplied', () => {
    const span = createSpan(base, {
      spanName: 'x',
      spanKind: SPAN_KIND.INTERNAL,
      parentSpanId: 'parent',
      timestampMs: 100,
      durationMs: 50,
      attributes: {},
      events: [{ timestampMs: 110, name: 'evt', attributes: { k: 'v' } }],
      linkedTraceIds: ['linked-trace'],
    });
    expect(span['Events.Timestamp']).toEqual([110_000_000]);
    expect(span['Events.Name']).toEqual(['evt']);
    expect(span['Events.Attributes']).toEqual([JSON.stringify({ k: 'v' })]);
    expect(span['Links.TraceId']).toEqual(['linked-trace']);
  });

  it('honors status overrides', () => {
    const span = createSpan(base, {
      spanName: 'x',
      spanKind: SPAN_KIND.CLIENT,
      parentSpanId: '',
      timestampMs: 0,
      durationMs: 0,
      attributes: {},
      statusCode: STATUS_CODE.ERROR,
      statusMessage: 'rate limit',
    });
    expect(span.StatusCode).toBe('STATUS_CODE_ERROR');
    expect(span.StatusMessage).toBe('rate limit');
  });
});
