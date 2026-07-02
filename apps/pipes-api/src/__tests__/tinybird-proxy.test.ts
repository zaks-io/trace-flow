import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pipesApp } from '../index';
import { hashString } from '../cache';

function env() {
  return {
    TINYBIRD_API_URL: 'https://tinybird.test',
    PIPES_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
  };
}

function executionCtx() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

function okPipeResponse(body: unknown = { data: [{ ok: true }] }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('pipes API Tinybird passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards caller bearer tokens to Tinybird without admin-token credentials', async () => {
    const cache = {
      match: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const upstreamFetch = vi.fn().mockResolvedValue(okPipeResponse());
    vi.stubGlobal('caches', { default: cache });
    vi.stubGlobal('fetch', upstreamFetch);

    const testEnv = env();
    const res = await pipesApp.fetch(
      new Request('https://pipes.trace-flow.dev/v0/pipes/traces_list.json?start=100', {
        headers: { Authorization: 'Bearer pipe-token' },
      }),
      testEnv,
      executionCtx(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Cache')).toBe('MISS');
    expect(res.headers.get('Vary')).toContain('Authorization');
    expect(cache.match).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);

    const tokenHash = await hashString('pipe-token');
    expect(testEnv.PIPES_LIMITER.limit).toHaveBeenCalledWith({ key: tokenHash });

    const [upstreamUrl, upstreamInit] = upstreamFetch.mock.calls[0] as [string, RequestInit];
    const forwardedUrl = new URL(upstreamUrl);
    expect(forwardedUrl.origin).toBe('https://tinybird.test');
    expect(forwardedUrl.pathname).toBe('/v0/pipes/traces_list.json');
    expect(forwardedUrl.searchParams.get('start')).toBe('100');
    expect(upstreamInit.headers).toEqual({ Authorization: 'Bearer pipe-token' });
  });

  it('rejects missing bearer tokens before rate limiting or Tinybird fetch', async () => {
    const cache = {
      match: vi.fn(),
      put: vi.fn(),
    };
    const upstreamFetch = vi.fn();
    vi.stubGlobal('caches', { default: cache });
    vi.stubGlobal('fetch', upstreamFetch);

    const testEnv = env();
    const res = await pipesApp.fetch(
      new Request('https://pipes.trace-flow.dev/v0/pipes/traces_list.json'),
      testEnv,
      executionCtx(),
    );

    expect(res.status).toBe(401);
    expect(testEnv.PIPES_LIMITER.limit).not.toHaveBeenCalled();
    expect(cache.match).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('passes invalid-token responses through from Tinybird without caching', async () => {
    const cache = {
      match: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
    };
    const upstreamFetch = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));
    vi.stubGlobal('caches', { default: cache });
    vi.stubGlobal('fetch', upstreamFetch);

    const res = await pipesApp.fetch(
      new Request('https://pipes.trace-flow.dev/v0/pipes/traces_list.json', {
        headers: { Authorization: 'Bearer invalid-token' },
      }),
      env(),
      executionCtx(),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Upstream query failed' });
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('maps Tinybird 5xx responses to a 502 without caching', async () => {
    const cache = {
      match: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
    };
    vi.stubGlobal('caches', { default: cache });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad gateway', { status: 503 })));

    const res = await pipesApp.fetch(
      new Request('https://pipes.trace-flow.dev/v0/pipes/traces_list.json', {
        headers: { Authorization: 'Bearer pipe-token' },
      }),
      env(),
      executionCtx(),
    );

    expect(res.status).toBe(502);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('rate-limits by token hash before querying Tinybird', async () => {
    const cache = {
      match: vi.fn(),
      put: vi.fn(),
    };
    const upstreamFetch = vi.fn();
    vi.stubGlobal('caches', { default: cache });
    vi.stubGlobal('fetch', upstreamFetch);

    const testEnv = env();
    testEnv.PIPES_LIMITER.limit.mockResolvedValue({ success: false });

    const res = await pipesApp.fetch(
      new Request('https://pipes.trace-flow.dev/v0/pipes/traces_list.json', {
        headers: { Authorization: 'Bearer pipe-token' },
      }),
      testEnv,
      executionCtx(),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(cache.match).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('bypasses cache for live polling queries', async () => {
    const cache = {
      match: vi.fn(),
      put: vi.fn(),
    };
    const upstreamFetch = vi.fn().mockResolvedValue(okPipeResponse());
    vi.stubGlobal('caches', { default: cache });
    vi.stubGlobal('fetch', upstreamFetch);

    const res = await pipesApp.fetch(
      new Request('https://pipes.trace-flow.dev/v0/pipes/traces_list.json?after_received_at=123', {
        headers: { Authorization: 'Bearer pipe-token' },
      }),
      env(),
      executionCtx(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Cache')).toBe('BYPASS');
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });
});
