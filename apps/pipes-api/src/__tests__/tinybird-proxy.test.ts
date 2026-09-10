import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pipesApp } from '../index';
import { hashString } from '../cache';

function env() {
  return {
    TINYBIRD_API_URL: 'https://tinybird.test',
    CONVEX_SITE_URL: 'https://convex.test',
    PIPES_API_SHARED_SECRET: 'pipes-secret',
    PIPES_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
  };
}

function stubAuthorizedFetch(upstream: Response = okPipeResponse()) {
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://convex.test/worker/authorize-pipes-query') {
      return new Response(
        JSON.stringify({
          authorized: true,
          token: 'server-tinybird-token',
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        }),
      );
    }
    return upstream.clone();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('exposes cache hits to browsers without querying Tinybird again', async () => {
    const cachedBody = JSON.stringify({ data: [], statistics: { elapsed: 0.5 } });
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn().mockResolvedValue(new Response(cachedBody)),
      },
    });
    const upstreamFetch = stubAuthorizedFetch();

    const response = await pipesApp.fetch(
      new Request('https://pipes.trace-flow.dev/v0/pipes/traces_list.json?start=100', {
        headers: { Authorization: 'Bearer pipe-token', Origin: 'https://trace-flow.dev' },
      }),
      env(),
      executionCtx(),
    );

    expect(response.headers.get('X-Cache')).toBe('HIT');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Access-Control-Expose-Headers')?.split(',')).toContain('X-Cache');
    expect(await response.text()).toBe(cachedBody);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('forwards only the server-returned Tinybird token upstream', async () => {
    const cache = {
      match: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const upstreamFetch = stubAuthorizedFetch();
    vi.stubGlobal('caches', { default: cache });

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
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(cache.match).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);

    const tokenHash = await hashString('pipe-token');
    expect(testEnv.PIPES_LIMITER.limit).toHaveBeenCalledWith({ key: tokenHash });

    const [upstreamUrl, upstreamInit] = upstreamFetch.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    const forwardedUrl = new URL(upstreamUrl);
    expect(forwardedUrl.origin).toBe('https://tinybird.test');
    expect(forwardedUrl.pathname).toBe('/v0/pipes/traces_list.json');
    expect(forwardedUrl.searchParams.get('start')).toBe('100');
    expect(upstreamInit.headers).toEqual({ Authorization: 'Bearer server-tinybird-token' });
  });

  it('rejects a revoked grant before reading a populated response cache', async () => {
    const cache = {
      match: vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: ['stale'] }))),
      put: vi.fn(),
    };
    vi.stubGlobal('caches', { default: cache });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ authorized: false }))),
    );

    const res = await pipesApp.fetch(
      new Request('https://pipes.trace-flow.dev/v0/pipes/traces_list.json', {
        headers: { Authorization: 'Bearer revoked-grant' },
      }),
      env(),
      executionCtx(),
    );

    expect(res.status).toBe(403);
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('fails closed before cache lookup when Convex authorization is unavailable', async () => {
    const cache = { match: vi.fn(), put: vi.fn() };
    vi.stubGlobal('caches', { default: cache });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('control plane unavailable')));

    const res = await pipesApp.fetch(
      new Request('https://pipes.trace-flow.dev/v0/pipes/traces_list.json', {
        headers: { Authorization: 'Bearer grant' },
      }),
      env(),
      executionCtx(),
    );

    expect(res.status).toBe(503);
    expect(cache.match).not.toHaveBeenCalled();
  });

  it('caps internal cache lifetime to the server authorization expiry', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const cache = {
      match: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('caches', { default: cache });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://convex.test/')) {
        return new Response(
          JSON.stringify({
            authorized: true,
            token: 'short-lived-tinybird-token',
            expiresAt: 1007,
          }),
        );
      }
      return okPipeResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await pipesApp.fetch(
      new Request('https://pipes.trace-flow.dev/v0/pipes/traces_list.json', {
        headers: { Authorization: 'Bearer grant' },
      }),
      env(),
      executionCtx(),
    );

    expect(res.status).toBe(200);
    expect(cache.put).toHaveBeenCalledOnce();
    const cachedResponse = cache.put.mock.calls[0]?.[1] as Response;
    expect(cachedResponse.headers.get('Cache-Control')).toBe('s-maxage=7');
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

  it('passes invalid-token responses through from Tinybird without caching and exposes context', async () => {
    const cache = {
      match: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
    };
    stubAuthorizedFetch(
      new Response('forbidden for 11111111-1111-1111-1111-111111111111 Bearer secret.value', {
        status: 403,
      }),
    );
    vi.stubGlobal('caches', { default: cache });

    const res = await pipesApp.fetch(
      new Request('https://pipes.trace-flow.dev/v0/pipes/traces_list.json', {
        headers: { Authorization: 'Bearer invalid-token' },
      }),
      env(),
      executionCtx(),
    );

    expect(res.status).toBe(403);
    expect(res.headers.get('X-Trace-Flow-Pipe')).toBe('traces_list');
    expect(res.headers.get('X-Upstream-Status')).toBe('403');
    expect(await res.json()).toEqual({
      error: 'Upstream query failed',
      pipe: 'traces_list',
      upstream_status: 403,
      upstream_error: 'forbidden for [redacted-uuid] Bearer [redacted]',
    });
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('maps Tinybird 5xx responses to a 502 without caching', async () => {
    const cache = {
      match: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
    };
    vi.stubGlobal('caches', { default: cache });
    stubAuthorizedFetch(
      new Response('bad gateway', {
        status: 503,
        headers: {
          'x-request-id': 'tb-req-1',
          'x-tb-r': 'release-1',
        },
      }),
    );

    const res = await pipesApp.fetch(
      new Request('https://pipes.trace-flow.dev/v0/pipes/traces_list.json', {
        headers: { Authorization: 'Bearer pipe-token' },
      }),
      env(),
      executionCtx(),
    );

    expect(res.status).toBe(502);
    expect(res.headers.get('X-Tinybird-Request-Id')).toBe('tb-req-1');
    expect(await res.json()).toEqual({
      error: 'Upstream query failed',
      pipe: 'traces_list',
      upstream_status: 503,
      tinybird_request_id: 'tb-req-1',
      tinybird_release: 'release-1',
      upstream_error: 'bad gateway',
    });
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
    const upstreamFetch = stubAuthorizedFetch();
    vi.stubGlobal('caches', { default: cache });

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
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });
});
