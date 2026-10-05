import { afterEach, describe, expect, it, vi } from 'vitest';
import { withNativeTrace } from './native-tracing';

const { getActiveSpan } = vi.hoisted(() => ({ getActiveSpan: vi.fn() }));
vi.mock('@sentry/cloudflare', () => ({ getActiveSpan }));

function nativeTracing() {
  const attributes: Record<string, string | number | boolean> = {};
  const span = {
    isTraced: true,
    end: vi.fn(),
    setAttribute: (key: string, value?: string | number | boolean) => {
      if (value !== undefined) attributes[key] = value;
    },
  };
  function enterSpan<T, A extends unknown[]>(
    _name: string,
    callback: (nativeSpan: Span, ...args: A) => T,
    ...args: A
  ): T {
    return callback(span, ...args);
  }
  return { attributes, tracing: { enterSpan } };
}

afterEach(() => vi.resetAllMocks());

describe('native trace correlation', () => {
  it('maps the active SDK IDs and operational keys without changing callback results', () => {
    const native = nativeTracing();
    getActiveSpan.mockReturnValue({
      spanContext: () => ({ traceId: '1'.repeat(32), spanId: '2'.repeat(16) }),
    });
    const result = withNativeTrace(native.tracing, 'process delivery', () => 42, {
      requestId: 'request-1',
      deliveryId: 'delivery-1',
    });
    expect(result).toBe(42);
    expect(native.attributes).toEqual({
      'sentry.trace_id': '1'.repeat(32),
      'sentry.span_id': '2'.repeat(16),
      'trace_flow.request_id': 'request-1',
      'trace_flow.delivery_id': 'delivery-1',
    });
  });

  it('does not invent SDK identity when there is no active SDK span', () => {
    const native = nativeTracing();
    getActiveSpan.mockReturnValue(undefined);
    withNativeTrace(native.tracing, 'native only', () => undefined);
    expect(native.attributes).toEqual({});
  });

  it('preserves rejection and promise lifetime for native enterSpan', async () => {
    const native = nativeTracing();
    const error = new Error('delivery failed');
    const pending = Promise.reject(error);
    const result = withNativeTrace(native.tracing, 'delivery', () => pending);
    expect(result).toBe(pending);
    await expect(result).rejects.toBe(error);
  });
});
