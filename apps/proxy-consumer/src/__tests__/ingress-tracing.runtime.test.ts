import * as Sentry from '@sentry/cloudflare';
import { normalizeTraceRequest } from '@trace-flow/utils/ingress-tracing';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const TRACE_A = '1'.repeat(32);
const TRACE_B = '2'.repeat(32);
const PARENT = '3'.repeat(16);

describe('trace ingress before the pinned SDK request wrapper', () => {
  it.each(['0', '1'])(
    'preserves W3C IDs, parent, sampling %s and caught error identity',
    async (sampled) => {
      const events: Sentry.Event[] = [];
      const worker = Sentry.withSentry(
        () => ({
          dsn: 'https://public@example.test/1',
          tracesSampleRate: 1,
          skipOpenTelemetrySetup: true,
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
        {
          async fetch(request: Request, _env: object, _ctx: ExecutionContext) {
            Sentry.captureException(new Error('ingress failed'));
            return Response.json({
              context: Sentry.getActiveSpan()!.spanContext(),
              body: await request.text(),
            });
          },
        },
      );
      const ctx = createExecutionContext();
      const incoming = new Request('https://gateway.trace-flow.dev/test', {
        method: 'POST',
        headers: { traceparent: `00-${TRACE_A}-${PARENT}-0${sampled}` },
        body: 'request content',
      });
      const response = await worker.fetch(normalizeTraceRequest(incoming), {}, ctx);
      const result = await response.json<{
        context: { traceId: string; spanId: string; traceFlags: number };
        body: string;
      }>();
      await waitOnExecutionContext(ctx);
      expect(result.context.traceId).toBe(TRACE_A);
      expect(result.context.traceFlags & 1).toBe(Number(sampled));
      expect(result.body).toBe('request content');
      expect(events.find((event) => event.exception)?.contexts?.trace).toMatchObject({
        trace_id: TRACE_A,
        span_id: result.context.spanId,
        parent_span_id: PARENT,
      });
      const transactions = events.filter((event) => event.type === 'transaction');
      expect(transactions).toHaveLength(Number(sampled));
      if (sampled === '1') {
        expect(transactions[0]?.contexts?.trace?.parent_span_id).toBe(PARENT);
      }
    },
  );

  it('uses valid Sentry precedence on conflicting IDs and ignores malformed context', async () => {
    const worker = Sentry.withSentry(
      () => ({
        dsn: 'https://public@example.test/1',
        tracesSampleRate: 1,
        skipOpenTelemetrySetup: true,
        transport: () => ({
          send: async () => ({ statusCode: 200 }),
          flush: async () => true,
        }),
      }),
      {
        async fetch(_request: Request, _env: object, _ctx: ExecutionContext) {
          await Promise.resolve();
          return Response.json(Sentry.getActiveSpan()!.spanContext());
        },
      },
    );
    for (const [headers, expected] of [
      [
        { 'sentry-trace': `${TRACE_A}-${PARENT}-1`, traceparent: `00-${TRACE_B}-${PARENT}-01` },
        TRACE_A,
      ],
      [
        {
          'sentry-trace': `${'0'.repeat(32)}-${PARENT}-1`,
          traceparent: `ff-${TRACE_B}-${PARENT}-01`,
        },
        undefined,
      ],
    ] as const) {
      const ctx = createExecutionContext();
      const incoming = new Request('https://gateway.trace-flow.dev/test', { headers });
      const response = await worker.fetch(normalizeTraceRequest(incoming), {}, ctx);
      const context = await response.json<{ traceId: string }>();
      await waitOnExecutionContext(ctx);
      if (expected) expect(context.traceId).toBe(expected);
      else {
        expect(context.traceId).not.toBe('0'.repeat(32));
        expect(context.traceId).not.toBe(TRACE_B);
      }
    }
  });
});
