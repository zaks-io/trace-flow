import { describe, expect, it, vi } from 'vitest';
import { apiApp } from '../index';

function executionCtx() {
  return {
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
          'Access-Control-Request-Headers': 'authorization,baggage,sentry-trace',
        },
      }),
      { SENTRY_ENVIRONMENT: 'prod' },
      executionCtx(),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://trace-flow.dev');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'Content-Type,Authorization,Baggage,Sentry-Trace',
    );
  });
  it.each([
    ['preview', 'https://preview.trace-flow.dev', true],
    ['prod', 'https://preview.trace-flow.dev', false],
    ['preview', 'https://untrusted.preview.trace-flow.dev', false],
  ])('checks the %s browser origin %s', async (environment, origin, allowed) => {
    const res = await apiApp.fetch(
      new Request('https://raw.preview.trace-flow.dev/bodies/req_123', {
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
