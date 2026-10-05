import { describe, expect, it, vi } from 'vitest';
import { pipesApp } from '../index';

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

describe('pipes API CORS', () => {
  it('allows browser tracing headers on production pipe preflights', async () => {
    const res = await pipesApp.fetch(
      new Request('https://pipes.trace-flow.dev/v0/pipes/agent_usage_timeseries.json', {
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
  it.each([
    ['preview', 'https://preview.trace-flow.dev', true],
    ['prod', 'https://preview.trace-flow.dev', false],
    ['preview', 'https://untrusted.preview.trace-flow.dev', false],
  ])('checks the %s browser origin %s', async (environment, origin, allowed) => {
    const res = await pipesApp.fetch(
      new Request('https://pipes.preview.trace-flow.dev/v0/pipes/agent_usage_timeseries.json', {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization,baggage,sentry-trace',
        },
      }),
      { SENTRY_ENVIRONMENT: environment },
      executionCtx(),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(allowed ? origin : null);
  });
});
