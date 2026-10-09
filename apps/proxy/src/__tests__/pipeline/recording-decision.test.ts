import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../../index';
import { _clearAll } from '../../cache';
import { _clearUsageCache } from '../../usage';
import { API_KEY, makeEnv } from '../../otlp/__tests__/durableFixtures';
import type { ProxyEnv } from '../../context';

const PROVIDER_URL = 'https://api.openai.com/v1/chat/completions';

function stubTransport(upstream: (request: Request) => Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/worker/authorize-api-key') {
        return Response.json({
          authorized: true,
          expiresAt: Date.now() + 60_000,
          createdAt: 1,
          orgId: 'org-otlp',
        });
      }
      if (request.url !== PROVIDER_URL) throw new Error(`unexpected fetch: ${request.url}`);
      return upstream(request);
    }),
  );
}

function proxyChat(env: ProxyEnv, ctx: ExecutionContext) {
  return app.request(
    '/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer provider-key',
        'X-Trace-Flow-Api-Key': API_KEY,
      },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
    },
    env,
    ctx,
  );
}

describe('proxy recording decision', () => {
  beforeEach(async () => {
    await _clearAll();
    _clearUsageCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('forwards to the provider while the usage check is still in flight', async () => {
    let allowUsage!: () => void;
    const { env, usageFetch, storagePut } = makeEnv({
      usageResponse: () =>
        new Promise((resolve) => {
          allowUsage = () => resolve(Response.json({ allowed: true }));
        }),
    });
    const upstream = vi.fn(async () => Response.json({ id: 'chatcmpl-1', choices: [] }));
    stubTransport(upstream);
    const ctx = createExecutionContext();

    const pending = proxyChat(env, ctx);
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
    expect(usageFetch).toHaveBeenCalledTimes(1);
    allowUsage();
    const response = await pending;

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Trace-Flow-Recording')).toBe('true');
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(storagePut).toHaveBeenCalledTimes(1);
  });

  it('still serves the request, unrecorded, when the recording policy fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, storagePut } = makeEnv();
    vi.mocked(env.API_KEYS.get).mockRejectedValue(new Error('KV unavailable'));
    stubTransport(async () => Response.json({ id: 'chatcmpl-2', choices: [] }));
    const ctx = createExecutionContext();

    const response = await proxyChat(env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Trace-Flow-Recording')).toBe('false');
    expect(response.headers.get('X-Trace-Flow-Recording-Reason')).toBe('internal_error');
    expect(await response.json()).toEqual({ id: 'chatcmpl-2', choices: [] });
    await waitOnExecutionContext(ctx);
    expect(storagePut).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join('\n')).toContain('proxy.tracing_disabled');
  });
});
