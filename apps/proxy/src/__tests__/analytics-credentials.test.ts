import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { analyticsKeyId } from '@trace-flow/utils';
import worker from '../index';
import type { ProxyEnv } from '../context';

const credential = 'credential-isolation-test';

async function authorizeApiKeyRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.origin !== 'https://convex.test' || url.pathname !== '/worker/authorize-api-key') {
    return null;
  }
  const body: unknown = await request.json();
  if (!body || typeof body !== 'object' || !('key' in body) || typeof body.key !== 'string') {
    return Response.json({ authorized: false, reason: 'invalid' });
  }
  const raw = await env.API_KEYS.get(body.key);
  if (!raw) return Response.json({ authorized: false, reason: 'invalid' });
  const keyData: unknown = JSON.parse(raw);
  if (
    !keyData ||
    typeof keyData !== 'object' ||
    !('expiresAt' in keyData) ||
    typeof keyData.expiresAt !== 'number' ||
    keyData.expiresAt <= Date.now()
  ) {
    return Response.json({ authorized: false, reason: 'expired' });
  }
  return Response.json({
    authorized: true,
    expiresAt: keyData.expiresAt,
    createdAt:
      'createdAt' in keyData && typeof keyData.createdAt === 'number' ? keyData.createdAt : 0,
    orgId: 'orgId' in keyData && typeof keyData.orgId === 'string' ? keyData.orgId : 'org-test',
  });
}

describe('analytics credential boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not accept an analytics identifier as a proxy credential', async () => {
    await env.API_KEYS.put(
      credential,
      JSON.stringify({
        orgId: 'org-credential-replay',
        createdAt: Date.now(),
        expiresAt: Date.now() + 86400000,
      }),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      return (
        (await authorizeApiKeyRequest(request)) ??
        new Response('unexpected upstream request', { status: 500 })
      );
    });
    const context = createExecutionContext();
    const bindings = { ...env, TRACE_DELIVERY_NAMESPACE: 'dev' } as unknown as ProxyEnv;
    const response = await worker.fetch(
      new Request('https://proxy.test/v1/traces', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': await analyticsKeyId(credential),
        },
        body: JSON.stringify({ resourceSpans: [] }),
      }),
      bindings,
      context,
    );
    await waitOnExecutionContext(context);
    expect(response.status).toBe(401);
  });

  it.each(['proxy', 'otlp'])(
    'persists only an analytics identifier for %s requests',
    async (kind) => {
      const orgId = `org-credential-${kind}`;
      await env.API_KEYS.put(
        credential,
        JSON.stringify({
          orgId,
          createdAt: Date.now(),
          expiresAt: Date.now() + 86400000,
        }),
      );
      await env.API_KEYS.put(
        `sub:${orgId}`,
        JSON.stringify({
          tier: 'pro',
          status: 'active',
          monthlyUnits: 100000,
          addonUnits: 0,
        }),
      );
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        const authorization = await authorizeApiKeyRequest(request);
        if (authorization) return authorization;
        expect(request.headers.has('X-Trace-Flow-Api-Key')).toBe(false);
        await request.arrayBuffer();
        return new Response(
          JSON.stringify({
            id: 'completion',
            choices: [{ message: { content: 'hello' } }],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      });
      const send = vi.fn().mockResolvedValue(undefined);
      const put = vi.fn(async (key: string, _value: string) => ({ key }));
      const bindings = {
        ...env,
        REQUEST_QUEUE: { send },
        STORAGE: { put },
        TRACE_DELIVERY_NAMESPACE: 'dev',
      } as unknown as ProxyEnv;
      const context = createExecutionContext();
      const path = kind === 'proxy' ? '/openai/v1/chat/completions' : '/v1/traces';
      const body =
        kind === 'proxy'
          ? { model: 'gpt-4', messages: [] }
          : {
              resourceSpans: [
                {
                  scopeSpans: [
                    {
                      spans: [
                        {
                          traceId: '0123456789abcdef0123456789abcdef',
                          spanId: '0123456789abcdef',
                          name: 'test',
                          startTimeUnixNano: '1000000000',
                          endTimeUnixNano: '2000000000',
                        },
                      ],
                    },
                  ],
                },
              ],
            };
      const response = await worker.fetch(
        new Request(`https://proxy.test${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trace-Flow-Api-Key': credential,
          },
          body: JSON.stringify(body),
        }),
        bindings,
        context,
      );
      await response.text();
      await waitOnExecutionContext(context);

      expect(response.status).toBe(200);
      expect(put).toHaveBeenCalledTimes(1);
      const [deliveryKey, storedValue] = put.mock.calls[0]!;
      expect(deliveryKey).toMatch(/^trace-deliveries\/dev-/);
      const envelope = JSON.parse(storedValue);
      const identifier = await analyticsKeyId(credential);
      expect(envelope.message.apiKey).toBe(identifier);
      expect(JSON.stringify(envelope)).not.toContain(credential);
      if (kind === 'otlp') expect(envelope.message.traces[0].ApiKey).toBe(identifier);

      expect(send).toHaveBeenCalledTimes(1);
      const reference = send.mock.calls[0]![0];
      expect(reference).toMatchObject({ type: 'delivery', key: deliveryKey });
      expect(reference).not.toHaveProperty('apiKey');
      expect(JSON.stringify(reference)).not.toContain(credential);
    },
  );
});
