import * as Sentry from '@sentry/cloudflare';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  continueQueueTrace,
  TRACE_FLOW_PROPAGATION_TARGETS,
} from '@trace-flow/utils/sentry-tracing';

const TRACE_A = '11111111111111111111111111111111';
const TRACE_B = '22222222222222222222222222222222';
const PARENT = '3333333333333333';

function runtimeHandler(callback: (request: Request) => Promise<Response>, events: Sentry.Event[]) {
  return Sentry.withSentry(
    () => ({
      dsn: 'https://public@example.test/1',
      tracesSampleRate: 1,
      skipOpenTelemetrySetup: true,
      tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
      transport: () => ({
        send: async (envelope) => {
          for (const [header, payload] of envelope[1]) {
            if (header.type === 'event' || header.type === 'transaction') {
              events.push(payload as Sentry.Event);
            }
          }
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    }),
    { fetch: (request: Request, _env: object, _ctx: ExecutionContext) => callback(request) },
  );
}

describe('pinned Sentry SDK in workerd', () => {
  it('continues Sentry ingress, while W3C-only ingress starts an independent SDK trace', async () => {
    const events: Sentry.Event[] = [];
    const worker = runtimeHandler(
      async () => Response.json(Sentry.getActiveSpan()?.spanContext()),
      events,
    );
    for (const [headers, expected] of [
      [{ 'sentry-trace': `${TRACE_A}-${PARENT}-1` }, TRACE_A],
      [{ traceparent: `00-${TRACE_B}-${PARENT}-01` }, undefined],
    ] as const) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request('https://gateway.trace-flow.dev/test', { headers }),
        {},
        ctx,
      );
      const context = await response.json<{ traceId: string }>();
      if (expected) expect(context.traceId).toBe(expected);
      else expect(context.traceId).not.toBe(TRACE_B);
      await waitOnExecutionContext(ctx);
    }
    expect(events.filter((event) => event.type === 'transaction')).toHaveLength(2);
  });

  it('isolates concurrent producer continuations and attaches errors to their processing span', async () => {
    const events: Sentry.Event[] = [];
    const contexts: { traceId: string; spanId: string }[] = [];
    const worker = runtimeHandler(async () => {
      await Promise.all(
        [TRACE_A, TRACE_B].map((traceId) =>
          continueQueueTrace(
            { 'sentry-trace': `${traceId}-${PARENT}-1` },
            { queueName: 'audit', messageCount: 1 },
            async () => {
              await Promise.resolve();
              const span = Sentry.getActiveSpan()!;
              contexts.push(span.spanContext());
              Sentry.captureException(new Error(`audit-${traceId}`));
            },
          ),
        ),
      );
      return new Response('ok');
    }, events);
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('https://gateway.trace-flow.dev/test'),
      {},
      ctx,
    );
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(contexts.map((context) => context.traceId).sort()).toEqual([TRACE_A, TRACE_B]);
    const errors = events.filter((event) => event.exception);
    expect(errors).toHaveLength(2);
    for (const context of contexts) {
      expect(
        errors.find((event) => event.contexts?.trace?.trace_id === context.traceId)?.contexts?.trace
          ?.span_id,
      ).toBe(context.spanId);
    }
    const transactions = events.filter((event) => event.type === 'transaction');
    for (const traceId of [TRACE_A, TRACE_B]) {
      expect(
        transactions.find((event) => event.contexts?.trace?.trace_id === traceId)?.contexts?.trace
          ?.parent_span_id,
      ).toBe(PARENT);
    }
  });
});
