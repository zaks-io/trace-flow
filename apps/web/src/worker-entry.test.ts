import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  nextFetch: vi.fn(),
  sentryFetch: vi.fn(),
  createLogger: vi.fn(),
  flush: vi.fn(),
}));

vi.mock('../.open-next/worker.js', () => ({
  default: { fetch: mocks.nextFetch },
  DOQueueHandler: class {},
  DOShardedTagCache: class {},
  BucketCachePurge: class {},
}));
vi.mock('@sentry/cloudflare', () => ({
  withSentry: (_options: unknown, handler: { fetch: (...args: unknown[]) => unknown }) => ({
    fetch: (...args: unknown[]) => {
      mocks.sentryFetch();
      return handler.fetch(...args);
    },
  }),
}));
vi.mock('@trace-flow/logging', () => ({
  axiomConfigFromEnv: vi.fn(),
  createWorkerLogger: mocks.createLogger,
}));

import { GET, HEAD } from './app/healthz/route';

// The Worker imports generated OpenNext output and is excluded from Next's type check.
const workerEntry = './worker-entry';
const { default: worker } = await import(workerEntry);

const env = { AI: { toMarkdown: vi.fn() } };
const waitUntil = vi.fn();
const ctx = { waitUntil };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.nextFetch.mockResolvedValue(new Response('next'));
  mocks.createLogger.mockReturnValue({ info: vi.fn(), error: vi.fn(), flush: mocks.flush });
  mocks.flush.mockResolvedValue(undefined);
});

describe('Worker health probe', () => {
  it.each(['GET', 'HEAD'])('answers %s before Sentry, Next and logging', async (method) => {
    const response = await worker.fetch(
      new Request('https://trace-flow.dev/healthz?probe=uptime', { method }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.text()).toBe(method === 'HEAD' ? '' : '{"status":"ok"}');
    expect(mocks.sentryFetch).not.toHaveBeenCalled();
    expect(mocks.nextFetch).not.toHaveBeenCalled();
    expect(mocks.createLogger).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/healthz'],
    ['GET', '/healthz/child'],
    ['GET', '/'],
  ])('keeps %s %s on the instrumented application path', async (method, path) => {
    const request = new Request(`https://trace-flow.dev${path}`, { method });
    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(mocks.sentryFetch).toHaveBeenCalledOnce();
    expect(mocks.nextFetch).toHaveBeenCalledWith(request, env, ctx);
    expect(mocks.createLogger).toHaveBeenCalledOnce();
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it.each([
    ['GET', GET],
    ['HEAD', HEAD],
  ] as const)('shares the %s response with next dev', async (method, handler) => {
    const response = handler(new Request('http://localhost/healthz', { method }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(method === 'HEAD' ? '' : '{"status":"ok"}');
  });
});
