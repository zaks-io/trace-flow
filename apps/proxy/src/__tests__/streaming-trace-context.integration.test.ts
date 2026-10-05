import * as Sentry from '@sentry/cloudflare';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceDeliveryEnvelope } from '@trace-flow/types';
import { normalizeTraceRequest } from '@trace-flow/utils/ingress-tracing';
import type { ProxyEnv } from '../context';
import { app, proxySentryOptions } from '../index';
import { authorizeApiKeyRequest } from './api-key-authorization.test-support';

const TRACE_A = '11111111111111111111111111111111';
const TRACE_B = '22222222222222222222222222222222';
const PARENT = '3333333333333333';
const bindings = env as unknown as ProxyEnv;

describe('concurrent streaming trace context in workerd', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps an open stream on its original trace when another request constructs a cold DO', async () => {
    const events: Sentry.Event[] = [];
    const previousKeys = new Set(
      (await env.STORAGE.list({ prefix: 'trace-deliveries/' })).objects.map((object) => object.key),
    );
    const keys = [`stream-a-${crypto.randomUUID()}`, `stream-b-${crypto.randomUUID()}`];
    for (const key of keys) {
      const orgId = `org-${crypto.randomUUID()}`;
      await env.API_KEYS.put(key, JSON.stringify({ expiresAt: Date.now() + 60_000, orgId }));
      await env.API_KEYS.put(
        `sub:${orgId}`,
        JSON.stringify({ tier: 'pro', status: 'active', monthlyUnits: 100_000, addonUnits: 0 }),
      );
    }
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const authorization = await authorizeApiKeyRequest(request.clone());
      if (authorization) return authorization;
      const body = await request.json<{ stream?: boolean }>();
      if (body.stream) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              upstream = controller;
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"stream-a","choices":[{"delta":{"content":"Hello"}}]}\n\n',
                ),
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return Response.json({
        model: 'gpt-4o',
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
    const handler = {
      async fetch(request: Request, env: ProxyEnv, ctx: ExecutionContext) {
        return app.fetch(request, env, ctx);
      },
    };
    const worker = Sentry.withSentry<ProxyEnv, unknown, unknown, typeof handler>(
      (env) => ({
        ...proxySentryOptions(env),
        dsn: 'https://public@example.test/1',
        skipOpenTelemetrySetup: true,
        transport: () => ({
          send: async (envelope) => {
            for (const [header, event] of envelope[1]) {
              if (header.type === 'event' || header.type === 'transaction')
                events.push(event as Sentry.Event);
            }
            return { statusCode: 200 };
          },
          flush: async () => true,
        }),
      }),
      handler,
    );
    const request = (key: string, traceId: string, stream: boolean) =>
      normalizeTraceRequest(
        new Request('https://gateway.trace-flow.dev/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Trace-Flow-Api-Key': key,
            authorization: 'Bearer test-provider-key',
            'sentry-trace': `${traceId}-${PARENT}-1`,
          },
          body: JSON.stringify({
            model: 'gpt-4o',
            stream,
            messages: [{ role: 'user', content: 'private-customer-payload' }],
          }),
        }),
      );
    const ctxA = createExecutionContext();
    const responseA = await worker.fetch(request(keys[0]!, TRACE_A, true), bindings, ctxA);
    const bodyA = responseA.text();
    expect(upstream).toBeDefined();
    const ctxB = createExecutionContext();
    const responseB = await worker.fetch(request(keys[1]!, TRACE_B, false), bindings, ctxB);
    expect(responseB.status).toBe(200);
    await responseB.text();
    await waitOnExecutionContext(ctxB);
    upstream!.enqueue(encoder.encode('data: [DONE]\n\n'));
    upstream!.close();
    expect(await bodyA).toContain('[DONE]');
    await waitOnExecutionContext(ctxA);
    const newObjects = (await env.STORAGE.list({ prefix: 'trace-deliveries/' })).objects.filter(
      (object) => !previousKeys.has(object.key),
    );
    expect(newObjects).toHaveLength(2);
    const deliveries = await Promise.all(
      newObjects.map(async (object) =>
        (await env.STORAGE.get(object.key))!.json<TraceDeliveryEnvelope>(),
      ),
    );
    for (const traceId of [TRACE_A, TRACE_B]) {
      const delivery = deliveries.find(
        (delivery) => delivery.message.type !== 'otlp' && delivery.message.traceId === traceId,
      );
      expect(delivery?.message.sentry_trace_context?.['sentry-trace']).toMatch(
        new RegExp(`^${traceId}-`),
      );
    }
    expect(JSON.stringify(events)).not.toContain('private-customer-payload');
    for (const key of keys) expect(JSON.stringify(events)).not.toContain(key);
  });
});
