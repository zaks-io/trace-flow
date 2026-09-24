import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import { validateRequest } from '../../pipeline/validateRequest';
import type { ProxyEnv } from '../../context';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validateRequest', () => {
  it('sheds rate-limited IPs before authorizing the key', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const headers: Record<string, string> = {
      'x-trace-flow-api-key': 'tf_flood',
      'cf-connecting-ip': '203.0.113.9',
    };
    const context = {
      req: {
        raw: new Request('http://localhost/openai/v1/chat/completions', {
          method: 'POST',
          headers,
        }),
        path: '/openai/v1/chat/completions',
        header: (name: string) => headers[name.toLowerCase()],
      },
      env: {
        IP_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) },
        CONVEX_SITE_URL: 'https://convex.test',
        USAGE_SYNC_SECRET: 'worker-secret',
      },
      executionCtx: { waitUntil: vi.fn() },
      json: (data: unknown, status: number, extra?: Record<string, string>) =>
        Response.json(data, { status, headers: extra }),
    } as unknown as Context<{ Bindings: ProxyEnv }>;

    const result = await validateRequest(context);

    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') expect(result.response.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
