import { getActiveSpan } from '@sentry/cloudflare';

interface NativeTraceKeys {
  requestId?: string;
  deliveryId?: string;
}

/**
 * Native Cloudflare and Sentry SDK spans have independent IDs. A child native span records the
 * active SDK context so mixed-producer queue batches never overwrite one invocation's identity.
 */
export function withNativeTrace<T>(
  tracing: Pick<ExecutionContext['tracing'], 'enterSpan'>,
  name: string,
  callback: () => T,
  keys: NativeTraceKeys = {},
): T {
  return tracing.enterSpan(name, (span) => {
    const context = getActiveSpan()?.spanContext();
    if (context) {
      span.setAttribute('sentry.trace_id', context.traceId);
      span.setAttribute('sentry.span_id', context.spanId);
    }
    span.setAttribute('trace_flow.request_id', keys.requestId);
    span.setAttribute('trace_flow.delivery_id', keys.deliveryId);
    return callback();
  });
}
