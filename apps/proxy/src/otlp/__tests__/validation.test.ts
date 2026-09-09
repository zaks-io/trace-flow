import { describe, expect, it } from 'vitest';
import type { OTLPExportTraceServiceRequest } from '../types';
import { validateOTLPRequest } from '../validation';

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const SPAN_ID = '0123456789abcdef';

function requestWithValue(value: unknown): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'test.value', value }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: TRACE_ID,
                spanId: SPAN_ID,
                name: 'test',
                startTimeUnixNano: '1',
                endTimeUnixNano: '2',
              },
            ],
          },
        ],
      },
    ],
  };
}

function requestWithTimestamps(startTimeUnixNano: unknown, eventTimeUnixNano?: unknown) {
  const span = {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    name: 'test',
    startTimeUnixNano,
    endTimeUnixNano: '2',
    ...(eventTimeUnixNano === undefined
      ? {}
      : { events: [{ name: 'event', timeUnixNano: eventTimeUnixNano }] }),
  };
  return {
    span,
    request: { resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] },
  };
}

describe('validateOTLPRequest', () => {
  it('accepts and normalizes a numeric ProtoJSON intValue', () => {
    const request = requestWithValue({ intValue: 42 });

    expect(validateOTLPRequest(request)).toEqual({ valid: true });
    const typed = request as OTLPExportTraceServiceRequest;
    expect(typed.resourceSpans[0]!.resource!.attributes![0]!.value.intValue).toBe('42');
  });

  it.each([1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe numeric intValue %s', (intValue) => {
    expect(validateOTLPRequest(requestWithValue({ intValue }))).toMatchObject({
      valid: false,
      status: 400,
    });
  });

  it('rejects a quoted value outside the signed int64 range', () => {
    expect(
      validateOTLPRequest(requestWithValue({ intValue: '9223372036854775808' })),
    ).toMatchObject({ valid: false, status: 400 });
  });

  it('accepts an empty AnyValue but rejects a missing KeyValue value', () => {
    expect(validateOTLPRequest(requestWithValue({}))).toEqual({ valid: true });
    expect(validateOTLPRequest(requestWithValue(undefined))).toMatchObject({
      valid: false,
      status: 400,
    });
  });

  it.each(['-1', '18446744073709551616', '9'.repeat(1_000_000), Number.MAX_SAFE_INTEGER + 1])(
    'rejects an unsafe span timestamp',
    (timestamp) => {
      const { request } = requestWithTimestamps(timestamp);

      expect(validateOTLPRequest(request)).toMatchObject({ valid: false, status: 400 });
    },
  );

  it('normalizes safe numeric span and event timestamps', () => {
    const { request, span } = requestWithTimestamps(1, 2);

    expect(validateOTLPRequest(request)).toEqual({ valid: true });
    expect(span.startTimeUnixNano).toBe('1');
    expect(span.events?.[0]!.timeUnixNano).toBe('2');
  });

  it.each([
    ['short trace ID', { traceId: TRACE_ID.slice(2) }],
    ['non-hex trace ID', { traceId: 'z'.repeat(32) }],
    ['zero trace ID', { traceId: '0'.repeat(32) }],
    ['short span ID', { spanId: SPAN_ID.slice(2) }],
    ['non-hex span ID', { spanId: 'z'.repeat(16) }],
    ['zero span ID', { spanId: '0'.repeat(16) }],
    ['short parent span ID', { parentSpanId: SPAN_ID.slice(2) }],
  ])('rejects a %s', (_name, patch) => {
    const { request, span } = requestWithTimestamps('1');
    Object.assign(span, patch);

    expect(validateOTLPRequest(request)).toMatchObject({ valid: false, status: 400 });
  });

  it.each([
    ['trace ID', { traceId: TRACE_ID.slice(2), spanId: SPAN_ID }],
    ['span ID', { traceId: TRACE_ID, spanId: SPAN_ID.slice(2) }],
  ])('rejects a link with a short %s', (_name, link) => {
    const { request, span } = requestWithTimestamps('1');
    Object.assign(span, { links: [link] });

    expect(validateOTLPRequest(request)).toMatchObject({ valid: false, status: 400 });
  });
});
