import { describe, expect, it } from 'vitest';
import { getOriginalTraceparent, normalizeTraceRequest } from './ingress-tracing';

const TRACE_A = '1'.repeat(32);
const TRACE_B = '2'.repeat(32);
const PARENT = '3'.repeat(16);

function request(headers: HeadersInit = {}) {
  return new Request('https://gateway.trace-flow.dev/test', { headers });
}

describe('incoming trace normalization before SDK span creation', () => {
  it.each(['00', '01', '03'])('continues W3C IDs and sampled flag %s', (flags) => {
    const incoming = request({
      traceparent: `00-${TRACE_A}-${PARENT}-${flags}`,
      tracestate: 'vendor=value',
      baggage: 'customer=value',
    });
    const normalized = normalizeTraceRequest(incoming);
    expect(normalized.headers.get('sentry-trace')).toBe(
      `${TRACE_A}-${PARENT}-${Number.parseInt(flags, 16) & 1}`,
    );
    expect(normalized.headers.get('tracestate')).toBe('vendor=value');
    expect(normalized.headers.get('traceparent')).toBe(`00-${TRACE_A}-${PARENT}-${flags}`);
    expect(normalized.headers.get('baggage')).toBe('customer=value');
    expect(incoming.headers.has('sentry-trace')).toBe(false);
  });

  it('gives valid Sentry context precedence and aligns W3C domain parsing on conflicts', () => {
    const normalized = normalizeTraceRequest(
      request({
        'sentry-trace': `${TRACE_A}-${PARENT}-0`,
        traceparent: `00-${TRACE_B}-${'4'.repeat(16)}-01`,
        tracestate: 'vendor=other-parent',
      }),
    );
    expect(normalized.headers.get('sentry-trace')).toBe(`${TRACE_A}-${PARENT}-0`);
    expect(normalized.headers.get('traceparent')).toBe(`00-${TRACE_A}-${PARENT}-00`);
    expect(normalized.headers.has('tracestate')).toBe(false);
  });

  it('replaces malformed Sentry context with valid W3C context', () => {
    const normalized = normalizeTraceRequest(
      request({ 'sentry-trace': 'invalid', traceparent: `00-${TRACE_A}-${PARENT}-01` }),
    );
    expect(normalized.headers.get('sentry-trace')).toBe(`${TRACE_A}-${PARENT}-1`);
  });

  it('removes malformed Sentry context and its vendor state before SDK interpretation', () => {
    const normalized = normalizeTraceRequest(
      request({ 'sentry-trace': `${'0'.repeat(32)}-${PARENT}-1`, tracestate: 'vendor=value' }),
    );
    expect(normalized.headers.has('sentry-trace')).toBe(false);
    expect(normalized.headers.has('tracestate')).toBe(false);
  });

  it('does not invent a Sentry sampling decision when its incoming decision is absent', () => {
    const normalized = normalizeTraceRequest(request({ 'sentry-trace': `${TRACE_A}-${PARENT}` }));
    expect(normalized.headers.get('sentry-trace')).toBe(`${TRACE_A}-${PARENT}`);
    expect(normalized.headers.get('traceparent')).toBe(`00-${TRACE_A}-${PARENT}-00`);
    expect(getOriginalTraceparent(normalized)).toBeNull();
    expect(getOriginalTraceparent(normalizeTraceRequest(normalized))).toBeNull();
  });

  it('preserves the supplied W3C parent independently from Sentry conflict precedence', () => {
    const normalized = normalizeTraceRequest(
      request({
        'sentry-trace': `${TRACE_A}-${PARENT}-1`,
        traceparent: `00-${TRACE_B}-${'4'.repeat(16)}-01`,
      }),
    );
    expect(getOriginalTraceparent(normalized)).toMatchObject({
      traceId: TRACE_B,
      parentId: '4'.repeat(16),
    });
    expect(getOriginalTraceparent(normalizeTraceRequest(normalized))).toMatchObject({
      traceId: TRACE_B,
      parentId: '4'.repeat(16),
    });
    expect(
      getOriginalTraceparent(request({ traceparent: `00-${TRACE_A}-${PARENT}-01` })),
    ).toMatchObject({ traceId: TRACE_A, parentId: PARENT });
  });

  it.each([
    `ff-${TRACE_A}-${PARENT}-01`,
    `00-${'0'.repeat(32)}-${PARENT}-01`,
    `00-${TRACE_A}-${'0'.repeat(16)}-01`,
    `00-${TRACE_A}-${PARENT}-01-extra`,
    `00-${'a'.repeat(32).toUpperCase()}-${PARENT}-01`,
    `00-${TRACE_A}-${PARENT}-01,00-${TRACE_B}-${PARENT}-01`,
  ])('ignores invalid W3C context %s', (traceparent) => {
    const incoming = request({ traceparent });
    const normalized = normalizeTraceRequest(incoming);
    expect(normalized.headers.has('traceparent')).toBe(false);
    expect(normalized.headers.has('sentry-trace')).toBe(false);
  });

  it('accepts future-version W3C context without interpreting extension data', () => {
    const normalized = normalizeTraceRequest(
      request({ traceparent: `01-${TRACE_A}-${PARENT}-01-future` }),
    );
    expect(normalized.headers.get('sentry-trace')).toBe(`${TRACE_A}-${PARENT}-1`);
  });

  it('preserves an untraced request object and streams a normalized body without duplication', async () => {
    const untraced = request();
    expect(normalizeTraceRequest(untraced)).toBe(untraced);
    const incoming = new Request('https://gateway.trace-flow.dev/test', {
      method: 'POST',
      headers: { traceparent: `00-${TRACE_A}-${PARENT}-01`, 'content-type': 'application/json' },
      body: '{"operation":"test"}',
    });
    const normalized = normalizeTraceRequest(incoming);
    expect(normalized.method).toBe('POST');
    expect(normalized.headers.get('content-type')).toBe('application/json');
    expect(await normalized.text()).toBe('{"operation":"test"}');
  });
});
