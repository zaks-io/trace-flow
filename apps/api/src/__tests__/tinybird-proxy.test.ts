import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { JWTPayload } from 'jose';
import type { Logger } from '@trace-flow/logging';
import { tinybirdProxy } from '../tinybird-proxy';
import { hashString } from '../cache';
import type { TinybirdJWTPayload } from '../tinybird-jwt';

vi.mock('jose', () => ({
  jwtVerify: vi.fn(),
}));

import { jwtVerify } from 'jose';

const noopLogger: Logger = {
  child: () => noopLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: () => Promise.resolve(),
};

function createApp() {
  const app = new Hono<{ Variables: { logger: Logger } }>();
  app.use('*', async (c, next) => {
    c.set('logger', noopLogger);
    await next();
  });
  app.route('/', tinybirdProxy as never);
  return app;
}

function env() {
  return {
    TINYBIRD_API_URL: 'https://tinybird.test',
    TINYBIRD_ADMIN_TOKEN: 'admin-token',
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

function mockVerifiedPayload(payload: TinybirdJWTPayload) {
  vi.mocked(jwtVerify).mockResolvedValue({
    payload: payload as unknown as JWTPayload,
    protectedHeader: { alg: 'HS256' },
    key: {} as never,
  });
}

function webPayload(scopes: TinybirdJWTPayload['scopes']): TinybirdJWTPayload {
  return {
    workspace_id: 'ws_123',
    name: 'web_read_jwt',
    scopes,
  };
}

describe('tinybirdProxy pipe authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads and caches a requested pipe when the JWT includes the pipe scope', async () => {
    const cache = {
      match: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const upstreamFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ ok: true }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('caches', { default: cache });
    vi.stubGlobal('fetch', upstreamFetch);

    const testEnv = env();
    mockVerifiedPayload(
      webPayload([
        {
          type: 'PIPES:READ',
          resource: 'traces_list',
          fixed_params: { api_keys: 'key1,key2', org_id: 'org_123', retention_days: 30 },
        },
      ]),
    );

    const res = await createApp().fetch(
      new Request('https://api.test/v0/pipes/traces_list.json?start=100', {
        headers: { Authorization: 'Bearer token' },
      }),
      testEnv,
      executionCtx(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Cache')).toBe('MISS');
    expect(cache.match).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).toHaveBeenCalledWith(
      'https://tinybird.test/v0/pipes/traces_list.json?start=100',
      {
        headers: { Authorization: 'Bearer token' },
      },
    );
  });

  it('rejects a requested pipe missing from the JWT before cache lookup or Tinybird fetch', async () => {
    const cache = {
      match: vi.fn(),
      put: vi.fn(),
    };
    const upstreamFetch = vi.fn();
    vi.stubGlobal('caches', { default: cache });
    vi.stubGlobal('fetch', upstreamFetch);

    const testEnv = env();
    mockVerifiedPayload(
      webPayload([
        {
          type: 'PIPES:READ',
          resource: 'traces_list',
          fixed_params: { api_keys: 'key1,key2', org_id: 'org_123', retention_days: 30 },
        },
      ]),
    );

    const res = await createApp().fetch(
      new Request('https://api.test/v0/pipes/agent_usage_summary.json', {
        headers: { Authorization: 'Bearer token' },
      }),
      testEnv,
      executionCtx(),
    );

    expect(res.status).toBe(401);
    expect(testEnv.PIPES_LIMITER.limit).not.toHaveBeenCalled();
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('uses org_id in rate-limit and cache identity for multi-scope tokens', async () => {
    const cache = {
      match: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('caches', { default: cache });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );

    const testEnv = env();
    mockVerifiedPayload(
      webPayload([
        {
          type: 'PIPES:READ',
          resource: 'traces_list',
          fixed_params: { api_keys: '', org_id: 'org_123', retention_days: 30 },
        },
        {
          type: 'PIPES:READ',
          resource: 'agent_usage_summary',
          fixed_params: { api_keys: '', org_id: 'org_123', retention_days: 30 },
        },
      ]),
    );

    const res = await createApp().fetch(
      new Request('https://api.test/v0/pipes/agent_usage_summary.json', {
        headers: { Authorization: 'Bearer token' },
      }),
      testEnv,
      executionCtx(),
    );

    const accessHash = await hashString('\0org_123');

    expect(res.status).toBe(200);
    expect(testEnv.PIPES_LIMITER.limit).toHaveBeenCalledWith({ key: accessHash });
    expect((cache.match.mock.calls[0][0] as Request).url).toContain(accessHash);
  });

  it('rejects mismatched fixed params across PIPES:READ scopes before cache lookup', async () => {
    const cache = {
      match: vi.fn(),
      put: vi.fn(),
    };
    const upstreamFetch = vi.fn();
    vi.stubGlobal('caches', { default: cache });
    vi.stubGlobal('fetch', upstreamFetch);

    const testEnv = env();
    mockVerifiedPayload(
      webPayload([
        {
          type: 'PIPES:READ',
          resource: 'traces_list',
          fixed_params: { api_keys: 'key1,key2', org_id: 'org_123', retention_days: 30 },
        },
        {
          type: 'PIPES:READ',
          resource: 'agent_usage_summary',
          fixed_params: { api_keys: 'key1,key2', org_id: 'org_456', retention_days: 30 },
        },
      ]),
    );

    const res = await createApp().fetch(
      new Request('https://api.test/v0/pipes/traces_list.json', {
        headers: { Authorization: 'Bearer token' },
      }),
      testEnv,
      executionCtx(),
    );

    expect(res.status).toBe(401);
    expect(testEnv.PIPES_LIMITER.limit).not.toHaveBeenCalled();
    expect(cache.match).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});
