import * as Sentry from '@sentry/cloudflare';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceDeliveryEnvelope } from '@trace-flow/types';
import { normalizeTraceRequest } from '@trace-flow/utils/ingress-tracing';
import type { ProxyEnv } from '../../context';
import { app, proxySentryOptions } from '../../index';
import { _clearUsageCache } from '../../usage';
import { API_KEY, makeEnv, otlpBody } from './durableFixtures';

const TRACE_ID = '11111111111111111111111111111111';
const PARENT_ID = '2222222222222222';
const PRIVATE_MESSAGE = 'private-otlp-payload-do-not-record';

function runtimeHandler(events: Sentry.Event[]) {
  const handler = {
    async fetch(request: Request, env: ProxyEnv, ctx: ExecutionContext) {
      return app.fetch(request, env, ctx);
    },
  };
  return Sentry.withSentry<ProxyEnv, unknown, unknown, typeof handler>(
    (bindings) => ({
      ...proxySentryOptions(bindings),
      dsn: 'https://public@example.test/1',
      tracesSampleRate: 1,
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
}

async function invoke(
  env: ProxyEnv,
  events: Sentry.Event[],
  body: BodyInit = JSON.stringify(otlpBody()),
) {
  const worker = runtimeHandler(events);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    normalizeTraceRequest(
      new Request('https://gateway.trace-flow.dev/v1/traces', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Trace-Flow-Api-Key': API_KEY,
          traceparent: `00-${TRACE_ID}-${PARENT_ID}-01`,
        },
        body,
      }),
    ),
    env,
    ctx,
  );
  await response.text();
  await waitOnExecutionContext(ctx);
  return response;
}

describe('OTLP caught errors in the real Sentry runtime', () => {
  beforeEach(() => {
    _clearUsageCache();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        authorized: true,
        expiresAt: Date.now() + 60_000,
        createdAt: 1,
        orgId: 'org-otlp',
      }),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('captures queue publication failure on the durable producer span while keeping acceptance', async () => {
    const fixture = makeEnv();
    fixture.queueSend.mockRejectedValue(
      new Error(PRIVATE_MESSAGE, { cause: new Error(PRIVATE_MESSAGE) }),
    );
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const events: Sentry.Event[] = [];
    const response = await invoke(fixture.env, events);
    expect(response.status).toBe(200);
    const envelope = JSON.parse(fixture.getStoredValue()) as TraceDeliveryEnvelope;
    const producer = envelope.message.sentry_trace_context?.['sentry-trace'];
    expect(producer).toMatch(new RegExp(`^${TRACE_ID}-`));
    const errors = events.filter((event) => event.exception);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.tags?.operation).toBe('otlp.enqueue');
    expect(errors[0]?.contexts?.trace).toMatchObject({
      trace_id: TRACE_ID,
      span_id: producer?.split('-')[1],
    });
    expect(JSON.stringify(events)).not.toContain(PRIVATE_MESSAGE);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(PRIVATE_MESSAGE);
  });

  it('reports failed persistence on the caller trace and returns retryable failure without enqueueing', async () => {
    const fixture = makeEnv({ storageError: new Error(PRIVATE_MESSAGE) });
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const events: Sentry.Event[] = [];
    const response = await invoke(fixture.env, events);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(fixture.queueSend).not.toHaveBeenCalled();
    expect(fixture.getStoredValue()).toBe('');
    const errors = events.filter((event) => event.exception);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.tags?.operation).toBe('otlp.delivery_persist');
    expect(errors[0]?.contexts?.trace?.trace_id).toBe(TRACE_ID);
    expect(JSON.stringify(events)).not.toContain(PRIVATE_MESSAGE);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(PRIVATE_MESSAGE);
  });

  it('captures unexpected body-read failures with a safe message on the caller trace', async () => {
    const fixture = makeEnv();
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const events: Sentry.Event[] = [];
    const body = new ReadableStream({
      start(controller) {
        controller.error(new TypeError(PRIVATE_MESSAGE));
      },
    });
    const response = await invoke(fixture.env, events, body);
    expect(response.status).toBe(500);
    expect(fixture.storagePut).not.toHaveBeenCalled();
    expect(fixture.queueSend).not.toHaveBeenCalled();
    const errors = events.filter((event) => event.exception);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.tags?.operation).toBe('otlp.input');
    expect(errors[0]?.contexts?.trace?.trace_id).toBe(TRACE_ID);
    expect(JSON.stringify(events)).not.toContain(PRIVATE_MESSAGE);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(PRIVATE_MESSAGE);
  });

  it('does not capture expected malformed JSON as an exception', async () => {
    const fixture = makeEnv();
    const events: Sentry.Event[] = [];
    const response = await invoke(fixture.env, events, `${PRIVATE_MESSAGE}{`);
    expect(response.status).toBe(400);
    expect(events.filter((event) => event.exception)).toHaveLength(0);
    expect(fixture.storagePut).not.toHaveBeenCalled();
    expect(fixture.queueSend).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain(PRIVATE_MESSAGE);
    expect(JSON.stringify(events)).not.toContain(API_KEY);
  });
});
