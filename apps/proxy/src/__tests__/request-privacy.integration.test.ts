import * as Sentry from '@sentry/cloudflare';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeTraceRequest } from '@trace-flow/utils/ingress-tracing';
import type { ProxyEnv } from '../context';
import { app, proxySentryOptions } from '../index';
import { authorizeApiKeyRequest } from './api-key-authorization.test-support';

const TRACE_ID = '11111111111111111111111111111111';
const PARENT_ID = '2222222222222222';
const QUERY_CANARY = 'private-query-canary';
const FRAGMENT_CANARY = 'private-fragment-canary';
const BAGGAGE_CANARY = 'private-baggage-canary';
const HEADER_CANARY = 'private-header-canary';

describe('production Proxy Sentry request privacy in workerd', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps correlation while removing private URLs and headers from every exported envelope', async () => {
    const envelopes: string[] = [];
    const samplingContexts: unknown[] = [];
    const itemTypes: string[] = [];
    const events: Sentry.Event[] = [];
    const key = `privacy-${crypto.randomUUID()}`;
    const orgId = `org-${crypto.randomUUID()}`;
    await env.API_KEYS.put(key, JSON.stringify({ expiresAt: Date.now() + 60_000, orgId }));
    await env.API_KEYS.put(
      `sub:${orgId}`,
      JSON.stringify({ tier: 'pro', status: 'active', monthlyUnits: 100_000, addonUnits: 0 }),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const authorization = await authorizeApiKeyRequest(request.clone());
      if (authorization) return authorization;
      await request.arrayBuffer();
      return Response.json({
        model: 'gpt-4o',
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
    const handler = {
      async fetch(request: Request, bindings: ProxyEnv, ctx: ExecutionContext) {
        const response = await app.fetch(request, bindings, ctx);
        Sentry.addBreadcrumb({ category: 'fetch', data: { url: request.url } });
        Sentry.captureException(new Error('privacy export probe'));
        return response;
      },
    };
    const worker = Sentry.withSentry<ProxyEnv, unknown, unknown, typeof handler>(
      (bindings) => ({
        ...proxySentryOptions(bindings),
        dsn: 'https://public@example.test/1',
        skipOpenTelemetrySetup: true,
        transport: () => ({
          send: async (envelope) => {
            envelopes.push(JSON.stringify(envelope));
            samplingContexts.push(envelope[0].trace);
            for (const [header, event] of envelope[1]) {
              itemTypes.push(header.type);
              if (header.type === 'event' || header.type === 'transaction') {
                events.push(event as Sentry.Event);
              }
            }
            return { statusCode: 200 };
          },
          flush: async () => true,
        }),
      }),
      handler,
    );
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      normalizeTraceRequest(
        new Request(
          `https://gateway.trace-flow.dev/openai/v1/chat/completions?key=${QUERY_CANARY}#${FRAGMENT_CANARY}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'X-Trace-Flow-Api-Key': key,
              authorization: 'Bearer fixture-provider-key',
              'sentry-trace': `${TRACE_ID}-${PARENT_ID}-1`,
              baggage: `customer=${BAGGAGE_CANARY},sentry-custom=${BAGGAGE_CANARY},sentry-public_key=${BAGGAGE_CANARY}`,
              'x-organization': HEADER_CANARY,
            },
            body: JSON.stringify({
              model: 'gpt-4o',
              messages: [{ role: 'user', content: 'Hello' }],
            }),
          },
        ),
      ),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(envelopes.length).toBeGreaterThan(0);
    for (const context of samplingContexts) {
      expect(context).toMatchObject({ trace_id: TRACE_ID, public_key: 'public' });
    }
    expect(events.some((event) => event.exception)).toBe(true);
    expect(events.some((event) => event.type === 'transaction')).toBe(true);
    expect(itemTypes).not.toContain('span');
    for (const event of events) expect(event.contexts?.trace?.trace_id).toBe(TRACE_ID);
    expect(
      events.some((event) => event.breadcrumbs?.some((item) => item.category === 'fetch')),
    ).toBe(true);
    const exported = envelopes.join('\n');
    for (const canary of [QUERY_CANARY, FRAGMENT_CANARY, BAGGAGE_CANARY, HEADER_CANARY, key]) {
      expect(exported).not.toContain(canary);
    }
  });
});
