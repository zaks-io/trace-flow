import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { analyticsKeyId } from '@trace-flow/utils';
import worker from '../index';
import type { ProxyEnv } from '../context';

const credential = 'credential-isolation-test';

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
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request('https://proxy.test/v1/traces', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': await analyticsKeyId(credential),
        },
        body: JSON.stringify({ resourceSpans: [] }),
      }),
      env,
      context,
    );
    await waitOnExecutionContext(context);
    expect(response.status).toBe(401);
  });

  it.each(['proxy', 'otlp'])('only enqueues an identifier for %s requests', async (kind) => {
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
    const bindings = { ...env, REQUEST_QUEUE: { send } } as unknown as ProxyEnv;
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
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0]![0];
    expect(message.apiKey).toBe(await analyticsKeyId(credential));
    expect(JSON.stringify(message)).not.toContain(credential);
    if (kind === 'otlp') expect(message.traces[0].ApiKey).toBe(message.apiKey);
  });
});
