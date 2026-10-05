import * as Sentry from '@sentry/cloudflare';
import { describe, expect, it } from 'vitest';
import {
  currentSentryTraceContext,
  durableSentryTraceHeader,
  internalTraceHeaders,
  sentryTraceLinks,
} from './sentry-tracing';

const TRACE = '11111111111111111111111111111111';
const PARENT = '2222222222222222';

describe('explicit authenticated trace propagation', () => {
  it('uses the active SDK identity and removes unrelated baggage and vendor state', () => {
    Sentry.continueTrace(
      {
        sentryTrace: `${TRACE}-${PARENT}-1`,
        baggage: `sentry-trace_id=${TRACE},sentry-release=private-customer-value`,
      },
      () =>
        Sentry.startSpan({ name: 'authenticated caller' }, (span) => {
          const headers = internalTraceHeaders({
            Authorization: 'Bearer test-secret',
            baggage: 'private=value',
            tracestate: 'external=value',
            'sentry-trace': 'external',
            traceparent: 'external',
          });
          const context = span.spanContext();
          expect(currentSentryTraceContext()).toEqual({
            'sentry-trace': `${TRACE}-${context.spanId}-${context.traceFlags & 1}`,
          });
          expect(headers.get('sentry-trace')).toBe(
            `${TRACE}-${context.spanId}-${context.traceFlags & 1}`,
          );
          expect(headers.get('traceparent')).toBe(
            `00-${TRACE}-${context.spanId}-${context.traceFlags & 1 ? '01' : '00'}`,
          );
          expect(headers.get('authorization')).toBe('Bearer test-secret');
          expect(headers.has('baggage')).toBe(false);
          expect(headers.has('tracestate')).toBe(false);
        }),
    );
  });

  it('does not invent trace headers outside an active span', () => {
    const headers = internalTraceHeaders({
      'Content-Type': 'application/json',
      'sentry-trace': 'old',
    });
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.has('sentry-trace')).toBe(false);
    expect(headers.has('traceparent')).toBe(false);
    expect(currentSentryTraceContext()).toEqual({});
  });

  it('rejects SDK propagation fallback even when a client and scope trace exist', () => {
    const client = new Sentry.CloudflareClient({
      dsn: 'https://public@example.test/1',
      integrations: [],
      stackParser: () => [],
      tracesSampleRate: 1,
      transport: () => ({ send: async () => ({ statusCode: 200 }), flush: async () => true }),
    });
    client.init();
    Sentry.withScope((scope) => {
      scope.setClient(client);
      scope.setPropagationContext({ traceId: TRACE, sampleRand: 0.5 });
      expect(Sentry.getTraceData()['sentry-trace']).toBeTruthy();
      expect(Sentry.getActiveSpan()).toBeUndefined();
      expect(currentSentryTraceContext()).toEqual({});
      expect(internalTraceHeaders().has('sentry-trace')).toBe(false);
    });
  });
});

describe('bounded durable trace metadata', () => {
  it('accepts only nonzero IDs and a sampling bit', () => {
    expect(durableSentryTraceHeader({ 'sentry-trace': `${TRACE}-${PARENT}-1` })).toBe(
      `${TRACE}-${PARENT}-1`,
    );
    for (const header of [
      'private=value',
      `${'0'.repeat(32)}-${PARENT}-1`,
      `${TRACE}-${'0'.repeat(16)}-1`,
      `${TRACE}-${PARENT}-2`,
    ]) {
      expect(durableSentryTraceHeader({ 'sentry-trace': header })).toBeNull();
    }
  });

  it('deduplicates and limits producer links while retaining unsampled IDs', () => {
    const links = sentryTraceLinks(
      [
        `${TRACE}-${PARENT}-0`,
        `${TRACE}-${PARENT}-0`,
        undefined,
        'bad',
        `${TRACE}-3333333333333333-1`,
      ],
      1,
    );
    expect(links).toEqual([
      { context: { traceId: TRACE, spanId: PARENT, traceFlags: 0, isRemote: true } },
    ]);
  });
});
