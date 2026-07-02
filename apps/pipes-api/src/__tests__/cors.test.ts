import { describe, expect, it, vi } from 'vitest';
import { pipesApp } from '../index';

function executionCtx() {
  return {
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
});
