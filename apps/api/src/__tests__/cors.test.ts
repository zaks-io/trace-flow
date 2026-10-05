import { describe, expect, it, vi } from 'vitest';
import { apiApp } from '../index';

function executionCtx() {
  return {
    tracing: {
      enterSpan: <T>(_name: string, callback: (span: Span) => T) =>
        callback({ isTraced: false, setAttribute: vi.fn(), end: vi.fn() }),
    },
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

describe('api CORS', () => {
  it('allows browser tracing headers on production body preflights', async () => {
    const res = await apiApp.fetch(
      new Request('https://raw.trace-flow.dev/bodies/req_123', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://trace-flow.dev',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers':
            'authorization,baggage,sentry-trace,traceparent,tracestate',
        },
      }),
      { SENTRY_ENVIRONMENT: 'prod' },
      executionCtx(),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://trace-flow.dev');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'Content-Type,Authorization,Baggage,Sentry-Trace,Traceparent,Tracestate',
    );
  });
});
