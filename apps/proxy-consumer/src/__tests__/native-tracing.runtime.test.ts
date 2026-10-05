import * as Sentry from '@sentry/cloudflare';
import { tracing } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { withNativeTrace } from '@trace-flow/utils/native-tracing';

describe('native tracing with the pinned workerd runtime', () => {
  it('keeps concurrent SDK continuations intact inside distinct native child spans', async () => {
    const attributes: Record<string, string | number | boolean>[] = [];
    const traceIds = ['1'.repeat(32), '2'.repeat(32)];
    const nativeTracing = {
      ...tracing,
      enterSpan: <T>(name: string, callback: (span: Span) => T): T =>
        tracing.enterSpan(name, (nativeSpan) => {
          const recorded: Record<string, string | number | boolean> = {};
          attributes.push(recorded);
          return callback({
            get isTraced() {
              return nativeSpan.isTraced;
            },
            end: () => nativeSpan.end(),
            setAttribute: (key, value) => {
              if (value !== undefined) recorded[key] = value;
              nativeSpan.setAttribute(key, value);
            },
          });
        }),
    } as ExecutionContext['tracing'];
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
          const contexts = await Promise.all(
            traceIds.map((traceId) =>
              Sentry.continueTrace(
                { sentryTrace: `${traceId}-${'3'.repeat(16)}-1`, baggage: undefined },
                () =>
                  Sentry.startSpan({ name: 'process delivery' }, () =>
                    withNativeTrace(
                      nativeTracing,
                      'process delivery',
                      async () => {
                        await Promise.resolve();
                        return Sentry.getActiveSpan()!.spanContext();
                      },
                      { deliveryId: `delivery-${traceId}` },
                    ),
                  ),
              ),
            ),
          );
          return Response.json(contexts);
        },
      },
    );
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('https://example.test'), {}, ctx);
    const contexts = await response.json<{ traceId: string; spanId: string }[]>();
    await waitOnExecutionContext(ctx);
    expect(contexts.map((context) => context.traceId)).toEqual(traceIds);
    expect(attributes).toHaveLength(2);
    for (const context of contexts) {
      expect(attributes.find((item) => item['sentry.trace_id'] === context.traceId)).toEqual({
        'sentry.trace_id': context.traceId,
        'sentry.span_id': context.spanId,
        'trace_flow.delivery_id': `delivery-${context.traceId}`,
      });
    }
  });
});
