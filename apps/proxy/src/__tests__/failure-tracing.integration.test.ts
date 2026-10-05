import * as Sentry from '@sentry/cloudflare';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeTraceRequest } from '@trace-flow/utils/ingress-tracing';
import type { TraceDeliveryEnvelope } from '@trace-flow/types';
import type { ProxyEnv } from '../context';
import { app, proxySentryOptions } from '../index';
import { createProxyFailureReporter } from '../transaction';
import { authorizeApiKeyRequest } from './api-key-authorization.test-support';
import { otlpBody } from '../otlp/__tests__/durableFixtures';

const TRACE_ID = '11111111111111111111111111111111';
const PARENT_ID = '2222222222222222';
const PRIVATE_MESSAGE = 'private-provider-payload-do-not-record';
const runtimeBindings = env as unknown as ProxyEnv;

function tracedHandler(
  fetch: (request: Request, bindings: ProxyEnv, ctx: ExecutionContext) => Promise<Response>,
  events: Sentry.Event[],
) {
  const handler = { fetch };
  const instrumented = Sentry.withSentry<ProxyEnv, unknown, unknown, typeof handler>(
    (bindings) => ({
      ...proxySentryOptions(bindings),
      dsn: 'https://public@example.test/1',
      tracesSampleRate: 1,
      skipOpenTelemetrySetup: true,
      transport: () => ({
        send: async (envelope) => {
          for (const [header, event] of envelope[1]) {
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
  return {
    fetch: (request: Request, bindings: ProxyEnv, ctx: ExecutionContext) =>
      instrumented.fetch(normalizeTraceRequest(request), bindings, ctx),
  };
}

describe('Proxy failure trace correlation in workerd', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports each failure once on its active span without exposing the original exception', async () => {
    const events: Sentry.Event[] = [];
    const worker = tracedHandler(async () => {
      const report = createProxyFailureReporter();
      const failure = new TypeError(PRIVATE_MESSAGE, { cause: new Error(PRIVATE_MESSAGE) });
      report(failure, 'capture');
      report(failure, 'response_stream');
      report(new DOMException(PRIVATE_MESSAGE, 'AbortError'), 'response_stream');
      report(new DOMException(PRIVATE_MESSAGE, 'AbortError'), 'stream_cleanup');
      return Response.json(Sentry.getActiveSpan()?.spanContext());
    }, events);
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('https://gateway.trace-flow.dev/test', {
        headers: { 'sentry-trace': `${TRACE_ID}-${PARENT_ID}-1` },
      }),
      runtimeBindings,
      ctx,
    );
    const span = await response.json<{ spanId: string }>();
    await waitOnExecutionContext(ctx);
    const errors = events.filter((event) => event.exception);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.contexts?.trace).toMatchObject({ trace_id: TRACE_ID, span_id: span.spanId });
    expect(errors[0]?.tags).toMatchObject({
      'proxy.operation': 'capture',
      'proxy.failure_category': 'type_error',
    });
    expect(JSON.stringify(events)).not.toContain(PRIVATE_MESSAGE);
  });

  it.each(['none', 'sentry', 'sentry-unspecified', 'w3c'] as const)(
    'keeps %s trace context in upstream errors and the durable envelope',
    async (format) => {
      const events: Sentry.Event[] = [];
      const existingKeys = new Set(
        (await env.STORAGE.list({ prefix: 'trace-deliveries/' })).objects.map(
          (object) => object.key,
        ),
      );
      const key = `failure-trace-${crypto.randomUUID()}`;
      const orgId = `org-${crypto.randomUUID()}`;
      await env.API_KEYS.put(key, JSON.stringify({ expiresAt: Date.now() + 60_000, orgId }));
      await env.API_KEYS.put(
        `sub:${orgId}`,
        JSON.stringify({
          tier: 'pro',
          status: 'active',
          monthlyUnits: 100_000,
          addonUnits: 0,
        }),
      );
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        const authorized = await authorizeApiKeyRequest(request.clone());
        if (authorized) return authorized;
        await request.arrayBuffer();
        throw new TypeError(PRIVATE_MESSAGE);
      });
      const worker = tracedHandler(
        async (request, bindings, ctx) => app.fetch(request, bindings, ctx),
        events,
      );
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request('https://gateway.trace-flow.dev/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Trace-Flow-Api-Key': key,
            authorization: 'Bearer test-provider-key',
            ...(format === 'sentry'
              ? { 'sentry-trace': `${TRACE_ID}-${PARENT_ID}-1` }
              : format === 'sentry-unspecified'
                ? { 'sentry-trace': `${TRACE_ID}-${PARENT_ID}` }
                : format === 'w3c'
                  ? { traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` }
                  : {}),
          },
          body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] }),
        }),
        runtimeBindings,
        ctx,
      );
      expect(response.status).toBe(502);
      await response.text();
      const stored = await env.STORAGE.list({ prefix: 'trace-deliveries/' });
      const newObjects = stored.objects.filter((object) => !existingKeys.has(object.key));
      expect(newObjects).toHaveLength(1);
      const envelope = await (await env.STORAGE.get(
        newObjects[0]!.key,
      ))!.json<TraceDeliveryEnvelope>();
      if (envelope.message.type === 'otlp') throw new Error('Expected an LLM delivery');
      const internalHeader = envelope.message.sentry_trace_context?.['sentry-trace'];
      const continuedTraceId = internalHeader?.split('-')[0];
      expect(continuedTraceId).toMatch(/^[a-f0-9]{32}$/);
      if (format !== 'none') expect(continuedTraceId).toBe(TRACE_ID);
      expect(envelope.message.traceId).toBe(continuedTraceId);
      expect(envelope.message.traceFlags).toBeDefined();
      expect(envelope.message.traceFlags! & 1).toBe(Number(internalHeader?.split('-')[2]));
      expect(envelope.message.parentSpanId).toBe(format === 'w3c' ? PARENT_ID : undefined);
      await waitOnExecutionContext(ctx);
      const errors = events.filter((event) => event.exception);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.contexts?.trace?.trace_id).toBe(continuedTraceId);
      expect(errors[0]?.contexts?.trace?.span_id).toBe(
        envelope.message.sentry_trace_context?.['sentry-trace']?.split('-')[1],
      );
      expect(errors[0]?.tags?.['proxy.operation']).toBe('upstream_fetch');
      expect(JSON.stringify(events)).not.toContain(PRIVATE_MESSAGE);
    },
  );

  it('captures unexpected errors swallowed by Hono without exposing their messages', async () => {
    const events: Sentry.Event[] = [];
    const worker = tracedHandler(
      async (request, bindings, ctx) => app.fetch(request, bindings, ctx),
      events,
    );
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('https://gateway.trace-flow.dev/openai/v1/chat/completions', {
        headers: { 'sentry-trace': `${TRACE_ID}-${PARENT_ID}-1` },
      }),
      {
        ...runtimeBindings,
        IP_LIMITER: {
          limit: async () => {
            throw new Error(PRIVATE_MESSAGE);
          },
        },
      },
      ctx,
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal Server Error');
    await waitOnExecutionContext(ctx);
    const errors = events.filter((event) => event.exception);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.contexts?.trace?.trace_id).toBe(TRACE_ID);
    expect(errors[0]?.tags?.['proxy.operation']).toBe('handler');
    expect(JSON.stringify(events)).not.toContain(PRIVATE_MESSAGE);
  });

  it('preserves OTLP producer context across a cold UsageTracker before durable acceptance', async () => {
    const events: Sentry.Event[] = [];
    const key = `otlp-trace-${crypto.randomUUID()}`;
    const orgId = `org-${crypto.randomUUID()}`;
    const existingKeys = new Set(
      (await env.STORAGE.list({ prefix: 'trace-deliveries/' })).objects.map((object) => object.key),
    );
    await env.API_KEYS.put(key, JSON.stringify({ expiresAt: Date.now() + 60_000, orgId }));
    await env.API_KEYS.put(
      `sub:${orgId}`,
      JSON.stringify({
        tier: 'pro',
        status: 'active',
        monthlyUnits: 100_000,
        addonUnits: 0,
      }),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const authorized = await authorizeApiKeyRequest(request.clone());
      if (authorized) return authorized;
      throw new Error('Unexpected external request');
    });
    const worker = tracedHandler(
      async (request, bindings, ctx) => app.fetch(request, bindings, ctx),
      events,
    );
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('https://gateway.trace-flow.dev/v1/traces', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Trace-Flow-Api-Key': key,
          traceparent: `00-${TRACE_ID}-${PARENT_ID}-01`,
        },
        body: JSON.stringify(otlpBody()),
      }),
      runtimeBindings,
      ctx,
    );
    expect(response.status).toBe(200);
    await response.text();
    const newObjects = (await env.STORAGE.list({ prefix: 'trace-deliveries/' })).objects.filter(
      (object) => !existingKeys.has(object.key),
    );
    expect(newObjects).toHaveLength(1);
    const envelope = await (await env.STORAGE.get(
      newObjects[0]!.key,
    ))!.json<TraceDeliveryEnvelope>();
    expect(envelope.message.type).toBe('otlp');
    expect(envelope.message.sentry_trace_context?.['sentry-trace']).toMatch(
      new RegExp(`^${TRACE_ID}-`),
    );
    await waitOnExecutionContext(ctx);
    expect(
      events.some(
        (event) => event.type === 'transaction' && event.contexts?.trace?.trace_id === TRACE_ID,
      ),
    ).toBe(true);
  });
});
